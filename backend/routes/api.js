// REST API. Roles: clerk (sales), stock (replenish), manager (inventory, price, reports).
const express = require('express');
const crypto = require('node:crypto');
const { db, verifyPassword } = require('../db');
const inv = require('../services/inventory');
const txn = require('../services/transaction');
const report = require('../services/report');

const router = express.Router();
const sessions = new Map(); // token -> { id, name, role }

// Employee.login()
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const emp = db.prepare('SELECT * FROM employees WHERE username = ?').get(String(username || ''));
  if (!emp || !verifyPassword(String(password || ''), emp.password)) return res.status(401).json({ error: 'Invalid username or password' });
  const token = crypto.randomBytes(24).toString('hex');
  const user = { id: emp.id, name: emp.name, role: emp.role };
  sessions.set(token, user);
  res.json({ token, user });
});

router.post('/logout', (req, res) => {
  sessions.delete((req.headers.authorization || '').replace('Bearer ', ''));
  res.json({ ok: true });
});

// Auth + role guard
const auth = (...roles) => (req, res, next) => {
  const user = sessions.get((req.headers.authorization || '').replace('Bearer ', ''));
  if (!user) return res.status(401).json({ error: 'Please log in' });
  if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'Not allowed for your role' });
  req.user = user;
  next();
};
const wrap = (fn) => (req, res) => {
  try {
    res.json(fn(req));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' });
    if (!e.status) console.error(e);
  }
};

// ---- Sales Clerk ----
router.get('/items/:code', auth('clerk'), wrap((req) => inv.getItemOrFail(req.params.code))); // scan barcode / findItem
router.get('/items', auth('clerk'), wrap(() => inv.queryInventory())); // demo: barcode list for the simulated reader
router.post('/transactions', auth('clerk'), wrap((req) => txn.start(req.user.id)));
router.get('/transactions/:id', auth('clerk'), wrap((req) => txn.view(req.params.id, req.user.id)));
router.post('/transactions/:id/items', auth('clerk'), wrap((req) => txn.addLineItem(req.params.id, req.user.id, req.body.code, req.body.qty)));
router.delete('/transactions/:id/items/:lineId', auth('clerk'), wrap((req) => txn.removeLineItem(req.params.id, req.user.id, req.params.lineId)));
router.post('/transactions/:id/checkout', auth('clerk'), wrap((req) => txn.checkout(req.params.id, req.user.id)));
router.post('/transactions/:id/pay', auth('clerk'), wrap((req) => txn.pay(req.params.id, req.user.id)));
router.post('/transactions/:id/cancel', auth('clerk'), wrap((req) => txn.cancel(req.params.id, req.user.id)));

// ---- Stock Employee ----
router.post('/inventory/supply', auth('stock'), wrap((req) =>
  inv.increaseStock(String(req.body.code || ''), req.body.qty, req.body.supplyDate, req.user.id)));
router.get('/inventory/supplies', auth('stock'), wrap(() => inv.recentSupplies()));
router.get('/stock-items', auth('stock'), wrap(() => inv.queryInventory()));

// ---- Manager ----
router.get('/inventory', auth('manager'), wrap((req) => inv.queryInventory(req.query.q))); // queryInventory
router.put('/items/:code/price', auth('manager'), wrap((req) => inv.updatePrice(req.params.code, req.body.price))); // changeItemPrice
router.get('/reports/sales', auth('manager'), wrap((req) => report.salesStatistics(req.query.code, req.query.from, req.query.to)));

module.exports = router;
