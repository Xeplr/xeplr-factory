// A TAG FIELD (several values as chips, no column) and a CHECKLIST in a
// button's popup (entries worked out for the record), and the caller's access
// on every function's context — against a real Postgres, through the routes.

var { test, before, after } = require('node:test');
var assert = require('node:assert/strict');
var http = require('node:http');
var express = require('express');
var knexLib = require('knex');
var actions = require('@xeplr/actions');
var { registerMTs, runWithMt } = require('@xeplr/db');
var factory = require('..');
var applyMigrations = require('./applyMigrations');

var DB = 'xeplr_factory_tags_' + process.pid;
var admin, knex, server, base, model, skip = null;
var seen = [];
var ADMIN = { roles: ['Super Admin'], apis: ['Press factory button'] };

async function call(method, url, body, access) {
  var res = await fetch(base + url, {
    method: method,
    headers: Object.assign({ 'x-company-id': 'c1' }, access ? { 'x-access': JSON.stringify(access) } : {}, body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

function registerAll() {
  actions.clear();
  actions.register({
    name: 'batchBefore', event: 'beforeSave',
    execute: function(ctx) { seen.push(['before', ctx.values.addItems, ctx.access]); return ctx.values; }
  });
  // What an app does with the chips: a row each, in a table of its own.
  actions.register({
    name: 'batchAfter', event: 'afterSave',
    execute: async function(ctx) {
      seen.push(['after', ctx.values.addItems, ctx.access && ctx.access.roles]);
      for (var t of ctx.values.addItems || []) {
        await knex('items').insert({ id: 'i' + Math.random().toString(36).slice(2, 10), name: t.value, qty: t.qty, batchId: ctx.result.id, status: 'out', isActive: true, mtId1: 'c1' });
      }
    }
  });
  actions.register({
    name: 'itemsOut', event: 'buttonOptions',
    execute: async function(ctx) {
      seen.push(['itemsOut', ctx.id, ctx.field.name, ctx.record.name, ctx.access && ctx.access.roles, Object.isFrozen(ctx.access)]);
      var rows = await knex('items').where({ batchId: ctx.id, status: 'out' }).orderBy('name');
      return rows.map(function(r) { return { id: r.id, label: r.name, sub: '× ' + r.qty } }).concat([{ label: 'no id' }]);
    }
  });
  actions.register({
    name: 'receiveItems', event: 'button',
    inputSchema: [{ name: 'back', type: 'array' }, { name: 'broken', type: 'array' }, { name: 'note', type: 'string' }],
    execute: async function(arg) {
      seen.push(['receiveItems', arg.input.back, arg.input.broken, arg.system.access && arg.system.access.roles]);
      if (!(arg.system.access && arg.system.access.roles.indexOf('Super Admin') !== -1) && arg.input.note === 'admins only') arg.system.reject('Only an admin may');
      await knex('items').whereIn('id', arg.input.back || []).update({ status: 'back' });
      await knex('items').whereIn('id', arg.input.broken || []).update({ status: 'broken' });
      return { message: 'Received ' + ((arg.input.back || []).length + (arg.input.broken || []).length) };
    }
  });
  actions.register({ name: 'batchRows', event: 'listRows', execute: function(ctx) { seen.push(['rows', ctx.access]); return []; } });
  actions.register({ name: 'itemSuggestions', event: 'suggest', execute: function(ctx) { seen.push(['suggest', ctx.access && ctx.access.roles]); return [{ value: 'Horse' }]; } });
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
  // Stands in for the auth gate: req.access from /auth/api/me, when there is one.
  app.use(function(req, res, next) {
    req.user = { id: 'u1' };
    if (req.headers['x-access']) req.access = JSON.parse(req.headers['x-access']);
    runWithMt({ mtId1: req.headers['x-company-id'] }, next);
  });
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

async function publish(doc) {
  await call('PUT', '/factory/screens/' + doc.id + '/draft', { document: doc });
  return call('POST', '/factory/screens/' + doc.id + '/publish');
}

test('tags and checklists', async function(t) {
  if (skip) { t.skip(skip); return; }
  var batchId, horse, vase;

  await t.test('a tag field publishes with no column; the other fields are columns', async function() {
    var items = model.screensFromSpec({ entity: 'item', fields: [{ label: 'Name', required: true }, { label: 'Qty', type: 'number' }, { label: 'Batch id' }, { label: 'Status' }] });
    for (var doc of [items.edit, items.list]) assert.equal((await publish(doc)).status, 200);
    var batch = model.screensFromSpec({ entity: 'batch', fields: [
      { label: 'Name', required: true },
      { label: 'Add items', name: 'addItems', type: 'autocomplete', suggestFrom: 'itemSuggestions', multiple: true, quantity: true, maxTags: 3 }
    ] });
    var edit = Object.assign({}, batch.edit, { events: { beforeSave: 'batchBefore', afterSave: 'batchAfter' } });
    for (var d of [edit, batch.list]) { var res = await publish(d); assert.equal(res.status, 200, res.body.message); }
    var cols = (await knex('information_schema.columns').where({ table_name: 'batches' }).pluck('column_name'));
    assert.ok(cols.indexOf('name') !== -1 && cols.indexOf('addItems') === -1, cols.join(','));
  });

  await t.test('saving: the chips, checked and clean, reach beforeSave and afterSave — and are never written', async function() {
    var res = await call('POST', '/factory/records/batch_edit/save', { values: { name: 'To the showroom', addItems: [
      { value: ' Silver Horse ', label: 'Silver Horse', qty: '2', fill: { sku: 'GAD631' } }, { value: 'Vase' }
    ] } }, ADMIN);
    assert.equal(res.status, 200, res.body.message);
    batchId = res.body.dataArray[0].id;
    assert.equal(res.body.dataArray[0].addItems, undefined, 'no column, so not on the saved record');
    var after = seen.pop(), before = seen.pop();
    assert.deepEqual(before[1], [{ value: 'Silver Horse', label: 'Silver Horse', fill: { sku: 'GAD631' }, qty: 2 }, { value: 'Vase', label: 'Vase', qty: 1 }]);
    assert.deepEqual(before[2], ADMIN, 'the caller\'s access on a screen event');
    assert.deepEqual(after[1], before[1]);
    assert.deepEqual(after[2], ['Super Admin']);
    var rows = await knex('items').where({ batchId: batchId }).orderBy('name');
    assert.deepEqual(rows.map(function(r) { return [r.name, Number(r.qty)]; }), [['Silver Horse', 2], ['Vase', 1]]);
    horse = rows[0].id; vase = rows[1].id;
  });

  await t.test('...a list that is not chips, a qty that is no whole number or too many chips: 400 on that field, nothing saved', async function() {
    for (var bad of ['Horse', [{ value: 'Horse', qty: 0 }], [{ value: 'a' }, { value: 'b' }, { value: 'c' }, { value: 'd' }], [{ value: '' }], [{ value: 'a', fill: { x: { y: 1 } } }]]) {
      var res = await call('POST', '/factory/records/batch_edit/save', { values: { name: 'Bad', addItems: bad } });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.body.error.fields[0].field, 'addItems');
    }
    assert.equal((await knex('batches').where({ name: 'Bad' })).length, 0);
    var none = await call('POST', '/factory/records/batch_edit/save', { values: { name: 'No access' } });
    assert.equal(none.status, 200, none.body.message);
    var b = seen.pop(); seen.pop();
    assert.equal(b[2], null, 'no req.access: null');
  });

  await t.test('a checklist whose function is written for another event is refused at publish', async function() {
    var made = model.addControl(model.createScreen({ id: 'batch_actions', name: 'Batch', source: 'batches' }), 'buttons', { props: { buttons: [{
      id: 'receive', label: 'Receive', action: 'receiveItems',
      ask: { note: 'Note', fields: [{ name: 'back', label: 'Came back', type: 'checklist', optionsFrom: 'batchRows' }, { name: 'broken', label: 'Broken', type: 'checklist', optionsFrom: 'itemsOut' }] }
    }] } });
    var res = await publish(made.document);
    assert.equal(res.status, 422);
    assert.match(res.body.message, /optionsFrom: "batchRows" is written for "listRows", not "buttonOptions"/);
    var good = JSON.parse(JSON.stringify(made.document));
    good.nodes[0].props.buttons[0].ask.fields[0].optionsFrom = 'itemsOut';
    res = await publish(good);
    assert.equal(res.status, 200, res.body.message);
  });

  await t.test('GET /factory/buttons/:key/:button/options: the entries for this record, cleaned; the caller\'s access frozen', async function() {
    var res = await call('GET', '/factory/buttons/batch_actions/receive/options?id=' + batchId + '&field=back', null, ADMIN);
    assert.equal(res.status, 200, res.body.message);
    assert.deepEqual(res.body.dataArray, [{ id: horse, label: 'Silver Horse', sub: '× 2' }, { id: vase, label: 'Vase', sub: '× 1' }], 'one without an id dropped');
    assert.deepEqual(seen.pop(), ['itemsOut', batchId, 'back', 'To the showroom', ['Super Admin'], true]);
    res = await call('GET', '/factory/buttons/batch_actions/receive/options?id=' + batchId + '&field=nope');
    assert.equal(res.status, 404);
    assert.match(res.body.message, /no checklist "nope"/);
    res = await call('GET', '/factory/buttons/batch_actions/receive/options?id=nope&field=back');
    assert.equal(res.status, 404);
    res = await call('GET', '/factory/buttons/batch_actions/receive/options?field=back');
    assert.equal(res.status, 400);
  });

  await t.test('pressing: an id the function does not offer is refused; the ticked ids reach the function', async function() {
    var res = await call('POST', '/factory/buttons/batch_actions/receive', { id: batchId, values: { back: ['made-up'] } });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /no longer offered/);
    assert.equal(res.body.error.fields[0].field, 'back');
    seen.length = 0;
    res = await call('POST', '/factory/buttons/batch_actions/receive', { id: batchId, values: { back: [horse], broken: [] } }, ADMIN);
    assert.equal(res.status, 200, res.body.message);
    assert.deepEqual(seen.pop(), ['receiveItems', [horse], [], ['Super Admin']], 'system.access too');
    assert.equal((await knex('items').where('id', horse).first()).status, 'back');
    res = await call('GET', '/factory/buttons/batch_actions/receive/options?id=' + batchId + '&field=back');
    assert.deepEqual(res.body.dataArray.map(function(o) { return o.id; }), [vase], 'back already: no longer offered');
    res = await call('POST', '/factory/buttons/batch_actions/receive', { id: batchId, values: { broken: [horse] } });
    assert.equal(res.status, 400, 'nor can it be ticked again by sending the request');
    res = await call('POST', '/factory/buttons/batch_actions/receive', { id: batchId, note: 'admins only', values: { back: [vase] } }, { roles: ['Viewer'], apis: [] });
    assert.equal(res.status, 422, 'a function can refuse by the caller\'s roles');
  });

  await t.test('rows and suggestions get the caller\'s access too', async function() {
    var board = model.addControl(model.createScreen({ id: 'batch_board', name: 'Batches' }), 'list', { props: { rowsFrom: 'batchRows', actions: [], columns: [{ field: 'name', label: 'Name' }] } });
    assert.equal((await publish(board.document)).status, 200);
    await call('GET', '/factory/rows/batch_board', null, ADMIN);
    assert.deepEqual(seen.pop(), ['rows', ADMIN]);
    var node = (await call('GET', '/factory/screens/batch_edit')).body.dataArray[0].document.nodes.find(function(n) { return n.type === 'autocomplete'; });
    var res = await call('GET', '/factory/suggest/batch_edit?node=' + node.id + '&q=hor', null, ADMIN);
    assert.equal(res.status, 200, res.body.message);
    assert.deepEqual(seen.pop(), ['suggest', ['Super Admin']]);
  });
});
