// WHITE-BOX unit tests: services/report.js (SalesStatistics)
// Branches: date validation (missing / malformed / from > to), item filter (all vs one), empty result.
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const txn = require('../../services/transaction');
const { salesStatistics } = require('../../services/report');
const { HttpError } = require('../../services/inventory');

const CLERK = 1;
const D1 = '2026-03-10', D2 = '2026-03-11', D3 = '2026-03-20';

// Sales (price / cost): rice 120/95, milk 62/54
//   S1 (D1): 2 kg rice + 3 milk   -> rice rev 240 profit 50 ; milk rev 186 profit 24
//   S2 (D2): 1.5 kg rice          -> rice rev 180 profit 37.5
function makeSale(lines, day, billed = true) {
  const id = txn.start(CLERK).id;
  for (const [c, q] of lines) txn.addLineItem(id, CLERK, c, q);
  if (billed) txn.checkout(id, CLERK);
  h.backdate(id, day);
  return id;
}

describe('report service (white box)', () => {
  beforeEach(() => h.reset());
  after(() => h.cleanup());

  const throwsHttp = (fn, status) => assert.throws(fn, (e) => e instanceof HttpError && e.status === status);

  it('rejects missing / malformed dates (400)', () => {
    throwsHttp(() => salesStatistics('all', undefined, D1), 400);
    throwsHttp(() => salesStatistics('all', D1, undefined), 400);
    throwsHttp(() => salesStatistics('all', 'garbage', D1), 400);
    throwsHttp(() => salesStatistics('all', D1, 'garbage'), 400);
  });
  it('rejects from > to (400) but accepts from == to', () => {
    throwsHttp(() => salesStatistics('all', D2, D1), 400);
    assert.deepEqual(salesStatistics('all', D1, D1).stats, []);
  });
  it('returns empty stats and zero totals when there are no sales (branch: no rows)', () => {
    const r = salesStatistics('all', D1, D3);
    assert.deepEqual(r.stats, []);
    assert.deepEqual(r.totals, { revenueRealized: 0, profit: 0 });
  });

  describe('with sales', () => {
    beforeEach(() => {
      makeSale([['1001', 2], ['2001', 3]], D1);
      makeSale([['1001', 1.5]], D2);
    });

    it('single day includes only that day', () => {
      const r = salesStatistics('all', D1, D1);
      assert.deepEqual(r.stats.map((s) => s.itemCode), ['1001', '2001']);
      assert.equal(r.stats[0].quantitySold, 2);
      assert.equal(r.stats[0].revenueRealized, 240);
      assert.equal(r.stats[0].profit, 50);
    });
    it('period aggregates across days (rice 3.5 kg, revenue 420, profit 87.5)', () => {
      const r = salesStatistics('all', D1, D2);
      const rice = r.stats.find((s) => s.itemCode === '1001');
      assert.deepEqual([rice.quantitySold, rice.revenueRealized, rice.profit], [3.5, 420, 87.5]);
      const milk = r.stats.find((s) => s.itemCode === '2001');
      assert.deepEqual([milk.quantitySold, milk.revenueRealized, milk.profit], [3, 186, 24]);
    });
    it('totals are the sum over items (revenue 606, profit 111.5)', () => {
      assert.deepEqual(salesStatistics('all', D1, D2).totals, { revenueRealized: 606, profit: 111.5 });
    });
    it('filters to a single item (branch: code != all)', () => {
      const r = salesStatistics('2001', D1, D2);
      assert.deepEqual(r.stats.map((s) => s.itemCode), ['2001']);
    });
    it('an item that was never sold or does not exist gives an empty report', () => {
      assert.deepEqual(salesStatistics('2005', D1, D2).stats, []);
      assert.deepEqual(salesStatistics('nope', D1, D2).stats, []);
    });
    it('a period with no sales in range excludes other days', () => {
      assert.deepEqual(salesStatistics('all', D3, D3).stats, []);
    });
    it('includes period boundaries on both ends (inclusive)', () => {
      assert.equal(salesStatistics('1001', D1, D2).stats[0].quantitySold, 3.5);
      assert.equal(salesStatistics('1001', D2, D2).stats[0].quantitySold, 1.5);
    });
    it('excludes cancelled and unbilled transactions', () => {
      const cancelled = makeSale([['2002', 4]], D1, false);
      txn.cancel(cancelled, CLERK);
      makeSale([['2003', 2]], D1, false); // still open
      const codes = salesStatistics('all', D1, D1).stats.map((s) => s.itemCode);
      assert.deepEqual(codes, ['1001', '2001']);
    });
    it('changing the price later does not change past revenue or profit', () => {
      h.db.prepare("UPDATE items SET unit_price = 999, cost_price = 1 WHERE code = '1001'").run();
      const rice = salesStatistics('1001', D1, D2).stats[0];
      assert.deepEqual([rice.revenueRealized, rice.profit], [420, 87.5]);
    });
    it('reports the loss when an item is sold below cost (negative profit)', () => {
      h.db.prepare("UPDATE items SET unit_price = 50 WHERE code = '2005'").run();
      h.db.prepare("UPDATE items SET cost_price = 60 WHERE code = '2005'").run();
      makeSale([['2005', 2]], D1);
      const s = salesStatistics('2005', D1, D1).stats[0];
      assert.deepEqual([s.revenueRealized, s.profit], [100, -20]);
    });
  });
});
