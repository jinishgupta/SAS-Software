// WHITE-BOX: BASIS PATH testing of SalesTransaction.addLineItem (services/transaction.js).
//
// Decisions on the control-flow graph of addLineItem, with the helper validators it calls counted inline:
//   D1  status is 'initiated' or 'adding_items'?        (else 400)
//   D2  item exists? (getItemOrFail)                    (else 404)
//   D3  quantity is a positive finite number? (positiveNumber)          (else 400)
//   D4a count item: quantity is a whole number? (checkUnitFit)          (else 400)
//   D4b weight item: at most 2 decimals? (checkUnitFit)                 (else 400)
//   D5  already-added + qty <= stock?                   (else 409)
//   D6  computed amount > 0?                            (else 400)
//   -> insert line, status = adding_items, return view
//
// Cyclomatic complexity V(G) = decisions + 1 = 7 + 1 = 8, so 8 linearly independent paths are needed:
// P0 (all decisions pass) plus one path for each decision failing (P1, P2, P3, P4a, P4b, P5, P6).
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const txn = require('../../services/transaction');
const { HttpError } = require('../../services/inventory');

const CLERK = 1;

describe('white box: basis paths of addLineItem, V(G) = 8', () => {
  beforeEach(() => h.reset());
  after(() => h.cleanup());

  const throwsHttp = (fn, status, re) => assert.throws(fn, (e) => e instanceof HttpError && e.status === status && (!re || re.test(e.message)));
  const open = () => txn.start(CLERK).id;

  it('P0 (success): D1 T, D2 T, D3 T, D4 T, D5 T, D6 T -> line added, status adding_items', () => {
    const v = txn.addLineItem(open(), CLERK, '1001', 1.25);
    assert.equal(v.status, 'adding_items');
    assert.equal(v.items[0].amount, 150);
  });
  it('P1: D1 false -> 400 (transaction not open)', () => {
    const id = open();
    txn.cancel(id, CLERK);
    throwsHttp(() => txn.addLineItem(id, CLERK, '2001', 1), 400, /Cannot add items/);
  });
  it('P2: D1 T, D2 false -> 404 (unknown item)', () => throwsHttp(() => txn.addLineItem(open(), CLERK, '9999', 1), 404));
  it('P3: D3 false -> 400 (quantity not positive)', () => throwsHttp(() => txn.addLineItem(open(), CLERK, '2001', 0), 400, /greater than 0/));
  it('P4a: D4 false (count item, fraction) -> 400', () => throwsHttp(() => txn.addLineItem(open(), CLERK, '2001', 1.5), 400, /whole number/));
  it('P4b: D4 false (weight item, 3 decimals) -> 400', () => throwsHttp(() => txn.addLineItem(open(), CLERK, '1001', 1.255), 400, /2 decimal/));
  it('P5: D5 false -> 409 (exceeds stock)', () => throwsHttp(() => txn.addLineItem(open(), CLERK, '2001', 81), 409, /in stock/));
  it('P6: D6 false -> 400 (amount rounds to zero)', () => {
    h.db.prepare("UPDATE items SET unit_price = 0.01 WHERE code = '1001'").run();
    throwsHttp(() => txn.addLineItem(open(), CLERK, '1001', 0.01), 400, /too small/);
  });
  it('every rejected path leaves the database unchanged', () => {
    const id = open();
    for (const [c, q] of [['9999', 1], ['2001', 0], ['2001', 1.5], ['2001', 81]]) assert.throws(() => txn.addLineItem(id, CLERK, c, q));
    assert.equal(h.db.prepare('SELECT COUNT(*) c FROM line_items').get().c, 0);
    assert.equal(h.statusOf(id), 'initiated');
  });
});
