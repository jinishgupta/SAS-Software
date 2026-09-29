// ACCEPTANCE / USE-CASE testing: one scenario per requirement of the problem statement (R1..R10),
// written from the user's point of view. See the traceability matrix in TESTING.md.
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

describe('acceptance: requirements from the problem statement', () => {
  let t;
  before(async () => { await h.start(); });
  beforeEach(async () => { h.reset(); t = await h.tokens(); });
  after(() => h.cleanup());

  it('R1 scanning a barcode returns the item code, name and unit price', async () => {
    const r = await h.call('GET', '/items/1001', t.clerk);
    assert.equal(r.status, 200);
    assert.deepEqual([r.data.code, r.data.name, r.data.unit_price], ['1001', 'Basmati Rice', 120]);
  });

  it('R2 weight items are priced by weight, count items by count (qty x unit price)', async () => {
    const id = (await h.call('POST', '/transactions', t.clerk)).data.id;
    await h.call('POST', `/transactions/${id}/items`, t.clerk, { code: '1001', qty: 1.75 }); // 1.75 kg x 120 = 210
    const v = (await h.call('POST', `/transactions/${id}/items`, t.clerk, { code: '2001', qty: 4 })).data; // 4 x 62 = 248
    assert.deepEqual(v.items.map((l) => l.amount), [210, 248]);
    assert.equal(v.runningTotal, 458);
  });

  it('R3 the bill has serial number, item name, code, quantity, unit price, item price and total payable', async () => {
    const { bill } = await h.sale(t.clerk, [['1001', 2], ['2001', 3]], 'billed');
    assert.match(bill.billNo, /^\d{6}$/, 'serial number');
    assert.equal(typeof bill.transactionId, 'number', 'transaction id');
    assert.equal(bill.items.length, 2);
    for (const line of bill.items) {
      for (const field of ['name', 'code', 'quantity', 'unitPrice', 'itemPrice']) assert.ok(line[field] !== undefined, `line has ${field}`);
    }
    assert.deepEqual(bill.items[0], { code: '1001', name: 'Basmati Rice', quantity: 2, unit: 'kg', unitPrice: 120, itemPrice: 240 });
    assert.equal(bill.totalAmount, 426);
  });

  it('R4 the total on the bill equals the sum of the item prices', async () => {
    const { bill } = await h.sale(t.clerk, [['1002', 2.35], ['1004', 0.5], ['2003', 7], ['2005', 1]], 'billed');
    const sum = bill.items.reduce((s, l) => s + l.itemPrice, 0);
    assert.equal(Math.round(sum * 100) / 100, bill.totalAmount);
  });

  it('R5 bills get unique, increasing serial numbers', async () => {
    const a = (await h.sale(t.clerk, [['2001', 1]], 'billed')).bill.billNo;
    const b = (await h.sale(t.clerk, [['2001', 1]], 'billed')).bill.billNo;
    assert.ok(Number(b) > Number(a));
  });

  it('R6 inventory decreases whenever an item is sold', async () => {
    await h.sale(t.clerk, [['1001', 2.5], ['2001', 3]]);
    assert.equal(h.stockOf('1001'), 197.5);
    assert.equal(h.stockOf('2001'), 77);
  });

  it('R6b a cancelled sale does not decrease the inventory', async () => {
    const { id } = await h.sale(t.clerk, [['2001', 10]], 'open');
    await h.call('POST', `/transactions/${id}/cancel`, t.clerk);
    assert.equal(h.stockOf('2001'), 80);
  });

  it('R7 the manager can see inventory details on demand (all items, or one)', async () => {
    const all = (await h.call('GET', '/inventory', t.manager)).data;
    assert.equal(all.length, 10);
    for (const f of ['code', 'name', 'unit_price', 'cost_price', 'qty_in_stock']) assert.ok(f in all[0]);
    const one = (await h.call('GET', '/inventory?q=2002', t.manager)).data;
    assert.deepEqual([one.length, one[0].qty_in_stock], [1, 50]);
  });

  it('R7b the inventory shown reflects a sale immediately', async () => {
    await h.sale(t.clerk, [['2002', 5]]);
    assert.equal((await h.call('GET', '/inventory?q=2002', t.manager)).data[0].qty_in_stock, 45);
  });

  it('R8 an employee can update the inventory when new supply arrives', async () => {
    const r = await h.call('POST', '/inventory/supply', t.stock, { code: '2002', qty: 25, supplyDate: '2026-09-29' });
    assert.equal(r.status, 200);
    assert.equal(r.data.message, 'Inventory updated successfully');
    assert.equal((await h.call('GET', '/inventory?q=2002', t.manager)).data[0].qty_in_stock, 75);
    const recent = (await h.call('GET', '/inventory/supplies', t.stock)).data;
    assert.deepEqual([recent[0].item_code, recent[0].qty, recent[0].supply_date], ['2002', 25, '2026-09-29']);
  });

  it('R9 sales statistics per item for a particular day and for a period: quantity, price realized, profit', async () => {
    // day 1: 2 kg rice + 3 milk; day 2: 1.5 kg rice
    const a = (await h.sale(t.clerk, [['1001', 2], ['2001', 3]])).id;
    const b = (await h.sale(t.clerk, [['1001', 1.5]])).id;
    h.backdate(a, '2026-04-01');
    h.backdate(b, '2026-04-02');
    const rep = async (code, from, to) => (await h.call('GET', `/reports/sales?code=${code}&from=${from}&to=${to}`, t.manager)).data;

    const day1 = await rep('all', '2026-04-01', '2026-04-01');
    assert.deepEqual(day1.stats.map((s) => [s.itemCode, s.quantitySold, s.revenueRealized, s.profit]), [['1001', 2, 240, 50], ['2001', 3, 186, 24]]);

    const period = await rep('1001', '2026-04-01', '2026-04-02');
    assert.deepEqual([period.stats[0].quantitySold, period.stats[0].revenueRealized, period.stats[0].profit], [3.5, 420, 87.5]);
    assert.deepEqual(period.totals, { revenueRealized: 420, profit: 87.5 });
  });

  it('R10 the manager can change the selling price; new sales use it, old bills keep the old price', async () => {
    const old = (await h.sale(t.clerk, [['2001', 1]], 'billed')).bill;
    const r = await h.call('PUT', '/items/2001/price', t.manager, { price: 70 });
    assert.equal(r.data.unit_price, 70);
    const fresh = (await h.sale(t.clerk, [['2001', 1]], 'billed')).bill;
    assert.equal(fresh.items[0].unitPrice, 70);
    assert.equal(fresh.totalAmount, 70);
    assert.equal(old.items[0].unitPrice, 62);
    assert.equal(old.totalAmount, 62);
  });

  it('R10b price changes are reflected in the profit of later sales only', async () => {
    await h.sale(t.clerk, [['2001', 1]]);                       // 62 - 54 = 8
    await h.call('PUT', '/items/2001/price', t.manager, { price: 70 });
    await h.sale(t.clerk, [['2001', 1]]);                       // 70 - 54 = 16
    const rep = (await h.call('GET', `/reports/sales?code=2001&from=${h.localToday()}&to=${h.localToday()}`, t.manager)).data;
    assert.deepEqual([rep.stats[0].revenueRealized, rep.stats[0].profit], [132, 24]);
  });

  it('R11 payment: the customer pays after the bill is printed and the sale is completed', async () => {
    const { id } = await h.sale(t.clerk, [['2001', 1]], 'billed');
    const paid = await h.call('POST', `/transactions/${id}/pay`, t.clerk);
    assert.equal(paid.data.status, 'completed');
  });

  it('R12 the sales clerk cannot see profit / cost data reports, and a manager cannot ring up sales', async () => {
    assert.equal((await h.call('GET', `/reports/sales?code=all&from=2026-01-01&to=2026-12-31`, t.clerk)).status, 403);
    assert.equal((await h.call('POST', '/transactions', t.manager)).status, 403);
  });
});
