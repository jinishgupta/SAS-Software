// UNIT tests: services/transaction.js, each function tested in isolation against a real temporary database.
// Written with knowledge of the code (white box): every branch of every function is taken at least once.
// Basis-path tests for addLineItem live in tests/whitebox/basis-path.test.js.
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const txn = require('../../services/transaction');
const { HttpError } = require('../../services/inventory');

const CLERK = 1; // seeded clerk id

describe('transaction service (white box)', () => {
  beforeEach(() => h.reset());
  after(() => h.cleanup());

  const throwsHttp = (fn, status, re) => assert.throws(fn, (e) => e instanceof HttpError && e.status === status && (!re || re.test(e.message)));
  const open = () => txn.start(CLERK).id;

  describe('start / view / ownership', () => {
    it('start creates an "initiated" transaction with an empty bill', () => {
      const t = txn.start(CLERK);
      assert.equal(t.status, 'initiated');
      assert.deepEqual(t.items, []);
      assert.equal(t.runningTotal, 0);
    });
    it('view of an unknown transaction is 404', () => throwsHttp(() => txn.view(9999), 404));
    it('another clerk cannot modify a transaction (403)', () => {
      const id = open();
      throwsHttp(() => txn.addLineItem(id, 99, '2001', 1), 403);
      throwsHttp(() => txn.checkout(id, 99), 403);
      throwsHttp(() => txn.cancel(id, 99), 403);
      throwsHttp(() => txn.pay(id, 99), 403);
      throwsHttp(() => txn.removeLineItem(id, 99, 1), 403);
    });
  });

  describe('addLineItem: further branches', () => {
    it('stock check is cumulative across lines of the same item', () => {
      const id = open();
      txn.addLineItem(id, CLERK, '2001', 50);
      throwsHttp(() => txn.addLineItem(id, CLERK, '2001', 31), 409);
      assert.equal(txn.addLineItem(id, CLERK, '2001', 30).items.length, 2);
    });
    it('does not decrease stock when a line is added (only at checkout)', () => {
      txn.addLineItem(open(), CLERK, '2001', 10);
      assert.equal(h.stockOf('2001'), 80);
    });
    it('weight quantities that are exact 2-decimal values survive float error (0.29, 1.1)', () => {
      const id = open();
      txn.addLineItem(id, CLERK, '1001', 0.29);
      assert.equal(txn.addLineItem(id, CLERK, '1001', 1.1).items.length, 2);
    });
    it('selling exactly the last remaining unit is allowed', () => {
      h.db.prepare("UPDATE items SET qty_in_stock = 1 WHERE code = '2001'").run();
      assert.equal(txn.addLineItem(open(), CLERK, '2001', 1).runningTotal, 62);
    });
  });

  describe('removeLineItem', () => {
    it('removing one of several keeps adding_items', () => {
      const id = open();
      txn.addLineItem(id, CLERK, '2001', 1);
      const v = txn.addLineItem(id, CLERK, '2002', 1);
      const r = txn.removeLineItem(id, CLERK, v.items[0].id);
      assert.equal(r.status, 'adding_items');
      assert.equal(r.items.length, 1);
    });
    it('removing the last line returns to initiated (branch: no lines left)', () => {
      const id = open();
      const v = txn.addLineItem(id, CLERK, '2001', 1);
      const r = txn.removeLineItem(id, CLERK, v.items[0].id);
      assert.equal(r.status, 'initiated');
      assert.equal(r.runningTotal, 0);
    });
    it('unknown line -> 404; line of another transaction -> 404', () => {
      const a = open(), b = open();
      const va = txn.addLineItem(a, CLERK, '2001', 1);
      throwsHttp(() => txn.removeLineItem(b, CLERK, 9999), 404);
      throwsHttp(() => txn.removeLineItem(b, CLERK, va.items[0].id), 404);
    });
    it('cannot remove after billing -> 400', () => {
      const id = open();
      const v = txn.addLineItem(id, CLERK, '2001', 1);
      txn.checkout(id, CLERK);
      throwsHttp(() => txn.removeLineItem(id, CLERK, v.items[0].id), 400);
    });
  });

  describe('checkout', () => {
    it('empty transaction -> 400 "Add at least one item first"', () => throwsHttp(() => txn.checkout(open(), CLERK), 400, /at least one item/));
    it('cancelled transaction -> 400 "Cannot finalize"', () => {
      const id = open();
      txn.cancel(id, CLERK);
      throwsHttp(() => txn.checkout(id, CLERK), 400, /Cannot finalize/);
    });
    it('happy path: total, bill, stock decreased, status bill_printed', () => {
      const id = open();
      txn.addLineItem(id, CLERK, '1001', 2);
      txn.addLineItem(id, CLERK, '2001', 3);
      const bill = txn.checkout(id, CLERK);
      assert.equal(bill.totalAmount, 426);
      assert.equal(bill.status, 'bill_printed');
      assert.equal(h.stockOf('1001'), 198);
      assert.equal(h.stockOf('2001'), 77);
      assert.equal(h.statusOf(id), 'bill_printed');
    });
    it('cannot be finalized twice', () => {
      const id = open();
      txn.addLineItem(id, CLERK, '2001', 1);
      txn.checkout(id, CLERK);
      throwsHttp(() => txn.checkout(id, CLERK), 400);
      assert.equal(h.stockOf('2001'), 79);
    });
    it('is atomic: if one item lacks stock at checkout nothing is changed (rollback)', () => {
      const id = open();
      txn.addLineItem(id, CLERK, '1001', 5);
      txn.addLineItem(id, CLERK, '2001', 10);
      h.db.prepare("UPDATE items SET qty_in_stock = 3 WHERE code = '2001'").run(); // stock sold elsewhere meanwhile
      throwsHttp(() => txn.checkout(id, CLERK), 409, /Insufficient stock/);
      assert.equal(h.stockOf('1001'), 200, 'first item must be rolled back');
      assert.equal(h.stockOf('2001'), 3);
      assert.equal(h.statusOf(id), 'adding_items');
      assert.equal(h.db.prepare('SELECT total FROM transactions WHERE id = ?').get(id).total, 0);
    });
    it('uses the price at the time the line was added, not at checkout', () => {
      const id = open();
      txn.addLineItem(id, CLERK, '2001', 2);
      h.db.prepare("UPDATE items SET unit_price = 100 WHERE code = '2001'").run();
      const bill = txn.checkout(id, CLERK);
      assert.equal(bill.items[0].unitPrice, 62);
      assert.equal(bill.totalAmount, 124);
    });
  });

  describe('generateBill / pay / cancel', () => {
    it('bill is not available before checkout -> 400', () => throwsHttp(() => txn.generateBill(open()), 400, /not available/));
    it('bill number is the zero-padded transaction id', () => {
      const id = open();
      txn.addLineItem(id, CLERK, '2001', 1);
      assert.equal(txn.checkout(id, CLERK).billNo, String(id).padStart(6, '0'));
    });
    it('pay before the bill is printed -> 400', () => {
      const id = open();
      txn.addLineItem(id, CLERK, '2001', 1);
      throwsHttp(() => txn.pay(id, CLERK), 400, /Bill must be printed/);
    });
    it('pay after checkout -> completed; paying twice -> 400', () => {
      const id = open();
      txn.addLineItem(id, CLERK, '2001', 1);
      txn.checkout(id, CLERK);
      assert.equal(txn.pay(id, CLERK).status, 'completed');
      throwsHttp(() => txn.pay(id, CLERK), 400);
    });
    it('cancel works while open and leaves stock untouched', () => {
      const id = open();
      txn.addLineItem(id, CLERK, '2001', 10);
      assert.equal(txn.cancel(id, CLERK).status, 'cancelled');
      assert.equal(h.stockOf('2001'), 80);
    });
    it('cancel after billing -> 400', () => {
      const id = open();
      txn.addLineItem(id, CLERK, '2001', 1);
      txn.checkout(id, CLERK);
      throwsHttp(() => txn.cancel(id, CLERK), 400, /Cannot cancel/);
    });
  });
});
