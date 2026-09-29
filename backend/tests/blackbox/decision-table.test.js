// BLACK-BOX: DECISION TABLE testing for "add item to the current sale".
//
// Conditions                      R1  R2  R3  R4  R5  R6
// C1 transaction is open           T   F   T   T   T   T
// C2 item code exists              T   -   F   T   T   T
// C3 quantity valid (>0, unit fit) T   -   -   F   T   T
// C4 enough stock                  T   -   -   -   F   T   (R5: C4 = F, R6 = second full-stock variant)
// Actions
//   line added (200)               X
//   reject "not open" (400)            X
//   reject "unknown item" (404)            X
//   reject "bad quantity" (400)                X
//   reject "insufficient stock" (409)              X
// (R6 re-checks R1 with quantity exactly equal to stock.)
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

describe('black box: decision table for adding an item', () => {
  let t;
  before(async () => { await h.start(); });
  beforeEach(async () => { h.reset(); t = await h.tokens(); });
  after(() => h.cleanup());

  const rules = [
    { rule: 'R1  open, item exists, qty valid, stock ok', open: true, code: '2001', qty: 2, expect: 200 },
    { rule: 'R2  transaction not open (cancelled)', open: false, code: '2001', qty: 2, expect: 400 },
    { rule: 'R2b transaction not open, even with unknown item (C1 dominates)', open: false, code: '9999', qty: 2, expect: 400 },
    { rule: 'R3  item does not exist', open: true, code: '9999', qty: 2, expect: 404 },
    { rule: 'R3b unknown item, invalid qty (C2 checked before C3)', open: true, code: '9999', qty: -1, expect: 404 },
    { rule: 'R4  quantity invalid', open: true, code: '2001', qty: 0, expect: 400 },
    { rule: 'R4b quantity invalid, also over stock (C3 checked before C4)', open: true, code: '2001', qty: -500, expect: 400 },
    { rule: 'R5  not enough stock', open: true, code: '2001', qty: 81, expect: 409 },
    { rule: 'R6  quantity exactly equals stock', open: true, code: '2001', qty: 80, expect: 200 },
  ];

  for (const r of rules) {
    it(r.rule, async () => {
      const id = (await h.call('POST', '/transactions', t.clerk)).data.id;
      if (!r.open) await h.call('POST', `/transactions/${id}/cancel`, t.clerk);
      const res = await h.call('POST', `/transactions/${id}/items`, t.clerk, { code: r.code, qty: r.qty });
      assert.equal(res.status, r.expect, JSON.stringify(res.data));
      if (r.expect === 200) assert.equal(res.data.items.length, 1);
      else assert.ok(res.data.error);
    });
  }

  it('a failed add never changes the running total', async () => {
    const id = (await h.call('POST', '/transactions', t.clerk)).data.id;
    await h.call('POST', `/transactions/${id}/items`, t.clerk, { code: '2001', qty: 1 });
    await h.call('POST', `/transactions/${id}/items`, t.clerk, { code: '2001', qty: 9999 });
    assert.equal((await h.call('GET', `/transactions/${id}`, t.clerk)).data.runningTotal, 62);
  });
});
