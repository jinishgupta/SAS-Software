// Shared test helpers. Every test file runs in its own process (node --test), so each gets its own
// throwaway SQLite database: SAS_DB must be set BEFORE the app / db modules are first required.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const dbFile = path.join(os.tmpdir(), `sas-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
process.env.SAS_DB = dbFile;

const app = require('../server');
const { db, hashPassword, seedItems } = require('../db');

let server;
let base;

async function start() {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
}

async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch { /* already closed */ }
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
}

// Back to the pristine seed state: no transactions/supplies, all items reset, only the 3 seeded staff.
function reset() {
  db.exec('DELETE FROM line_items; DELETE FROM transactions; DELETE FROM supplies; DELETE FROM items;');
  db.exec("DELETE FROM employees WHERE username NOT IN ('clerk','stock','manager')");
  seedItems();
}

// Minimal HTTP client. `opts.raw` sends the given string as the body untouched (for malformed-JSON tests).
async function call(method, url, token, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + url, {
    method,
    headers,
    body: opts.raw !== undefined ? opts.raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers, text };
}

const CREDENTIALS = { clerk: 'clerk123', stock: 'stock123', manager: 'manager123' };

async function login(username, password = CREDENTIALS[username]) {
  const r = await call('POST', '/login', null, { username, password });
  return r.data.token;
}

async function tokens() {
  return { clerk: await login('clerk'), stock: await login('stock'), manager: await login('manager') };
}

// Insert a second clerk directly in the DB (no API exists for creating staff).
function addClerk(username = 'clerk2', password = 'pass2') {
  db.prepare('INSERT INTO employees (name, role, username, password) VALUES (?,?,?,?)').run('Second Clerk', 'clerk', username, hashPassword(password));
  return { username, password };
}

// Run a sale through the API. lines = [[code, qty], ...]; upTo = 'open' | 'billed' | 'paid'
async function sale(token, lines, upTo = 'paid') {
  const t = (await call('POST', '/transactions', token)).data;
  for (const [code, qty] of lines) {
    const r = await call('POST', `/transactions/${t.id}/items`, token, { code, qty });
    if (r.status !== 200) throw new Error(`setup failed adding ${code} x${qty}: ${r.status} ${JSON.stringify(r.data)}`);
  }
  if (upTo === 'open') return { id: t.id };
  const bill = (await call('POST', `/transactions/${t.id}/checkout`, token)).data;
  if (upTo === 'billed') return { id: t.id, bill };
  const paid = (await call('POST', `/transactions/${t.id}/pay`, token)).data;
  return { id: t.id, bill: paid };
}

const stockOf = (code) => db.prepare('SELECT qty_in_stock q FROM items WHERE code = ?').get(code).q;
const statusOf = (id) => db.prepare('SELECT status FROM transactions WHERE id = ?').get(id).status;
// Move a sale to another day (noon UTC keeps the local calendar date stable in most time zones).
const backdate = (id, ymd) => db.prepare('UPDATE transactions SET datetime = ? WHERE id = ?').run(`${ymd}T12:00:00.000Z`, id);
const localToday = () => { const n = new Date(); return new Date(n - n.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

module.exports = { db, start, cleanup, reset, call, login, tokens, addClerk, sale, stockOf, statusOf, backdate, localToday };
