// The app's functions a screen's CONTROLS name — a list's rows, a cell's hover
// box, a button's press — against a real Postgres, through the routes.

var { test, before, after } = require('node:test');
var assert = require('node:assert/strict');
var http = require('node:http');
var express = require('express');
var knexLib = require('knex');
var actions = require('@xeplr/actions');
var { registerMTs, runWithMt } = require('@xeplr/db');
var factory = require('..');
var applyMigrations = require('./applyMigrations');

var DB = 'xeplr_factory_functions_' + process.pid;
var admin, knex, server, base, model, skip = null;
var seen = [];

async function call(method, url, body, company) {
  var res = await fetch(base + url, {
    method: method,
    headers: Object.assign({ 'x-company-id': company || 'c1' }, body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

var STATUSES = [{ value: 'ordered', label: 'Ordered' }, { value: 'packed', label: 'Packed' }, { value: 'shipped', label: 'Shipped' }];

function registerAll() {
  actions.clear();
  // A list's rows: this company's orders, searched and filtered, with counts.
  actions.register({
    name: 'orderList', event: 'listRows', description: 'Orders, most urgent first',
    execute: async function(ctx) {
      seen.push(['orderList', ctx.query.q, ctx.query.filter, ctx.user && ctx.user.id]);
      if (ctx.query.kpi || ctx.query.from || ctx.query.to) seen.push(['dashboard', ctx.query.kpi, ctx.query.from, ctx.query.to]);
      var all = await ctx.db('orders').select('id', 'name', 'customStatus').orderBy('name');
      var shown = all.filter(function(o) { return !ctx.query.q || o.name.indexOf(ctx.query.q) !== -1; });
      var counts = { all: shown.length, packed: shown.filter(function(o) { return o.customStatus === 'packed'; }).length };
      var rows = ctx.query.filter === 'packed' ? shown.filter(function(o) { return o.customStatus === 'packed'; }) : shown;
      if (ctx.query.kpi === 'packed') rows = rows.filter(function(o) { return o.customStatus === 'packed'; });
      return { rows: rows.map(function(o) { return { id: o.id, orderNumber: '#' + o.name, customStatus: o.customStatus }; }), counts: counts, kpis: { packed: counts.packed, total: counts.all } };
    }
  });
  actions.register({
    name: 'orderActivity', event: 'rowDetails',
    execute: function(ctx) { return [{ text: 'Status set for ' + ctx.id, sub: ctx.column.label }]; }
  });
  actions.register({
    name: 'setOrderStatus', event: 'button', description: 'Sets the order status',
    inputSchema: [{ name: 'status', type: 'string', required: true, options: STATUSES }, { name: 'note', type: 'string' },
      { name: 'lengthIn', type: 'number' }, { name: 'weightKg', type: 'number' }],
    execute: async function(arg) {
      var s = arg.system;
      if (arg.input.lengthIn !== undefined) seen.push(['size', arg.input.lengthIn, arg.input.weightKg, arg.input.status]);
      seen.push(['setOrderStatus', arg.input.status, arg.input.note || null, s.record.name, s.user.id]);
      if (arg.input.note === 'refuse') s.reject('Not today', { field: 'note' });
      await s.db('orders').where('id', s.id).update({ customStatus: arg.input.status });
      return { message: 'Order ' + s.record.name + ' is now ' + arg.input.status };
    }
  });
  actions.register({ name: 'tellHR', event: 'afterSave', execute: function() {} });
}

before(async function() {
  admin = knexLib({ client: 'pg', connection: { database: 'postgres' } });
  try { await admin.raw('SELECT 1'); } catch (err) { skip = 'no Postgres available (' + err.message + ')'; return; }
  await admin.raw('DROP DATABASE IF EXISTS ??', [DB]);
  await admin.raw('CREATE DATABASE ??', [DB]);
  knex = knexLib({ client: 'pg', connection: { database: DB } });
  await applyMigrations(knex);
  registerMTs({ l1: { name: 'companyId', header: 'x-company-id' } });
  model = await import('@xeplr/ui-factory/model');
  registerAll();
  await factory.init({ knex: knex });

  var app = express();
  app.use(function(req, res, next) { req.user = { id: 'u1' }; runWithMt({ mtId1: req.headers['x-company-id'] }, next); });
  app.use(factory.router());
  server = http.createServer(app);
  await new Promise(function(r) { server.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async function() {
  if (server) await new Promise(function(r) { server.close(r); });
  if (knex) await knex.destroy();
  if (admin && !skip) await admin.raw('DROP DATABASE IF EXISTS ??', [DB]);
  if (admin) await admin.destroy();
});

/** Draft + publish, for both companies (a screen is each company's own); answering the first. */
async function publish(doc) {
  var first;
  for (var company of ['c1', 'c2']) {
    await call('PUT', '/factory/screens/' + doc.id + '/draft', { document: doc }, company);
    var res = await call('POST', '/factory/screens/' + doc.id + '/publish', null, company);
    if (!first) first = res;
  }
  return first;
}

function withNode(doc, type, props) {
  var added = model.addControl(doc, type, { props: props });
  return { doc: added.document, id: added.node.id };
}

var PACKED = { id: 'packed', label: 'Packed', action: 'setOrderStatus', params: { status: 'packed' }, ask: { note: 'Reason (optional)' },
  disabledWhen: [{ field: 'customStatus', op: 'eq', value: 'packed' }] };
var SHIPPED = { id: 'shipped', label: 'Shipped', action: 'setOrderStatus', params: { status: 'shipped' },
  when: [{ field: 'customStatus', op: 'eq', value: 'packed' }] };

test('functions named by controls', async function(t) {
  if (skip) { t.skip(skip); return; }
  var order = model.screensFromSpec({ entity: 'order', fields: [{ label: 'Name', required: true }, { label: 'Custom status' }] });
  var ids = {};
  var board, listId;

  await t.test('the order form publishes, and has records in two companies', async function() {
    for (var doc of [order.edit, order.list]) {
      var res = await publish(doc);
      assert.equal(res.status, 200, doc.id + ': ' + res.body.message);
    }
    for (var o of [['GA1', 'ordered', 'c1'], ['GA2', 'packed', 'c1'], ['GB1', 'ordered', 'c2']]) {
      var saved = await call('POST', '/factory/records/order_edit/save', { values: { name: o[0], customStatus: o[1] } }, o[2]);
      assert.equal(saved.status, 200, saved.body.message);
      ids[o[0]] = saved.body.dataArray[0].id;
    }
  });

  await t.test('a list fed by a function nobody registered is refused at publish, saying where', async function() {
    var made = withNode(model.createScreen({ id: 'orders_board', name: 'Orders' }), 'list', {
      rowsFrom: 'noSuchList', actions: [], filters: [{ key: 'all', label: 'All' }, { key: 'packed', label: 'Packed' }],
      search: { placeholder: 'Search' },
      columns: [{ field: 'orderNumber', label: 'Order' }, { field: 'customStatus', label: 'Activity', display: 'activity', details: 'orderActivity' }]
    });
    var res = await publish(made.doc);
    assert.equal(res.status, 422);
    assert.match(res.body.message, /nodes\[0\]\.props\.rowsFrom: "noSuchList" is not a registered function/);
    board = Object.assign({}, made.doc, { nodes: made.doc.nodes.map(function(n) { return Object.assign({}, n, { props: Object.assign({}, n.props, { rowsFrom: 'orderList' }) }); }) });
    listId = made.id;
    res = await publish(board);
    assert.equal(res.status, 200, res.body.message);
  });

  await t.test('GET /factory/rows: the function\'s rows and counts, this company only', async function() {
    var res = await call('GET', '/factory/rows/orders_board');
    assert.equal(res.status, 200, res.body.message);
    var out = res.body.dataArray[0];
    assert.deepEqual(out.rows.map(function(r) { return r.orderNumber; }), ['#GA1', '#GA2']);
    assert.deepEqual(out.counts, { all: 2, packed: 1 });
    assert.equal(out.filter, 'all', 'no chip asked for: the first');
    assert.deepEqual(seen.pop(), ['orderList', '', 'all', 'u1']);
    var other = await call('GET', '/factory/rows/orders_board', null, 'c2');
    assert.deepEqual(other.body.dataArray[0].rows.map(function(r) { return r.orderNumber; }), ['#GB1']);
  });

  await t.test('...the search and the chip reach the function', async function() {
    var res = await call('GET', '/factory/rows/orders_board?node=' + listId + '&q=GA&filter=packed');
    assert.deepEqual(res.body.dataArray[0].rows.map(function(r) { return r.orderNumber; }), ['#GA2']);
    assert.deepEqual(seen.pop(), ['orderList', 'GA', 'packed', 'u1']);
  });

  await t.test('...a chip the list does not have is the first chip, not an error', async function() {
    var res = await call('GET', '/factory/rows/orders_board?filter=deleted');
    assert.equal(res.body.dataArray[0].filter, 'all');
  });

  await t.test('...a list that is not fed by a function is not asked', async function() {
    var res = await call('GET', '/factory/rows/order_list');
    assert.equal(res.status, 404);
    assert.match(res.body.message, /no list whose rows come from a function/);
  });

  await t.test('GET /factory/rows/:key/details: the column\'s hover box for one row', async function() {
    var res = await call('GET', '/factory/rows/orders_board/details?column=customStatus&id=' + ids.GA1);
    assert.equal(res.status, 200, res.body.message);
    assert.deepEqual(res.body.dataArray, [{ text: 'Status set for ' + ids.GA1, sub: 'Activity' }]);
    var none = await call('GET', '/factory/rows/orders_board/details?column=orderNumber&id=' + ids.GA1);
    assert.equal(none.status, 404, 'a column with no hover box');
  });

  var actionsDoc;
  await t.test('a button whose parameters its function does not take is refused at publish', async function() {
    var made = withNode(model.createScreen({ id: 'order_actions', name: 'Order actions', source: 'orders' }), 'buttons', {
      buttons: [Object.assign({}, PACKED, { params: { status: 'lost' } }), SHIPPED]
    });
    var res = await publish(made.doc);
    assert.equal(res.status, 422);
    assert.match(res.body.message, /button "Packed": "setOrderStatus" "status" must be one of: ordered, packed, shipped/);
    actionsDoc = Object.assign({}, made.doc, { nodes: [Object.assign({}, made.doc.nodes[0], { props: Object.assign({}, made.doc.nodes[0].props, { buttons: [PACKED, SHIPPED] }) })] });
    res = await publish(actionsDoc);
    assert.equal(res.status, 200, res.body.message);
  });

  await t.test('GET /factory/functions says what a button\'s function takes', async function() {
    var res = await call('GET', '/factory/functions');
    var fn = res.body.dataArray.find(function(f) { return f.name === 'setOrderStatus'; });
    assert.deepEqual(fn.inputSchema, [{ name: 'status', type: 'string', required: true, options: STATUSES }, { name: 'note', type: 'string', required: false },
      { name: 'lengthIn', type: 'number', required: false }, { name: 'weightKg', type: 'number', required: false }]);
  });

  await t.test('POST /factory/buttons: the document\'s parameters, the person\'s note, the record and the caller', async function() {
    var res = await call('POST', '/factory/buttons/order_actions/packed', { id: ids.GA1, note: ' courier late ' });
    assert.equal(res.status, 200, res.body.message);
    assert.equal(res.body.dataArray[0].message, 'Order GA1 is now packed');
    assert.deepEqual(seen.pop(), ['setOrderStatus', 'packed', 'courier late', 'GA1', 'u1']);
    var row = await knex('orders').where('id', ids.GA1).first();
    assert.equal(row.customStatus, 'packed');
  });

  await t.test('...parameters in the request are ignored: the screen says what the button does', async function() {
    await knex('orders').where('id', ids.GA1).update({ customStatus: 'ordered' });
    var res = await call('POST', '/factory/buttons/order_actions/packed', { id: ids.GA1, params: { status: 'shipped' }, status: 'shipped' });
    assert.equal(res.status, 200, res.body.message);
    assert.equal((await knex('orders').where('id', ids.GA1).first()).customStatus, 'packed');
    seen.pop();
  });

  await t.test('...a greyed-out button cannot be pressed by sending the request', async function() {
    var res = await call('POST', '/factory/buttons/order_actions/packed', { id: ids.GA2 });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /"Packed" does not apply to this record now/);
  });

  await t.test('...nor a hidden one', async function() {
    var res = await call('POST', '/factory/buttons/order_actions/shipped', { id: ids.GB1 }, 'c2');
    assert.equal(res.status, 409);
  });

  await t.test('...another company\'s record is not found', async function() {
    var res = await call('POST', '/factory/buttons/order_actions/shipped', { id: ids.GA2 }, 'c2');
    assert.equal(res.status, 404);
    assert.equal((await knex('orders').where('id', ids.GA2).first()).customStatus, 'packed', 'nothing changed');
  });

  await t.test('...a button the screen does not have is not found', async function() {
    var res = await call('POST', '/factory/buttons/order_actions/delete-all', { id: ids.GA1 });
    assert.equal(res.status, 404);
    assert.match(res.body.message, /no button "delete-all"/);
  });

  await t.test('...a refusal from the function is shown like a field\'s', async function() {
    var res = await call('POST', '/factory/buttons/order_actions/shipped', { id: ids.GA2, note: 'refuse' });
    assert.equal(res.status, 200, 'shipped asks for no note, so none is sent: ' + res.body.message);
    assert.deepEqual(seen.pop(), ['setOrderStatus', 'shipped', null, 'GA2', 'u1']);
    await knex('orders').where('id', ids.GA1).update({ customStatus: 'ordered' });
    var refused = await call('POST', '/factory/buttons/order_actions/packed', { id: ids.GA1, note: 'refuse' });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.message, 'Not today');
  });

  await t.test('...a note is text, and not a long one', async function() {
    var res = await call('POST', '/factory/buttons/order_actions/packed', { id: ids.GA1, note: 'x'.repeat(1001) });
    assert.equal(res.status, 400);
    res = await call('POST', '/factory/buttons/order_actions/packed', { id: ids.GA1, note: { $gt: '' } });
    assert.equal(res.status, 400);
  });

  await t.test('a dashboard: the KPI card and the range reach the function, and its counts come back', async function() {
    var dash = withNode(model.createScreen({ id: 'orders_dash', name: 'Orders' }), 'list', {
      rowsFrom: 'orderList', actions: [], kpis: [{ key: 'packed', label: 'Packed' }, { key: 'total', label: 'Total' }],
      dateRange: { label: 'Placed', default: 'last30' }, columns: [{ field: 'orderNumber', label: 'Order' }]
    });
    var pub = await publish(dash.doc);
    assert.equal(pub.status, 200, pub.body.message);
    var res = await call('GET', '/factory/rows/orders_dash?kpi=packed&from=2026-10-07&to=2026-11-05');
    assert.equal(res.status, 200, res.body.message);
    var out = res.body.dataArray[0];
    assert.deepEqual(seen.pop(), ['dashboard', 'packed', '2026-10-07', '2026-11-05']);
    seen.pop();
    var packedNow = (await knex('orders').where({ mtId1: 'c1', customStatus: 'packed' }).orderBy('name').select('name')).map(function(r) { return '#' + r.name; });
    assert.deepEqual(out.kpis, { packed: packedNow.length, total: 2 });
    assert.deepEqual(out.rows.map(function(r) { return r.orderNumber; }), packedNow);
    assert.equal(out.kpi, 'packed');
  });

  await t.test('...a card the list does not have is none; a range that is not two days is refused', async function() {
    var res = await call('GET', '/factory/rows/orders_dash?kpi=everything');
    assert.equal(res.body.dataArray[0].kpi, '');
    seen.pop();
    for (var q of ['from=yesterday', 'from=2026-02-30', 'from=2026-11-05&to=2026-11-01']) {
      res = await call('GET', '/factory/rows/orders_dash?' + q);
      assert.equal(res.status, 400, q);
    }
    res = await call('GET', '/factory/rows/orders_board?from=2026-11-01');
    assert.equal(res.status, 400, 'a list with no date range');
    assert.match(res.body.message, /no date range/);
  });

  await t.test('a button that asks for values: checked as the dialog checks them, typed, and handed to the function', async function() {
    var SIZE = [{ name: 'lengthIn', label: 'Length', type: 'number', unit: 'in', required: true, min: 0.1 },
      { name: 'weightKg', label: 'Weight', type: 'number', unit: 'kg', required: true, min: 0.01 }];
    var sized = Object.assign({}, PACKED, { id: 'packed-sized', ask: { fields: SIZE } });
    var made = withNode(model.createScreen({ id: 'order_size', name: 'Order size', source: 'orders' }), 'buttons', { buttons: [sized] });
    var res = await publish(made.doc);
    assert.equal(res.status, 200, res.body.message);
    await knex('orders').where('id', ids.GA1).update({ customStatus: 'ordered' });

    res = await call('POST', '/factory/buttons/order_size/packed-sized', { id: ids.GA1, values: { lengthIn: '', weightKg: 'heavy' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Length is required; Weight must be a number');
    assert.deepEqual(res.body.error.fields.map(function(f) { return f.field; }), ['lengthIn', 'weightKg']);
    assert.equal((await knex('orders').where('id', ids.GA1).first()).customStatus, 'ordered', 'nothing ran');

    res = await call('POST', '/factory/buttons/order_size/packed-sized', { id: ids.GA1, values: { lengthIn: '12.5', weightKg: '1.2', status: 'shipped' } });
    assert.equal(res.status, 200, res.body.message);
    seen.pop();
    assert.deepEqual(seen.pop(), ['size', 12.5, 1.2, 'packed'], 'numbers, and the screen\'s status — not the one sent');
    await knex('orders').where('id', ids.GA1).update({ customStatus: 'ordered' });
  });

  await t.test('...a field its function does not take is refused at publish', async function() {
    var made = withNode(model.createScreen({ id: 'order_size2', name: 'Order size', source: 'orders' }), 'buttons', {
      buttons: [Object.assign({}, PACKED, { id: 'p2', ask: { fields: [{ name: 'heightIn', label: 'Height', type: 'number' }] } })]
    });
    var res = await publish(made.doc);
    assert.equal(res.status, 422);
    assert.match(res.body.message, /asks for "heightIn", but takes no "heightIn"/);
  });

  await t.test('...a function that stops being registered fails by name', async function() {
    actions.clear();
    var res = await call('POST', '/factory/buttons/order_actions/packed', { id: ids.GA1 });
    assert.equal(res.status, 500);
    res = await call('GET', '/factory/rows/orders_board');
    assert.equal(res.status, 500);
    registerAll();
  });
});
