// SalesTransaction / LineItem / Bill logic.
// State chart: initiated -> adding_items -> billed -> inventory_updated -> bill_printed -> completed | cancelled
const { db, tx } = require('../db');
const inv = require('./inventory');
const { HttpError, round2 } = inv;

function getTxn(id, clerkId) {
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(id));
  if (!t) throw new HttpError(404, 'Transaction not found');
  if (clerkId && t.clerk_id !== clerkId) throw new HttpError(403, 'Transaction belongs to another clerk');
  return t;
}
const setStatus = (id, status) => db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run(status, id);
const lineItems = (id) => db.prepare(
  `SELECT l.id, l.item_code, i.name, l.quantity, i.unit, l.price_at_sale, l.amount
   FROM line_items l JOIN items i ON i.code = l.item_code WHERE l.transaction_id = ? ORDER BY l.id`).all(id);

// SalesTransaction.calculateTotal()
const calculateTotal = (id) =>
  round2(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM line_items WHERE transaction_id = ?').get(id).s);

// Clerk starts a new transaction -> initiated
function start(clerkId) {
  const r = db.prepare('INSERT INTO transactions (datetime, clerk_id) VALUES (?,?)').run(new Date().toISOString(), clerkId);
  return view(Number(r.lastInsertRowid));
}

// SalesTransaction.addLineItem(item, qty) -> creates LineItem, state = adding_items
function addLineItem(id, clerkId, code, qty) {
  const t = getTxn(id, clerkId);
  if (!['initiated', 'adding_items'].includes(t.status)) throw new HttpError(400, `Cannot add items when transaction is ${t.status}`);
  const item = inv.getItemOrFail(code);
  qty = inv.positiveNumber(qty, 'Quantity');
  inv.checkUnitFit(item, qty);
  const already = db.prepare('SELECT COALESCE(SUM(quantity),0) s FROM line_items WHERE transaction_id = ? AND item_code = ?').get(t.id, item.code).s;
  if (already + qty > item.qty_in_stock) throw new HttpError(409, `Only ${item.qty_in_stock} ${item.unit} of ${item.name} in stock`);
  const amount = round2(qty * item.unit_price); // LineItem.computeAmount()
  if (amount <= 0) throw new HttpError(400, 'Line amount is too small to sell');
  tx(() => {
    db.prepare('INSERT INTO line_items (transaction_id, item_code, quantity, price_at_sale, cost_at_sale, amount) VALUES (?,?,?,?,?,?)')
      .run(t.id, item.code, qty, item.unit_price, item.cost_price, amount);
    setStatus(t.id, 'adding_items');
  });
  return view(t.id);
}

// Remove a scanned line before the sale is finalized (back to initiated when empty)
function removeLineItem(id, clerkId, lineId) {
  const t = getTxn(id, clerkId);
  if (!['initiated', 'adding_items'].includes(t.status)) throw new HttpError(400, `Cannot remove items when transaction is ${t.status}`);
  const r = db.prepare('DELETE FROM line_items WHERE id = ? AND transaction_id = ?').run(Number(lineId), t.id);
  if (!r.changes) throw new HttpError(404, 'Line item not found');
  if (!lineItems(t.id).length) setStatus(t.id, 'initiated');
  return view(t.id);
}

// Clerk finalizes: billed -> decrease stock -> inventory_updated -> generate/print bill -> bill_printed
function checkout(id, clerkId) {
  const t = getTxn(id, clerkId);
  if (t.status !== 'adding_items') {
    throw new HttpError(400, t.status === 'initiated' ? 'Add at least one item first' : `Cannot finalize a ${t.status} transaction`);
  }
  tx(() => {
    const total = calculateTotal(t.id);
    db.prepare('UPDATE transactions SET total = ?, status = ? WHERE id = ?').run(total, 'billed', t.id);
    for (const l of lineItems(t.id)) inv.decreaseStock(l.item_code, l.quantity);
    setStatus(t.id, 'inventory_updated');
    setStatus(t.id, 'bill_printed');
  });
  return generateBill(t.id);
}

// SalesTransaction.generateBill() -> Bill(billNo, transactionId, items, totalAmount)
function generateBill(id) {
  const t = getTxn(id);
  if (!['bill_printed', 'completed'].includes(t.status)) throw new HttpError(400, 'Bill not available yet');
  return {
    billNo: String(t.id).padStart(6, '0'),
    transactionId: t.id,
    datetime: t.datetime,
    status: t.status,
    items: lineItems(t.id).map((l) => ({
      code: l.item_code, name: l.name, quantity: l.quantity, unit: l.unit, unitPrice: l.price_at_sale, itemPrice: l.amount,
    })),
    totalAmount: t.total,
  };
}

// Customer pays -> completed
function pay(id, clerkId) {
  const t = getTxn(id, clerkId);
  if (t.status !== 'bill_printed') throw new HttpError(400, 'Bill must be printed before payment');
  setStatus(t.id, 'completed');
  return generateBill(t.id);
}

// Abort before billing -> cancelled (stock untouched)
function cancel(id, clerkId) {
  const t = getTxn(id, clerkId);
  if (!['initiated', 'adding_items'].includes(t.status)) throw new HttpError(400, `Cannot cancel a ${t.status} transaction`);
  setStatus(t.id, 'cancelled');
  return view(t.id);
}

// Running view of a transaction (for the clerk's screen)
function view(id, clerkId) {
  const t = getTxn(id, clerkId);
  return { id: t.id, status: t.status, datetime: t.datetime, items: lineItems(t.id), runningTotal: calculateTotal(t.id) };
}

module.exports = { start, addLineItem, removeLineItem, checkout, generateBill, pay, cancel, view };
