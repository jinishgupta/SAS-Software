// SalesStatistics: quantity sold, revenue realized, profit per item over a period.
// Only billed transactions (bill_printed / completed) count as sales.
const { db } = require('../db');
const { HttpError, round2 } = require('./inventory');

function salesStatistics(code, from, to) {
  if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new HttpError(400, 'Valid from and to dates required');
  if (from > to) throw new HttpError(400, 'Start date must not be after end date');
  const all = !code || code === 'all';
  // getSalesData(period): compares the server-local calendar date of the transaction
  const rows = db.prepare(
    `SELECT l.item_code AS itemCode, i.name, i.unit,
            SUM(l.quantity) AS quantitySold,
            SUM(l.amount) AS revenueRealized,
            SUM(l.amount - l.quantity * l.cost_at_sale) AS profit
     FROM line_items l
     JOIN transactions t ON t.id = l.transaction_id
     JOIN items i ON i.code = l.item_code
     WHERE t.status IN ('bill_printed','completed')
       AND date(t.datetime,'localtime') BETWEEN ? AND ?
       ${all ? '' : 'AND l.item_code = ?'}
     GROUP BY l.item_code ORDER BY l.item_code`
  ).all(...(all ? [from, to] : [from, to, String(code)]));
  const stats = rows.map((r) => ({
    itemCode: r.itemCode, name: r.name, unit: r.unit, periodFrom: from, periodTo: to,
    quantitySold: round2(r.quantitySold), revenueRealized: round2(r.revenueRealized), profit: round2(r.profit),
  }));
  const totals = stats.reduce((a, s) => ({ revenueRealized: a.revenueRealized + s.revenueRealized, profit: a.profit + s.profit }), { revenueRealized: 0, profit: 0 });
  return { from, to, stats, totals: { revenueRealized: round2(totals.revenueRealized), profit: round2(totals.profit) } };
}

module.exports = { salesStatistics };
