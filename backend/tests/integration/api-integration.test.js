// INTEGRATION tests: routes (auth + validation + error mapping) -> services -> SQLite, no mocks.
// Each test checks that what a request does to the API is really persisted in the right tables, and that
// modules written separately (transaction, inventory, report) agree about the shared data.
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

describe('integration: routes <-> services <-> database', () => {
  let t;
  before(async () => { await h.start(); });
  beforeEach(async () => { h.reset(); t = await h.tokens(); });
  after(() => h.cleanup());

  const row = (sql, ...args) => h.db.prepare(sql).get(...args);

  describe('sales flow persists to the database', () => {
    it('starting a sale stores a transaction owned by the logged-in clerk', async () => {
      const r = await h.call('POST', '/transactions', t.clerk);
      const stored = row('SELECT t.*, e.username FROM transactions t JOIN employees e ON e.id = t.clerk_id WHERE t.id = ?', r.data.id);
      assert.deepEqual([stored.status, stored.total, stored.username], ['initiated', 0, 'clerk']);
    });

    it('adding an item stores a line with the price AND cost snapshot from the items table', async () => {
      const id = (await h.call('POST', '/transactions', t.clerk)).data.id;
      await h.call('POST', `/transactions/${id}/items`, t.clerk, { code: '1001', qty: 1.5 });
      const line = row('SELECT * FROM line_items WHERE transaction_id = ?', id);
      assert.deepEqual([line.item_code, line.quantity, line.price_at_sale, line.cost_at_sale, line.amount], ['1001', 1.5, 120, 95, 180]);
    });

    it('checkout writes the total, decreases stock and moves the state in one go', async () => {
      const { id, bill } = await h.sale(t.clerk, [['1001', 2], ['2001', 3]], 'billed');
      const stored = row('SELECT * FROM transactions WHERE id = ?', id);
      assert.deepEqual([stored.status, stored.total], ['bill_printed', 426]);
      assert.equal(bill.totalAmount, stored.total);
      assert.deepEqual([h.stockOf('1001'), h.stockOf('2001')], [198, 77]);
    });

    it('the bill returned by the API matches the rows in line_items', async () => {
      const { id, bill } = await h.sale(t.clerk, [['1002', 2.35], ['2003', 4]], 'billed');
      const lines = h.db.prepare('SELECT item_code, quantity, price_at_sale, amount FROM line_items WHERE transaction_id = ? ORDER BY id').all(id);
      assert.deepEqual(bill.items.map((l) => [l.code, l.quantity, l.unitPrice, l.itemPrice]), lines.map((l) => [l.item_code, l.quantity, l.price_at_sale, l.amount]));
    });

    it('GET /transactions/:id returns the persisted running state', async () => {
      const { id } = await h.sale(t.clerk, [['2001', 2]], 'open');
      const v = (await h.call('GET', `/transactions/${id}`, t.clerk)).data;
      assert.deepEqual([v.status, v.items.length, v.runningTotal], ['adding_items', 1, 124]);
    });

    it('a failed checkout (stock sold elsewhere) returns 409 and changes nothing in the database', async () => {
      const { id } = await h.sale(t.clerk, [['1001', 5], ['2001', 10]], 'open');
      h.db.prepare("UPDATE items SET qty_in_stock = 3 WHERE code = '2001'").run();
      const r = await h.call('POST', `/transactions/${id}/checkout`, t.clerk);
      assert.equal(r.status, 409);
      assert.deepEqual([h.stockOf('1001'), h.stockOf('2001'), h.statusOf(id)], [200, 3, 'adding_items']);
      assert.equal(row('SELECT total FROM transactions WHERE id = ?', id).total, 0);
    });
  });

  describe('inventory and price changes persist and are visible to other modules', () => {
    it('supply writes a supplies row with the employee taken from the session, and updates items', async () => {
      await h.call('POST', '/inventory/supply', t.stock, { code: '2001', qty: 15, supplyDate: '2026-09-29' });
      const s = row('SELECT s.*, e.username FROM supplies s JOIN employees e ON e.id = s.employee_id');
      assert.deepEqual([s.item_code, s.qty, s.supply_date, s.username], ['2001', 15, '2026-09-29', 'stock']);
      assert.equal(h.stockOf('2001'), 95);
    });

    it('a rejected supply leaves both items and supplies untouched', async () => {
      await h.call('POST', '/inventory/supply', t.stock, { code: '2001', qty: -5, supplyDate: '2026-09-29' });
      assert.equal(h.stockOf('2001'), 80);
      assert.equal(row('SELECT COUNT(*) c FROM supplies').c, 0);
    });

    it('a price change made by the manager is what the clerk sees when scanning', async () => {
      await h.call('PUT', '/items/2001/price', t.manager, { price: 75.5 });
      assert.equal((await h.call('GET', '/items/2001', t.clerk)).data.unit_price, 75.5);
      assert.equal(row("SELECT unit_price p FROM items WHERE code = '2001'").p, 75.5);
    });

    it('stock added by the stock employee can be sold by the clerk (inventory <-> transaction)', async () => {
      h.db.prepare("UPDATE items SET qty_in_stock = 0 WHERE code = '2001'").run();
      const id = (await h.call('POST', '/transactions', t.clerk)).data.id;
      assert.equal((await h.call('POST', `/transactions/${id}/items`, t.clerk, { code: '2001', qty: 1 })).status, 409);
      await h.call('POST', '/inventory/supply', t.stock, { code: '2001', qty: 5, supplyDate: '2026-09-29' });
      assert.equal((await h.call('POST', `/transactions/${id}/items`, t.clerk, { code: '2001', qty: 1 })).status, 200);
    });

    it('the manager inventory view shows stock left after sales and supplies (all three modules agree)', async () => {
      await h.call('POST', '/inventory/supply', t.stock, { code: '2002', qty: 10, supplyDate: '2026-09-29' });
      await h.sale(t.clerk, [['2002', 4]]);
      assert.equal((await h.call('GET', '/inventory?q=2002', t.manager)).data[0].qty_in_stock, 56);
    });
  });

  describe('reports read what the transaction module wrote', () => {
    it('report totals equal the sum of stored bill totals for the day', async () => {
      await h.sale(t.clerk, [['1001', 2], ['2001', 3]]);
      await h.sale(t.clerk, [['1003', 1.5]]);
      await h.sale(t.clerk, [['2005', 2]], 'open'); // never billed, must not count
      const today = h.localToday();
      const rep = (await h.call('GET', `/reports/sales?code=all&from=${today}&to=${today}`, t.manager)).data;
      const billed = row("SELECT SUM(total) s FROM transactions WHERE status IN ('bill_printed','completed')").s;
      assert.equal(rep.totals.revenueRealized, billed);
    });

    it('profit uses the cost snapshot stored with each line, not the current cost price', async () => {
      await h.sale(t.clerk, [['2001', 2]]);
      h.db.prepare("UPDATE items SET cost_price = 1000 WHERE code = '2001'").run();
      const today = h.localToday();
      const rep = (await h.call('GET', `/reports/sales?code=2001&from=${today}&to=${today}`, t.manager)).data;
      assert.equal(rep.stats[0].profit, 16); // 2 x (62 - 54)
    });
  });

  describe('access control is enforced before any service runs', () => {
    it('a stock employee cannot ring up a sale: no transaction row is created', async () => {
      assert.equal((await h.call('POST', '/transactions', t.stock)).status, 403);
      assert.equal(row('SELECT COUNT(*) c FROM transactions').c, 0);
    });
    it('a clerk cannot change stock or prices: database untouched', async () => {
      assert.equal((await h.call('POST', '/inventory/supply', t.clerk, { code: '2001', qty: 5, supplyDate: '2026-09-29' })).status, 403);
      assert.equal((await h.call('PUT', '/items/2001/price', t.clerk, { price: 1 })).status, 403);
      assert.deepEqual([h.stockOf('2001'), row("SELECT unit_price p FROM items WHERE code = '2001'").p], [80, 62]);
    });
    it('a second clerk cannot read, change, bill or cancel the first clerk\'s transaction', async () => {
      const { username, password } = h.addClerk();
      const other = await h.login(username, password);
      const { id } = await h.sale(t.clerk, [['2001', 1]], 'open');
      assert.equal((await h.call('GET', `/transactions/${id}`, other)).status, 403);
      assert.equal((await h.call('POST', `/transactions/${id}/items`, other, { code: '2002', qty: 1 })).status, 403);
      assert.equal((await h.call('POST', `/transactions/${id}/checkout`, other)).status, 403);
      assert.equal((await h.call('POST', `/transactions/${id}/cancel`, other)).status, 403);
      assert.equal(h.statusOf(id), 'adding_items');
      assert.equal(h.stockOf('2001'), 80);
    });
    it('missing or invalid token -> 401', async () => {
      assert.equal((await h.call('GET', '/inventory')).status, 401);
      assert.equal((await h.call('GET', '/inventory', 'forged-token')).status, 401);
    });
  });

  describe('database constraints back up the service rules', () => {
    it('the schema itself refuses negative stock', () => {
      assert.throws(() => h.db.prepare("UPDATE items SET qty_in_stock = -1 WHERE code = '2001'").run(), /CHECK|constraint/i);
    });
    it('the schema refuses an unknown transaction status', () => {
      const id = h.db.prepare("INSERT INTO transactions (datetime, clerk_id) VALUES ('2026-01-01', 1)").run().lastInsertRowid;
      assert.throws(() => h.db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('weird', id), /CHECK|constraint/i);
    });
    it('foreign keys refuse a line item for a missing item', () => {
      const id = h.db.prepare("INSERT INTO transactions (datetime, clerk_id) VALUES ('2026-01-01', 1)").run().lastInsertRowid;
      assert.throws(() => h.db.prepare("INSERT INTO line_items (transaction_id, item_code, quantity, price_at_sale, cost_at_sale, amount) VALUES (?, 'nope', 1, 1, 1, 1)").run(id), /FOREIGN KEY|constraint/i);
    });
    it('passwords are stored hashed (salt:scrypt), never in plain text', () => {
      for (const e of h.db.prepare('SELECT username, password FROM employees').all()) {
        assert.match(e.password, /^[0-9a-f]{16}:[0-9a-f]{64}$/);
        assert.ok(!e.password.includes(`${e.username}123`));
      }
    });
  });

  describe('HTTP layer', () => {
    it('answers CORS preflight with 204 and the allowed methods', async () => {
      const r = await h.call('OPTIONS', '/login');
      assert.equal(r.status, 204);
      assert.match(r.headers.get('access-control-allow-methods'), /DELETE/);
      assert.match(r.headers.get('access-control-allow-headers'), /Authorization/);
    });
    it('unknown routes return 404 and every error from the API is JSON with an "error" field', async () => {
      assert.equal((await h.call('GET', '/nope', t.clerk)).status, 404);
      const bad = await h.call('POST', '/login', null, { username: 'x', password: 'y' });
      assert.equal(typeof bad.data.error, 'string');
    });
  });
});
