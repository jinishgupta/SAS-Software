// BLACK-BOX tests via the public REST API only (no knowledge of the code).
// Techniques: EQUIVALENCE PARTITIONING (EP) and BOUNDARY VALUE ANALYSIS (BVA) on every input field.
//
// Specification used (from the problem statement + design decisions):
//   - count items: quantity is a whole number >= 1
//   - weight items: weight is a multiple of 0.01 kg (scale resolution), >= 0.01
//   - quantity may not exceed the stock in the inventory (cumulative for the transaction)
//   - prices / supply quantities: 0 < value <= 100000
//   - dates: valid calendar date; reports need from <= to
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

describe('black box: equivalence classes and boundary values', () => {
  let t;
  before(async () => { await h.start(); });
  beforeEach(async () => { h.reset(); t = await h.tokens(); });
  after(() => h.cleanup());

  const newTxn = async () => (await h.call('POST', '/transactions', t.clerk)).data.id;

  describe('add item: quantity of a COUNT item (2001 Milk, stock 80)', () => {
    // [partition / boundary, value, expected HTTP status]
    const cases = [
      ['invalid: zero (lower boundary - 1)', 0, 400],
      ['invalid: negative', -1, 400],
      ['invalid: fraction', 0.5, 400],
      ['valid: minimum (lower boundary)', 1, 200],
      ['valid: nominal', 2, 200],
      ['valid: upper boundary = stock', 80, 200],
      ['invalid: upper boundary + 1 (exceeds stock)', 81, 409],
      ['invalid: far above stock', 1e308, 409],
      ['valid: numeric string', '3', 200],
      ['invalid: non-numeric string', 'abc', 400],
      ['invalid: empty string', '', 400],
      ['invalid: null', null, 400],
      ['invalid: boolean', true, 400],
      ['invalid: array', [1], 400],
      ['invalid: object', {}, 400],
      ['invalid: "Infinity"', 'Infinity', 400],
    ];
    for (const [label, qty, status] of cases) {
      it(`${label}: ${JSON.stringify(qty)} -> ${status}`, async () => {
        const id = await newTxn();
        const r = await h.call('POST', `/transactions/${id}/items`, t.clerk, { code: '2001', qty });
        assert.equal(r.status, status, JSON.stringify(r.data));
        if (status !== 200) assert.match(r.data.error, /\w/, 'an error message must be returned');
      });
    }
    it('missing qty field -> 400', async () => {
      const r = await h.call('POST', `/transactions/${await newTxn()}/items`, t.clerk, { code: '2001' });
      assert.equal(r.status, 400);
    });
  });

  describe('add item: weight of a WEIGHT item (1001 Rice, stock 200 kg)', () => {
    const cases = [
      ['invalid: zero', 0, 400],
      ['invalid: negative', -0.5, 400],
      ['invalid: below scale resolution 0.001', 0.001, 400],
      ['invalid: 0.009', 0.009, 400],
      ['valid: minimum 0.01', 0.01, 200],
      ['valid: 1.25', 1.25, 200],
      ['valid: float-tricky 0.29', 0.29, 200],
      ['invalid: three decimals 1.255', 1.255, 400],
      ['valid: whole number', 3, 200],
      ['valid: upper boundary = stock', 200, 200],
      ['invalid: stock + 0.01', 200.01, 409],
    ];
    for (const [label, qty, status] of cases) {
      it(`${label}: ${qty} -> ${status}`, async () => {
        const id = await newTxn();
        const r = await h.call('POST', `/transactions/${id}/items`, t.clerk, { code: '1001', qty });
        assert.equal(r.status, status, JSON.stringify(r.data));
      });
    }
    it('a tiny weight can never produce a free item (amount must be > 0)', async () => {
      const id = await newTxn();
      const r = await h.call('POST', `/transactions/${id}/items`, t.clerk, { code: '1004', qty: 0.0001 });
      assert.equal(r.status, 400);
    });
  });

  describe('add item: item code', () => {
    for (const [label, code, status] of [
      ['existing', '2001', 200], ['unknown', '9999', 404], ['empty', '', 404], ['null', null, 404],
      ['number instead of string', 2001, 200], ['leading/trailing spaces', ' 2001 ', 404], ['very long', 'x'.repeat(500), 404],
    ]) {
      it(`${label} -> ${status}`, async () => {
        const r = await h.call('POST', `/transactions/${await newTxn()}/items`, t.clerk, { code, qty: 1 });
        assert.equal(r.status, status);
      });
    }
  });

  describe('change price (manager)', () => {
    const cases = [
      ['invalid: zero', 0, 400], ['invalid: negative', -1, 400],
      ['valid: minimum 0.01', 0.01, 200], ['valid: nominal', 62.5, 200], ['valid: numeric string', '55', 200],
      ['valid: upper boundary 100000', 100000, 200], ['invalid: upper boundary + 0.01', 100000.01, 400],
      ['invalid: non-numeric', 'abc', 400], ['invalid: empty string', '', 400], ['invalid: null', null, 400],
      ['invalid: boolean', true, 400], ['invalid: array', [5], 400], ['invalid: "Infinity"', 'Infinity', 400],
    ];
    for (const [label, price, status] of cases) {
      it(`${label}: ${JSON.stringify(price)} -> ${status}`, async () => {
        const r = await h.call('PUT', '/items/2001/price', t.manager, { price });
        assert.equal(r.status, status, JSON.stringify(r.data));
      });
    }
    it('unknown item -> 404', async () => assert.equal((await h.call('PUT', '/items/9999/price', t.manager, { price: 5 })).status, 404));
    it('a rejected price leaves the old price in force', async () => {
      await h.call('PUT', '/items/2001/price', t.manager, { price: -3 });
      const inv = (await h.call('GET', '/inventory?q=2001', t.manager)).data;
      assert.equal(inv[0].unit_price, 62);
    });
  });

  describe('receive stock (stock employee)', () => {
    const post = (body) => h.call('POST', '/inventory/supply', t.stock, body);
    const day = '2026-09-29';
    const cases = [
      ['count item: 0', { code: '2001', qty: 0 }, 400], ['count item: -1', { code: '2001', qty: -1 }, 400],
      ['count item: 0.5', { code: '2001', qty: 0.5 }, 400], ['count item: 1 (minimum)', { code: '2001', qty: 1 }, 200],
      ['weight item: 0.01 (minimum)', { code: '1001', qty: 0.01 }, 200], ['weight item: 2.5', { code: '1001', qty: 2.5 }, 200],
      ['max 100000', { code: '2001', qty: 100000 }, 200], ['max + 0.01', { code: '1001', qty: 100000.01 }, 400],
      ['non-numeric qty', { code: '2001', qty: 'many' }, 400], ['missing qty', { code: '2001' }, 400],
      ['unknown code', { code: '9999', qty: 5 }, 404], ['missing code', { qty: 5 }, 404],
    ];
    for (const [label, body, status] of cases) {
      it(`${label} -> ${status}`, async () => assert.equal((await post({ supplyDate: day, ...body })).status, status));
    }
    for (const [label, supplyDate, status] of [
      ['valid ISO date', '2026-09-29', 200], ['missing date', undefined, 400], ['empty date', '', 400],
      ['garbage date', 'yesterday-ish', 400], ['impossible month/day', '2026-13-45', 400],
    ]) {
      it(`date: ${label} -> ${status}`, async () => assert.equal((await post({ code: '2001', qty: 5, supplyDate })).status, status));
    }
    it('successful supply increases stock by exactly the quantity and confirms', async () => {
      const r = await post({ code: '2001', qty: 20, supplyDate: day });
      assert.equal(r.data.message, 'Inventory updated successfully');
      assert.equal(r.data.item.qty_in_stock, 100);
    });
  });

  describe('sales statistics query', () => {
    const q = (code, from, to) => h.call('GET', `/reports/sales?code=${code}&from=${from}&to=${to}`, t.manager);
    for (const [label, from, to, status] of [
      ['same day (from == to)', '2026-03-10', '2026-03-10', 200], ['normal range', '2026-03-01', '2026-03-31', 200],
      ['from after to (boundary + 1 day)', '2026-03-11', '2026-03-10', 400], ['leap day', '2024-02-29', '2024-02-29', 200],
      ['missing from', '', '2026-03-10', 400], ['missing to', '2026-03-10', '', 400], ['garbage dates', 'abc', 'def', 400],
    ]) {
      it(`${label} -> ${status}`, async () => assert.equal((await q('all', from, to)).status, status));
    }
    it('unknown item code gives an empty report, not an error', async () => {
      const r = await q('9999', '2026-03-01', '2026-03-31');
      assert.equal(r.status, 200);
      assert.deepEqual(r.data.stats, []);
    });
    it('code omitted defaults to all items', async () => {
      await h.sale(t.clerk, [['2001', 1]]);
      const r = await h.call('GET', `/reports/sales?from=${h.localToday()}&to=${h.localToday()}`, t.manager);
      assert.equal(r.data.stats.length, 1);
    });
  });

  describe('login', () => {
    for (const [label, body, status] of [
      ['valid credentials', { username: 'clerk', password: 'clerk123' }, 200],
      ['wrong password', { username: 'clerk', password: 'nope' }, 401],
      ['unknown user', { username: 'ghost', password: 'x' }, 401],
      ['empty strings', { username: '', password: '' }, 401],
      ['missing fields', {}, 401],
      ['case-sensitive username', { username: 'CLERK', password: 'clerk123' }, 401],
      ['object instead of string (NoSQL-style)', { username: { $ne: 1 }, password: { $ne: 1 } }, 401],
      ['numbers instead of strings', { username: 1, password: 2 }, 401],
    ]) {
      it(`${label} -> ${status}`, async () => assert.equal((await h.call('POST', '/login', null, body)).status, status));
    }
  });

  describe('inventory search (manager)', () => {
    for (const [label, q, expectCodes] of [
      ['exact code', '1001', ['1001']], ['name fragment', 'milk', ['2001']], ['upper-case fragment', 'MILK', ['2001']],
      ['no match', 'zzzz', []], ['empty query returns everything', '', null],
    ]) {
      it(`${label}`, async () => {
        const r = await h.call('GET', `/inventory?q=${encodeURIComponent(q)}`, t.manager);
        assert.equal(r.status, 200);
        if (expectCodes) assert.deepEqual(r.data.map((i) => i.code), expectCodes);
        else assert.equal(r.data.length, 10);
      });
    }
  });
});
