// BLACK-BOX: STATE TRANSITION testing, derived from the state chart diagram.
//
// States (persistent, observable):  initiated, adding_items, bill_printed, completed, cancelled
// ("billed" and "inventory_updated" from the diagram happen atomically inside checkout, so they are
//  never observable; checkout goes adding_items -> bill_printed.)
// Events: add item, remove last item, checkout (finalize), pay, cancel, remove item (line must exist)
//
// Every (state, event) pair of the matrix is exercised: valid transitions must land in the expected
// state, invalid ones must be rejected with 400/404 and must not change the state.
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

describe('black box: transaction state machine', () => {
  let t;
  before(async () => { await h.start(); });
  beforeEach(async () => { h.reset(); t = await h.tokens(); });
  after(() => h.cleanup());

  // Bring a fresh transaction into the requested state. Returns { id, lineId }.
  async function inState(state) {
    const id = (await h.call('POST', '/transactions', t.clerk)).data.id;
    let lineId = null;
    if (state === 'initiated') return { id, lineId };
    lineId = (await h.call('POST', `/transactions/${id}/items`, t.clerk, { code: '2001', qty: 1 })).data.items[0].id;
    if (state === 'adding_items') return { id, lineId };
    if (state === 'cancelled') { await h.call('POST', `/transactions/${id}/cancel`, t.clerk); return { id, lineId }; }
    await h.call('POST', `/transactions/${id}/checkout`, t.clerk);
    if (state === 'bill_printed') return { id, lineId };
    await h.call('POST', `/transactions/${id}/pay`, t.clerk);
    return { id, lineId };
  }

  const events = {
    add: (s) => h.call('POST', `/transactions/${s.id}/items`, t.clerk, { code: '2002', qty: 1 }),
    remove: (s) => h.call('DELETE', `/transactions/${s.id}/items/${s.lineId ?? 999999}`, t.clerk),
    checkout: (s) => h.call('POST', `/transactions/${s.id}/checkout`, t.clerk),
    pay: (s) => h.call('POST', `/transactions/${s.id}/pay`, t.clerk),
    cancel: (s) => h.call('POST', `/transactions/${s.id}/cancel`, t.clerk),
  };

  // [state, event] -> [expected HTTP status, expected state afterwards]
  const matrix = {
    initiated:    { add: [200, 'adding_items'], remove: [404, 'initiated'],      checkout: [400, 'initiated'],   pay: [400, 'initiated'],     cancel: [200, 'cancelled'] },
    adding_items: { add: [200, 'adding_items'], remove: [200, 'initiated'],      checkout: [200, 'bill_printed'], pay: [400, 'adding_items'], cancel: [200, 'cancelled'] },
    bill_printed: { add: [400, 'bill_printed'], remove: [400, 'bill_printed'],   checkout: [400, 'bill_printed'], pay: [200, 'completed'],    cancel: [400, 'bill_printed'] },
    completed:    { add: [400, 'completed'],    remove: [400, 'completed'],      checkout: [400, 'completed'],    pay: [400, 'completed'],     cancel: [400, 'completed'] },
    cancelled:    { add: [400, 'cancelled'],    remove: [400, 'cancelled'],      checkout: [400, 'cancelled'],    pay: [400, 'cancelled'],     cancel: [400, 'cancelled'] },
  };

  for (const [state, row] of Object.entries(matrix)) {
    for (const [event, [status, next]] of Object.entries(row)) {
      it(`${state} --${event}--> ${status === 200 ? next : `rejected (${status}), stays ${next}`}`, async () => {
        const s = await inState(state);
        const r = await events[event](s);
        assert.equal(r.status, status, JSON.stringify(r.data));
        assert.equal(h.statusOf(s.id), next);
      });
    }
  }

  it('full happy path visits initiated -> adding_items -> bill_printed -> completed', async () => {
    const seen = [];
    const id = (await h.call('POST', '/transactions', t.clerk)).data.id;
    seen.push(h.statusOf(id));
    await h.call('POST', `/transactions/${id}/items`, t.clerk, { code: '2001', qty: 1 });
    seen.push(h.statusOf(id));
    await h.call('POST', `/transactions/${id}/checkout`, t.clerk);
    seen.push(h.statusOf(id));
    await h.call('POST', `/transactions/${id}/pay`, t.clerk);
    seen.push(h.statusOf(id));
    assert.deepEqual(seen, ['initiated', 'adding_items', 'bill_printed', 'completed']);
  });

  it('remove one of two lines keeps the sale in adding_items (self-loop)', async () => {
    const id = (await h.call('POST', '/transactions', t.clerk)).data.id;
    const a = (await h.call('POST', `/transactions/${id}/items`, t.clerk, { code: '2001', qty: 1 })).data.items[0].id;
    await h.call('POST', `/transactions/${id}/items`, t.clerk, { code: '2002', qty: 1 });
    await h.call('DELETE', `/transactions/${id}/items/${a}`, t.clerk);
    assert.equal(h.statusOf(id), 'adding_items');
  });

  it('side effects follow the states: stock changes only at checkout, never on cancel', async () => {
    const open = await inState('adding_items');
    assert.equal(h.stockOf('2001'), 80, 'adding does not touch stock');
    await events.cancel(open);
    assert.equal(h.stockOf('2001'), 80, 'cancel does not touch stock');
    const billed = await inState('bill_printed');
    assert.equal(h.stockOf('2001'), 79, 'checkout decreases stock once');
    await events.pay(billed);
    assert.equal(h.stockOf('2001'), 79, 'pay does not touch stock again');
  });
});
