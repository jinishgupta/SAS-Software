// INTEGRATION / SYSTEM test: UI-less end-to-end walk through a whole trading day with all three roles,
// exercising route -> service -> database together (no mocks), then checking cross-module consistency.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

describe('integration: a full trading day', () => {
  let t;
  before(async () => { await h.start(); h.reset(); t = await h.tokens(); });
  after(() => h.cleanup());

  it('login returns a token and user without leaking the password', async () => {
    const r = await h.call('POST', '/login', null, { username: 'manager', password: 'manager123' });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.data.user).sort(), ['id', 'name', 'role']);
    assert.ok(!r.text.includes('manager123'));
  });

  it('runs stock-in, sales, a cancellation, a price change and reporting, and the books balance', async () => {
    const today = h.localToday();

    // Stock employee receives 20 more milk
    assert.equal((await h.call('POST', '/inventory/supply', t.stock, { code: '2001', qty: 20, supplyDate: today })).status, 200);

    // Sale 1 at the old price
    const s1 = await h.sale(t.clerk, [['1001', 2], ['2001', 3]]);
    assert.equal(s1.bill.totalAmount, 426);

    // A sale that is cancelled halfway
    const c = await h.sale(t.clerk, [['2002', 5]], 'open');
    assert.equal((await h.call('POST', `/transactions/${c.id}/cancel`, t.clerk)).status, 200);

    // Manager raises the price of milk to 70
    await h.call('PUT', '/items/2001/price', t.manager, { price: 70 });

    // Sale 2 (new price), with an item removed before checkout
    const open = (await h.call('POST', '/transactions', t.clerk)).data.id;
    const line = (await h.call('POST', `/transactions/${open}/items`, t.clerk, { code: '2003', qty: 2 })).data.items[0].id;
    await h.call('POST', `/transactions/${open}/items`, t.clerk, { code: '2001', qty: 2 });
    await h.call('DELETE', `/transactions/${open}/items/${line}`, t.clerk);
    const bill2 = (await h.call('POST', `/transactions/${open}/checkout`, t.clerk)).data;
    assert.equal(bill2.totalAmount, 140);
    await h.call('POST', `/transactions/${open}/pay`, t.clerk);

    // Inventory: milk 80 + 20 - 3 - 2 = 95 ; rice 198 ; bread untouched (cancelled) ; butter untouched (removed)
    const inv = Object.fromEntries((await h.call('GET', '/inventory', t.manager)).data.map((i) => [i.code, i.qty_in_stock]));
    assert.deepEqual([inv['2001'], inv['1001'], inv['2002'], inv['2003']], [95, 198, 50, 45]);

    // Report for today: milk 5 sold; revenue 3x62 + 2x70 = 326; profit 326 - 5x54 = 56
    const rep = (await h.call('GET', `/reports/sales?code=all&from=${today}&to=${today}`, t.manager)).data;
    const milk = rep.stats.find((s) => s.itemCode === '2001');
    assert.deepEqual([milk.quantitySold, milk.revenueRealized, milk.profit], [5, 326, 56]);
    assert.equal(rep.totals.revenueRealized, 240 + 326);

    // Cross-check: report revenue == sum of bill totals of completed sales
    const billed = h.db.prepare("SELECT SUM(total) s FROM transactions WHERE status IN ('bill_printed','completed')").get().s;
    assert.equal(rep.totals.revenueRealized, billed);
  });

  it('logout invalidates the token', async () => {
    const tok = await h.login('clerk');
    assert.equal((await h.call('GET', '/items', tok)).status, 200);
    await h.call('POST', '/logout', tok);
    assert.equal((await h.call('GET', '/items', tok)).status, 401);
  });
});
