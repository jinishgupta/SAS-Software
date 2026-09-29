// Inventory / Item logic (class diagram: Inventory, Item)
const { db, tx } = require('../db');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const round2 = (n) => Math.round(n * 100) / 100;
const MAX_VALUE = 100000; // upper limit for prices and supply quantities

// Accepts real numbers and numeric strings only (not booleans, arrays, null, ...); must be finite and > 0.
function positiveNumber(v, label, max) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${label} must be greater than 0`);
  if (max && n > max) throw new HttpError(400, `${label} must not exceed ${max}`);
  return n;
}

// Count items: whole numbers. Weight items: multiples of 0.01 (scale resolution).
function checkUnitFit(item, qty) {
  if (!item.sold_by_weight && !Number.isInteger(qty)) throw new HttpError(400, 'Quantity must be a whole number for this item');
  if (item.sold_by_weight && Math.abs(qty * 100 - Math.round(qty * 100)) > 1e-9) throw new HttpError(400, 'Weight can have at most 2 decimal places');
}

const findItem = (code) => db.prepare('SELECT * FROM items WHERE code = ?').get(String(code));

function getItemOrFail(code) {
  const item = findItem(code);
  if (!item) throw new HttpError(404, `Item code "${code}" not found`);
  return item;
}

// Manager: query inventory details (all items, or filtered by code / name)
function queryInventory(q) {
  if (!q) return db.prepare('SELECT * FROM items ORDER BY code').all();
  return db.prepare('SELECT * FROM items WHERE code = ? OR name LIKE ? ORDER BY code').all(String(q), `%${q}%`);
}

// Item.decreaseStock — called inside the checkout transaction
function decreaseStock(code, qty) {
  const item = getItemOrFail(code);
  if (item.qty_in_stock < qty) throw new HttpError(409, `Insufficient stock for ${item.name}`);
  db.prepare('UPDATE items SET qty_in_stock = qty_in_stock - ? WHERE code = ?').run(qty, code);
}

// Stock employee: replenish stock (validate code -> increaseStock -> confirmation)
function increaseStock(code, qty, supplyDate, employeeId) {
  const item = getItemOrFail(code); // validateItemCode()
  qty = positiveNumber(qty, 'Quantity', MAX_VALUE);
  if (!supplyDate || Number.isNaN(Date.parse(supplyDate))) throw new HttpError(400, 'Valid supply date required');
  checkUnitFit(item, qty);
  return tx(() => {
    db.prepare('UPDATE items SET qty_in_stock = qty_in_stock + ? WHERE code = ?').run(qty, code);
    db.prepare('INSERT INTO supplies (item_code, qty, supply_date, employee_id) VALUES (?,?,?,?)').run(code, qty, supplyDate, employeeId);
    return { message: 'Inventory updated successfully', item: findItem(code) };
  });
}

// Stock employee: most recent supply entries
const recentSupplies = (limit = 10) => db.prepare(
  `SELECT s.id, s.item_code, i.name, i.unit, s.qty, s.supply_date, e.name AS employee
   FROM supplies s JOIN items i ON i.code = s.item_code JOIN employees e ON e.id = s.employee_id
   ORDER BY s.id DESC LIMIT ?`).all(limit);

// Manager: Item.updatePrice(newPrice)
function updatePrice(code, newPrice) {
  getItemOrFail(code);
  newPrice = positiveNumber(newPrice, 'Price', MAX_VALUE);
  db.prepare('UPDATE items SET unit_price = ? WHERE code = ?').run(round2(newPrice), code);
  return findItem(code);
}

module.exports = { HttpError, round2, positiveNumber, checkUnitFit, findItem, getItemOrFail, queryInventory, decreaseStock, increaseStock, updatePrice, recentSupplies };
