// SAS frontend: login -> role-based views (clerk / stock / manager).
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const isoDate = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const LOW_STOCK = 20;

// ---------- icons ----------
const ICONS = {
  cart: '<path d="M3 4h2l2.4 10.2a1 1 0 0 0 1 .8h8.2a1 1 0 0 0 1-.8L19 8H6"/><circle cx="9" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/>',
  box: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  tag: '<path d="M20 12l-8 8-9-9V3h8l9 9z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  report: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  store: '<path d="M3 9l1.5-5h15L21 9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 12v8h14v-8"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  edit: '<path d="M12 20h9M16.5 3.5l4 4L8 20l-5 1 1-5L16.5 3.5z"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  print: '<path d="M6 9V3h12v6M6 18H4v-7h16v7h-2"/><path d="M6 14h12v7H6z"/>',
  scan: '<path d="M4 7V4h3M20 7V4h-3M4 17v3h3M20 17v3h-3M8 8v8M12 8v8M16 8v8"/>',
};
const icon = (n, s = 18) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
$('#brand-icon').innerHTML = icon('store', 22);
$('#logout').innerHTML = icon('logout');

// ---------- session + api ----------
let session = null;
try { session = JSON.parse(sessionStorage.getItem('sas') || 'null'); } catch { /* ignore */ }

let pending = 0;
const loader = (d) => { pending += d; $('#loader').classList.toggle('on', pending > 0); };

async function api(method, url, body) {
  loader(1);
  try {
    const res = await fetch(window.SAS_API + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: 'Bearer ' + session.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && session) { logout(); throw new Error('Session expired, please log in again'); }
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  } catch (e) {
    throw e instanceof TypeError ? new Error('Cannot reach the server. Is the backend running?') : e;
  } finally { loader(-1); }
}

// ---------- feedback ----------
function toast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML = icon(type === 'error' ? 'alert' : 'check') + `<span>${esc(msg)}</span>`;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3800);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, 'error'); } };

function ask({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const d = $('#dlg');
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><p>${esc(message)}</p>
      <div class="dlg-actions"><button value="cancel" class="btn ghost">Cancel</button>
      <button value="ok" class="btn ${danger ? 'danger' : ''}" autofocus>${esc(confirmText)}</button></div></form>`;
    d.returnValue = '';
    d.onclose = () => resolve(d.returnValue === 'ok');
    d.showModal();
  });
}

const pageHead = (title, sub) => `<div class="page-head"><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>`;
const empty = (ic, title, text, btn = '') => `<div class="empty"><div class="empty-ic">${icon(ic, 26)}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${btn}</div>`;
const stockBadge = (q) => (q <= 0 ? '<span class="badge out">Out</span>' : q < LOW_STOCK ? '<span class="badge low">Low</span>' : '<span class="badge">In stock</span>');

// ---------- shell ----------
const TABS = {
  clerk: [['sale', 'New Sale', 'cart']],
  stock: [['supply', 'Receive Stock', 'box']],
  manager: [['inventory', 'Inventory & Prices', 'tag'], ['report', 'Sales Statistics', 'report']],
};
const VIEWS = { sale: saleView, supply: supplyView, inventory: inventoryView, report: reportView };
let sale = null;

function logout() {
  if (session) api('POST', '/logout').catch(() => {});
  session = null;
  sale = null;
  sessionStorage.removeItem('sas');
  boot();
}
$('#logout').onclick = logout;

function boot() {
  if (!session) return loginView();
  $('#login-root').innerHTML = '';
  $('#shell').hidden = false;
  const u = session.user;
  $('#who-name').textContent = u.name;
  $('#who-role').textContent = u.role === 'stock' ? 'Stock employee' : u.role === 'clerk' ? 'Sales clerk' : 'Manager';
  $('#avatar').textContent = u.name.trim()[0].toUpperCase();
  const tabs = TABS[u.role];
  $('#tabs').innerHTML = tabs.map(([k, l, i]) => `<button class="nav-item" data-k="${k}">${icon(i, 20)}<span>${l}</span></button>`).join('');
  $('#tabs').onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) show(b.dataset.k); };
  show(tabs[0][0]);
}
function show(key) {
  document.querySelectorAll('#tabs .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.k === key));
  app.classList.remove('enter'); void app.offsetWidth; app.classList.add('enter');
  setTimeout(() => app.classList.remove('enter'), 1400);
  app.innerHTML = '<div class="loading">Loading…</div>';
  Promise.resolve(VIEWS[key]()).catch((e) => { app.innerHTML = empty('alert', 'Something went wrong', e.message); });
}

// ---------- login ----------
function loginView() {
  $('#shell').hidden = true;
  $('#login-root').innerHTML = `
    <div class="login-page">
      <div class="awning-wrap"><div class="awning-stripes"></div></div>
      <div class="shapes" aria-hidden="true"><i class="s1"></i><i class="s2"></i><i class="s3"></i></div>
      <div class="login-stage">
        <h1 class="mega">SAS<span>Supermarket automation software</span></h1>
        <form class="login-form" id="lf">
          <h2>Clock in</h2>
          <p class="lead">Staff login. Mind the wet floor.</p>
          <div class="err" id="lerr" hidden></div>
          <div class="field"><label for="u">Username</label><input id="u" autocomplete="username" required autofocus></div>
          <div class="field"><label for="p">Password</label>
            <div class="pw"><input id="p" type="password" autocomplete="current-password" required>
            <button type="button" class="btn ghost icon sm" id="pwt" title="Show password" aria-label="Show password">${icon('eye')}</button></div></div>
          <button class="btn block lg">Open the till</button>
          <div class="demo"><div class="hint-label">Staff badges (click to fill)</div>
            <div class="chips">
              <button type="button" class="chip" data-u="clerk" data-p="clerk123">Sales clerk</button>
              <button type="button" class="chip" data-u="stock" data-p="stock123">Stock employee</button>
              <button type="button" class="chip" data-u="manager" data-p="manager123">Manager</button>
            </div></div>
        </form>
      </div>
    </div>`;
  const form = $('#lf');
  form.querySelectorAll('[data-u]').forEach((c) => (c.onclick = () => { $('#u').value = c.dataset.u; $('#p').value = c.dataset.p; $('#u').focus(); }));
  $('#pwt').onclick = () => { $('#p').type = $('#p').type === 'password' ? 'text' : 'password'; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    $('#lerr').hidden = true;
    try {
      session = await api('POST', '/login', { username: $('#u').value.trim(), password: $('#p').value });
      sessionStorage.setItem('sas', JSON.stringify(session));
      boot();
    } catch (err) { $('#lerr').textContent = err.message; $('#lerr').hidden = false; }
  };
}

// ---------- clerk: register sale ----------
async function saleView() {
  sale = sale || { txn: null, bill: null, item: null, catalog: await api('GET', '/items') };
  renderSale();
}

function stepper(active) {
  const steps = ['Scan items', 'Bill printed', 'Paid'];
  return `<div class="stepper no-print">${steps.map((s, i) =>
    `<div class="step ${i < active ? 'done' : i === active ? 'active' : ''}"><i>${i < active ? icon('check', 14) : i + 1}</i>${s}</div>`).join('')}</div>`;
}

function renderSale() {
  const { txn, bill } = sale;
  if (bill) return renderBill();
  if (!txn) {
    app.innerHTML = pageHead('New Sale', 'Scan items at the counter to build a bill.') +
      `<div class="card">${empty('cart', 'No active transaction', 'When a customer arrives, start a new transaction and scan their items.',
        `<button class="btn lg" id="start">Start new transaction</button>`)}</div>`;
    $('#start').onclick = guard(async () => { sale.txn = await api('POST', '/transactions'); renderSale(); });
    return;
  }
  const it = sale.item;
  const byWeight = it && it.sold_by_weight;
  app.innerHTML = pageHead(`Transaction #${txn.id}`, 'Scan an item, enter the weight or quantity, then add it to the bill.') + stepper(0) + `
    <div class="grid-2">
      <div class="card">
        <div class="card-title">${icon('scan')} Scan item</div>
        <form id="scan" class="field-row">
          <div class="grow"><label for="code">Barcode</label>
            <input id="code" class="big" placeholder="Scan or type code" autocomplete="off" inputmode="numeric" required></div>
          <button class="btn lg">Scan</button>
        </form>
        ${it ? `
        <div class="item-panel">
          <div class="shelf-top"><h3>${esc(it.name)}</h3><div class="shelf-price">${money(it.unit_price)}<small>/ ${esc(it.unit)}</small></div></div>
          <div class="item-meta"><span>Code <b>${esc(it.code)}</b></span><span>Stock <b>${num(it.qty_in_stock)} ${esc(it.unit)}</b> ${stockBadge(it.qty_in_stock)}</span></div>
          <form id="add" class="field-row">
            <div class="grow"><label for="qty">${byWeight ? 'Weight (kg)' : 'Quantity (count)'}</label>
              <input id="qty" class="big" type="number" inputmode="decimal" step="${byWeight ? '0.01' : '1'}" min="${byWeight ? '0.01' : '1'}" value="${byWeight ? '' : 1}" ${byWeight ? 'placeholder="e.g. 1.25"' : ''} required></div>
            <button class="btn lg">Add to bill</button>
          </form>
          <p class="line-preview">Line price: <b id="lp">${byWeight ? '—' : money(it.unit_price)}</b></p>
        </div>` : `
        <div class="hint-label">Quick pick (demo barcodes)</div>
        <div class="chips">${sale.catalog.map((c) => `<button type="button" class="chip" data-code="${esc(c.code)}">${esc(c.code)} · ${esc(c.name)}</button>`).join('')}</div>`}
      </div>
      <div class="sticky paper-shadow"><div class="card till zig">
        <div class="card-title">Current bill <span class="badge">${txn.items.length} item${txn.items.length === 1 ? '' : 's'}</span></div>
        ${txn.items.length ? `<ul class="bill-lines">${txn.items.map((l) => `
          <li><div>${esc(l.name)}<span class="sub">${num(l.quantity)} ${esc(l.unit)} × ${money(l.price_at_sale)}</span></div>
            <span class="amt">${money(l.amount)}</span>
            <button class="btn ghost danger icon sm" data-rm="${l.id}" title="Remove" aria-label="Remove ${esc(l.name)}">${icon('trash', 16)}</button></li>`).join('')}</ul>`
          : empty('cart', 'Bill is empty', 'Scanned items will appear here.')}
        <div class="bill-total"><span>Total payable</span><strong>${money(txn.runningTotal)}</strong></div>
        <div class="actions">
          <button class="btn ghost danger" id="cancel">Cancel</button>
          <button class="btn lg" id="checkout" ${txn.items.length ? '' : 'disabled'}>Finalize &amp; print bill</button>
        </div>
      </div></div>
    </div>`;

  const scan = guard(async (code) => {
    sale.item = await api('GET', '/items/' + encodeURIComponent(code.trim()));
    renderSale();
    $('#qty').focus();
  });
  $('#scan').onsubmit = (e) => { e.preventDefault(); scan($('#code').value); };
  app.querySelectorAll('[data-code]').forEach((b) => (b.onclick = () => scan(b.dataset.code)));
  if (it) {
    const upd = () => { const q = Number($('#qty').value); $('#lp').textContent = q > 0 ? money(q * it.unit_price) : '—'; };
    $('#qty').oninput = upd;
    $('#add').onsubmit = guard(async (e) => {
      e.preventDefault();
      sale.txn = await api('POST', `/transactions/${txn.id}/items`, { code: it.code, qty: $('#qty').value });
      sale.item = null;
      renderSale();
      $('#code').focus();
    });
    if (!byWeight) $('#qty').select();
  } else $('#code').focus();
  app.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = guard(async () => {
    sale.txn = await api('DELETE', `/transactions/${txn.id}/items/${b.dataset.rm}`);
    renderSale();
  })));
  $('#cancel').onclick = guard(async () => {
    if (!(await ask({ title: 'Cancel transaction?', message: 'All scanned items will be discarded. Stock is not affected.', confirmText: 'Cancel transaction', danger: true }))) return;
    await api('POST', `/transactions/${txn.id}/cancel`);
    sale.txn = sale.item = null;
    toast('Transaction cancelled');
    renderSale();
  });
  $('#checkout').onclick = guard(async () => {
    if (!(await ask({ title: 'Finalize this sale?', message: `Total ${money(txn.runningTotal)}. Stock will be reduced and the bill printed. Items can no longer be changed.`, confirmText: 'Finalize' }))) return;
    sale.bill = await api('POST', `/transactions/${txn.id}/checkout`);
    sale.item = null;
    sale.catalog = await api('GET', '/items');
    renderSale();
  });
}

function renderBill() {
  const b = sale.bill;
  const paid = b.status === 'completed';
  app.innerHTML = pageHead(paid ? 'Sale complete' : 'Bill ready', paid ? 'Payment received. Start a new transaction for the next customer.' : 'Print the bill, then confirm once the customer has paid.') +
    stepper(paid ? 3 : 1) + `
    <div class="receipt-wrap">
      <div class="paper-shadow"><div class="receipt zig printable ${paid ? '' : 'printing'}">
        <h2>SAS SUPERMARKET</h2>
        <div class="meta">Bill no. ${esc(b.billNo)} · Txn ${b.transactionId}<br>${new Date(b.datetime).toLocaleString('en-IN')}</div>
        <hr>
        <table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>
          ${b.items.map((l) => `<tr><td>${esc(l.name)}<span class="sub">#${esc(l.code)}</span></td><td class="num">${num(l.quantity)} ${esc(l.unit)}</td><td class="num">${money(l.unitPrice)}</td><td class="num">${money(l.itemPrice)}</td></tr>`).join('')}
        </tbody></table>
        <hr>
        <div class="grand"><span>TOTAL</span><span>${money(b.totalAmount)}</span></div>
        <hr>
        <div class="thanks">${paid ? 'Paid. Thank you for shopping!' : 'Amount payable at counter'}</div>
        ${paid ? '<div class="stamp">PAID</div>' : ''}
      </div></div>
      <div class="actions center no-print">
        <button class="btn ghost" onclick="window.print()">${icon('print')} Print bill</button>
        ${paid ? '<button class="btn" id="next">New transaction</button>' : '<button class="btn" id="pay">Customer paid</button>'}
      </div>
    </div>`;
  if (paid) $('#next').onclick = () => { sale.txn = sale.bill = null; renderSale(); };
  else $('#pay').onclick = guard(async () => { sale.bill = await api('POST', `/transactions/${b.transactionId}/pay`); toast('Payment received'); renderBill(); });
}

// ---------- stock employee: replenish ----------
async function supplyView() {
  const items = await api('GET', '/stock-items');
  const byCode = Object.fromEntries(items.map((i) => [i.code, i]));
  app.innerHTML = pageHead('Receive Stock', 'Record a new supply to update inventory.') + `
    <div class="grid-2">
      <form class="card" id="f">
        <div class="card-title">${icon('box')} New supply</div>
        <div class="field" style="margin-bottom:14px"><label for="code">Item code</label>
          <input id="code" class="big" list="codes" required autocomplete="off" placeholder="e.g. 2001">
          <datalist id="codes">${items.map((i) => `<option value="${esc(i.code)}">${esc(i.name)}</option>`).join('')}</datalist></div>
        <div id="info"></div>
        <div class="field-row" style="margin:14px 0">
          <div class="grow"><label for="qty">Quantity received</label><input id="qty" type="number" step="0.01" min="0.01" required></div>
          <div class="grow"><label for="date">Supply date</label><input id="date" type="date" value="${isoDate()}" required></div>
        </div>
        <button class="btn lg block">Update inventory</button>
      </form>
      <div class="card"><div class="card-title">Recent supplies</div><div id="recent" class="table-wrap"></div></div>
    </div>`;
  const preview = () => {
    const it = byCode[$('#code').value.trim()];
    const q = Number($('#qty').value) || 0;
    $('#qty').step = it && !it.sold_by_weight ? '1' : '0.01';
    $('#info').innerHTML = it
      ? `<div class="item-panel" style="margin:0"><h3>${esc(it.name)}</h3><div class="item-meta" style="margin:6px 0 0"><span>Current stock <b>${num(it.qty_in_stock)} ${esc(it.unit)}</b> ${stockBadge(it.qty_in_stock)}</span>${q > 0 ? `<span>After update <b>${num(it.qty_in_stock + q)} ${esc(it.unit)}</b></span>` : ''}</div></div>`
      : ($('#code').value.trim() ? '<p class="muted" style="color:var(--danger)">No item with this code.</p>' : '');
  };
  const loadRecent = async () => {
    const r = await api('GET', '/inventory/supplies');
    $('#recent').innerHTML = r.length
      ? `<table><thead><tr><th>Date</th><th>Item</th><th class="num">Qty</th></tr></thead><tbody>${r.map((s) => `<tr><td>${esc(s.supply_date)}<span class="sub">${esc(s.employee)}</span></td><td>${esc(s.name)}<span class="sub">#${esc(s.item_code)}</span></td><td class="num">+${num(s.qty)} ${esc(s.unit)}</td></tr>`).join('')}</tbody></table>`
      : empty('box', 'No supplies yet', 'Recorded supplies will appear here.');
  };
  $('#code').oninput = preview;
  $('#qty').oninput = preview;
  $('#f').onsubmit = guard(async (e) => {
    e.preventDefault();
    const r = await api('POST', '/inventory/supply', { code: $('#code').value.trim(), qty: $('#qty').value, supplyDate: $('#date').value });
    byCode[r.item.code] = r.item;
    toast(`${r.message} · ${r.item.name} now ${num(r.item.qty_in_stock)} ${r.item.unit}`);
    e.target.reset();
    $('#date').value = isoDate();
    preview();
    loadRecent();
  });
  loadRecent();
}

// ---------- manager: inventory + price ----------
async function inventoryView() {
  let all = await api('GET', '/inventory');
  let filter = 'all', q = '', editing = null;
  app.innerHTML = pageHead('Inventory & Prices', 'Check stock levels and update selling prices.') + `
    <div class="stats" id="stats"></div>
    <div class="card">
      <div class="toolbar no-print">
        <div class="search">${icon('search', 16)}<input id="q" placeholder="Search by code or name" aria-label="Search"></div>
        <div class="chips" id="chips"></div>
      </div>
      <div class="table-wrap" id="tbl"></div>
    </div>`;

  const render = () => {
    const low = all.filter((i) => i.qty_in_stock > 0 && i.qty_in_stock < LOW_STOCK).length;
    const out = all.filter((i) => i.qty_in_stock <= 0).length;
    const value = all.reduce((s, i) => s + i.qty_in_stock * i.cost_price, 0);
    $('#stats').innerHTML = `
      <div class="stat"><span>Total items</span><strong>${all.length}</strong></div>
      <div class="stat ${low ? 'warn' : ''}"><span>Low stock</span><strong>${low}</strong></div>
      <div class="stat ${out ? 'warn' : ''}"><span>Out of stock</span><strong>${out}</strong></div>
      <div class="stat good"><span>Stock value (at cost)</span><strong>${money(value)}</strong></div>`;
    $('#chips').innerHTML = [['all', 'All'], ['low', 'Low stock'], ['out', 'Out of stock']]
      .map(([k, l]) => `<button class="chip ${filter === k ? 'active' : ''}" data-f="${k}">${l}</button>`).join('');
    const term = q.toLowerCase();
    const rows = all.filter((i) =>
      (!term || i.code.includes(term) || i.name.toLowerCase().includes(term)) &&
      (filter === 'all' || (filter === 'out' ? i.qty_in_stock <= 0 : i.qty_in_stock > 0 && i.qty_in_stock < LOW_STOCK)));
    $('#tbl').innerHTML = rows.length ? `<table><thead><tr><th>Item</th><th class="num">In stock</th><th>Status</th><th class="num">Cost</th><th class="num">Selling price</th><th class="num">Margin</th></tr></thead><tbody>
      ${rows.map((i) => {
        const m = ((i.unit_price - i.cost_price) / i.unit_price) * 100;
        return `<tr><td>${esc(i.name)}<span class="sub">#${esc(i.code)}</span></td>
          <td class="num">${num(i.qty_in_stock)} ${esc(i.unit)}</td><td>${stockBadge(i.qty_in_stock)}</td>
          <td class="num">${money(i.cost_price)}</td>
          <td class="num">${editing === i.code
            ? `<span class="price-cell"><input type="number" min="0.01" step="0.01" value="${i.unit_price}" id="pin" aria-label="New price">
                <button class="btn sm" data-save="${esc(i.code)}">Save</button><button class="btn ghost sm" data-cancel>${icon('x', 14)}</button></span>`
            : `<span class="price-cell">${money(i.unit_price)}<button class="btn ghost icon sm" data-edit="${esc(i.code)}" title="Edit price" aria-label="Edit price of ${esc(i.name)}">${icon('edit', 14)}</button></span>`}</td>
          <td class="num margin ${m < 10 ? 'bad' : ''}">${m.toFixed(1)}%</td></tr>`;
      }).join('')}</tbody></table>` : empty('search', 'No items found', 'Try a different search or filter.');
    if (editing) { const p = $('#pin'); p.focus(); p.select(); p.onkeydown = (e) => { if (e.key === 'Enter') app.querySelector('[data-save]').click(); if (e.key === 'Escape') { editing = null; render(); } }; }
  };

  $('#q').oninput = (e) => { q = e.target.value.trim(); render(); };
  $('#chips').onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) { filter = b.dataset.f; render(); } };
  $('#tbl').onclick = guard(async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.edit) { editing = t.dataset.edit; render(); }
    else if (t.hasAttribute('data-cancel')) { editing = null; render(); }
    else if (t.dataset.save) {
      const item = all.find((i) => i.code === t.dataset.save);
      const price = Number($('#pin').value);
      if (!(price > 0)) throw new Error('Enter a valid price');
      if (price === item.unit_price) { editing = null; return render(); }
      if (!(await ask({ title: 'Change price?', message: `${item.name}: ${money(item.unit_price)} → ${money(price)} per ${item.unit}. Applies to new sales only.`, confirmText: 'Update price' }))) return;
      const r = await api('PUT', `/items/${encodeURIComponent(item.code)}/price`, { price });
      all = all.map((i) => (i.code === r.code ? r : i));
      editing = null;
      toast(`${r.name} is now ${money(r.unit_price)}`);
      render();
    }
  });
  render();
}

// ---------- manager: sales statistics ----------
function reportView() {
  const presets = [['Today', 0, 0], ['Yesterday', -1, -1], ['Last 7 days', -6, 0], ['This month', 'month', 0]];
  app.innerHTML = pageHead('Sales Statistics', 'Quantity sold, revenue and profit for any day or period.') + `
    <form class="card no-print" id="f">
      <div class="chips" style="margin-bottom:14px">${presets.map(([l], i) => `<button type="button" class="chip" data-p="${i}">${l}</button>`).join('')}</div>
      <div class="field-row">
        <div class="grow"><label for="code">Item code (or "all")</label><input id="code" value="all" required></div>
        <div class="grow"><label for="from">From</label><input id="from" type="date" value="${isoDate()}" required></div>
        <div class="grow"><label for="to">To</label><input id="to" type="date" value="${isoDate()}" required></div>
        <button class="btn lg">Generate</button>
      </div>
    </form>
    <div id="out" style="margin-top:18px"></div>`;

  const run = guard(async () => {
    const q = new URLSearchParams({ code: $('#code').value.trim() || 'all', from: $('#from').value, to: $('#to').value });
    const r = await api('GET', '/reports/sales?' + q);
    const margin = r.totals.revenueRealized ? (r.totals.profit / r.totals.revenueRealized) * 100 : 0;
    $('#out').innerHTML = `
      <div class="stats no-print">
        <div class="stat"><span>Items sold</span><strong>${r.stats.length}</strong></div>
        <div class="stat"><span>Price realized</span><strong>${money(r.totals.revenueRealized)}</strong></div>
        <div class="stat good"><span>Profit</span><strong>${money(r.totals.profit)}</strong></div>
        <div class="stat"><span>Profit margin</span><strong>${margin.toFixed(1)}%</strong></div>
      </div>
      <div class="card printable">
        <div class="card-title">Sales report · ${esc(r.from)} to ${esc(r.to)}
          <button class="btn ghost sm no-print" onclick="window.print()">${icon('print', 16)} Print</button></div>
        ${r.stats.length ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Qty sold</th><th class="num">Price realized</th><th class="num">Profit</th></tr></thead><tbody>
          ${r.stats.map((s) => `<tr><td>${esc(s.name)}<span class="sub">#${esc(s.itemCode)}</span></td><td class="num">${num(s.quantitySold)} ${esc(s.unit)}</td><td class="num">${money(s.revenueRealized)}</td><td class="num">${money(s.profit)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="2">Total</td><td class="num">${money(r.totals.revenueRealized)}</td><td class="num">${money(r.totals.profit)}</td></tr></tfoot></table></div>`
          : empty('report', 'No sales in this period', 'Try a different date range or item.')}
      </div>`;
  });
  $('#f').onsubmit = (e) => { e.preventDefault(); run(); };
  app.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => {
    const [, a, z] = presets[b.dataset.p];
    const d = new Date();
    $('#from').value = a === 'month' ? isoDate(1 - d.getDate()) : isoDate(a);
    $('#to').value = isoDate(z);
    run();
  }));
  run();
}

boot();
