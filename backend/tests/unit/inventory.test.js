// WHITE-BOX unit tests: services/inventory.js
// Technique: statement + branch (decision) coverage. Every `if` in the module has a test that takes the
// true branch and one that takes the false branch. Test names mention the branch they exercise.
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const inv = require('../../services/inventory');

describe('inventory service (white box)', () => {
  beforeEach(() => h.reset());
  after(() => h.cleanup());

  const throwsHttp = (fn, status, re) => assert.throws(fn, (e) => e instanceof inv.HttpError && e.status === status && (!re || re.test(e.message)));

  describe('findItem / getItemOrFail', () => {
    it('finds an existing item (branch: item found)', () => {
      assert.equal(inv.getItemOrFail('1001').name, 'Basmati Rice');
    });
    it('coerces a numeric code to string', () => {
      assert.equal(inv.findItem(1001).code, '1001');
    });
    it('throws 404 for an unknown code (branch: item missing)', () => {
      throwsHttp(() => inv.getItemOrFail('9999'), 404, /not found/);
      assert.equal(inv.findItem('9999'), undefined);
    });
  });

  describe('queryInventory', () => {
    it('returns all items sorted by code when no query (branch: !q)', () => {
      const all = inv.queryInventory();
      assert.equal(all.length, 10);
      assert.deepEqual(all.map((i) => i.code), [...all.map((i) => i.code)].sort());
    });
    it('matches exact code (branch: q given)', () => {
      assert.deepEqual(inv.queryInventory('1001').map((i) => i.code), ['1001']);
    });
    it('matches partial name case-insensitively', () => {
      assert.deepEqual(inv.queryInventory('RICE').map((i) => i.code), ['1001']);
    });
    it('returns an empty list when nothing matches', () => {
      assert.deepEqual(inv.queryInventory('zzz-none'), []);
    });
  });

  describe('decreaseStock', () => {
    it('reduces stock (branch: enough stock)', () => {
      inv.decreaseStock('2001', 5);
      assert.equal(h.stockOf('2001'), 75);
    });
    it('allows selling exactly the remaining stock (boundary qty == stock)', () => {
      inv.decreaseStock('2001', 80);
      assert.equal(h.stockOf('2001'), 0);
    });
    it('rejects selling more than stock with 409 and leaves stock unchanged (branch: insufficient)', () => {
      throwsHttp(() => inv.decreaseStock('2001', 80.01), 409, /Insufficient stock/);
      assert.equal(h.stockOf('2001'), 80);
    });
    it('rejects an unknown item with 404', () => {
      throwsHttp(() => inv.decreaseStock('9999', 1), 404);
    });
  });

  describe('increaseStock', () => {
    const ok = (code, qty, date = '2026-09-29') => inv.increaseStock(code, qty, date, 2);

    it('adds stock, logs the supply and returns the confirmation (happy path)', () => {
      const r = ok('2001', 20);
      assert.equal(r.message, 'Inventory updated successfully');
      assert.equal(r.item.qty_in_stock, 100);
      const row = h.db.prepare('SELECT * FROM supplies').get();
      assert.deepEqual([row.item_code, row.qty, row.supply_date, row.employee_id], ['2001', 20, '2026-09-29', 2]);
    });
    it('rejects an unknown item code (validateItemCode fails)', () => throwsHttp(() => ok('9999', 5), 404));
    for (const bad of [0, -1, NaN, Infinity, 'abc', '', undefined, null, true, [1], {}, 100000.01]) {
      it(`rejects invalid quantity ${JSON.stringify(bad) ?? String(bad)}`, () => throwsHttp(() => ok('2001', bad), 400));
    }
    it('accepts a numeric string quantity', () => assert.equal(ok('2001', '5').item.qty_in_stock, 85));
    it('rejects a missing or malformed supply date', () => {
      throwsHttp(() => inv.increaseStock('2001', 5, undefined, 2), 400, /date/);
      throwsHttp(() => inv.increaseStock('2001', 5, '', 2), 400, /date/);
      throwsHttp(() => inv.increaseStock('2001', 5, 'not-a-date', 2), 400, /date/);
    });
    it('rejects a fractional quantity for a count item', () => throwsHttp(() => ok('2001', 1.5), 400, /whole number/));
    it('accepts a fractional quantity for a weight item (branch: sold_by_weight)', () => assert.equal(ok('1001', 2.5).item.qty_in_stock, 202.5));
    it('does not change stock or log anything when validation fails', () => {
      assert.throws(() => ok('2001', -3));
      assert.equal(h.stockOf('2001'), 80);
      assert.equal(h.db.prepare('SELECT COUNT(*) c FROM supplies').get().c, 0);
    });
  });

  describe('updatePrice', () => {
    it('updates the price', () => assert.equal(inv.updatePrice('2001', 70).unit_price, 70));
    it('rounds to 2 decimals', () => assert.equal(inv.updatePrice('2001', 10.999).unit_price, 11));
    it('rejects unknown item (404)', () => throwsHttp(() => inv.updatePrice('9999', 5), 404));
    for (const bad of [0, -5, NaN, Infinity, 'abc', '', null, undefined, true, [5], 100000.01]) {
      it(`rejects invalid price ${JSON.stringify(bad) ?? String(bad)}`, () => {
        throwsHttp(() => inv.updatePrice('2001', bad), 400);
        assert.equal(inv.findItem('2001').unit_price, 62);
      });
    }
    it('accepts the upper boundary 100000', () => assert.equal(inv.updatePrice('2001', 100000).unit_price, 100000));
  });

  describe('recentSupplies', () => {
    it('returns newest first and honours the limit', () => {
      inv.increaseStock('2001', 1, '2026-01-01', 2);
      inv.increaseStock('2002', 2, '2026-01-02', 2);
      inv.increaseStock('2003', 3, '2026-01-03', 2);
      const r = inv.recentSupplies(2);
      assert.deepEqual(r.map((s) => s.item_code), ['2003', '2002']);
      assert.equal(r[0].employee, 'Sanjay Stock');
    });
  });
});
