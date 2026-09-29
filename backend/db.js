// Database layer (SQLite via Node's built-in node:sqlite). Creates schema and seed data on first run.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const db = new DatabaseSync(process.env.SAS_DB || path.join(__dirname, 'sas.db'));
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('clerk','stock','manager')),
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit_price REAL NOT NULL CHECK (unit_price >= 0),
  cost_price REAL NOT NULL CHECK (cost_price >= 0),
  qty_in_stock REAL NOT NULL DEFAULT 0 CHECK (qty_in_stock >= 0),
  sold_by_weight INTEGER NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'pc'
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  datetime TEXT NOT NULL,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated','adding_items','billed','inventory_updated','bill_printed','completed','cancelled')),
  clerk_id INTEGER NOT NULL REFERENCES employees(id)
);
CREATE TABLE IF NOT EXISTS line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  item_code TEXT NOT NULL REFERENCES items(code),
  quantity REAL NOT NULL CHECK (quantity > 0),
  price_at_sale REAL NOT NULL,
  cost_at_sale REAL NOT NULL,
  amount REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS supplies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_code TEXT NOT NULL REFERENCES items(code),
  qty REAL NOT NULL CHECK (qty > 0),
  supply_date TEXT NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id)
);
`);

function hashPassword(pw) {
  const salt = crypto.randomBytes(8).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(pw, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
}

// Wraps fn in a SQLite transaction (commit on success, rollback on throw).
function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const SEED_ITEMS = [
  ['1001', 'Basmati Rice', 120, 95, 200, 1, 'kg'],
  ['1002', 'Wheat Flour', 45, 36, 150, 1, 'kg'],
  ['1003', 'Sugar', 48, 40, 120, 1, 'kg'],
  ['1004', 'Tomatoes', 30, 20, 60, 1, 'kg'],
  ['1005', 'Apples', 180, 140, 40, 1, 'kg'],
  ['2001', 'Milk 1L', 62, 54, 80, 0, 'pc'],
  ['2002', 'Bread Loaf', 40, 30, 50, 0, 'pc'],
  ['2003', 'Butter 100g', 58, 48, 45, 0, 'pc'],
  ['2004', 'Biscuits Pack', 25, 18, 100, 0, 'pc'],
  ['2005', 'Soap Bar', 35, 24, 90, 0, 'pc'],
];

function seedItems() {
  const item = db.prepare('INSERT INTO items (code, name, unit_price, cost_price, qty_in_stock, sold_by_weight, unit) VALUES (?,?,?,?,?,?,?)');
  SEED_ITEMS.forEach((r) => item.run(...r));
}

function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM employees').get().c > 0) return;
  const emp = db.prepare('INSERT INTO employees (name, role, username, password) VALUES (?,?,?,?)');
  emp.run('Chitra Clerk', 'clerk', 'clerk', hashPassword('clerk123'));
  emp.run('Sanjay Stock', 'stock', 'stock', hashPassword('stock123'));
  emp.run('Meera Manager', 'manager', 'manager', hashPassword('manager123'));

  seedItems();
}
seed();

module.exports = { db, tx, hashPassword, verifyPassword, SEED_ITEMS, seedItems };
