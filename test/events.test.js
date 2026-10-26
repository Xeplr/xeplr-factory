// A screen's EVENTS — the app's functions, registered with @xeplr/actions and
// picked by name in the screen — against a real Postgres, through the routes.

var { test, before, after } = require('node:test');
var assert = require('node:assert/strict');
var http = require('node:http');
var express = require('express');
var knexLib = require('knex');
var actions = require('@xeplr/actions');
var { registerMTs, runWithMt } = require('@xeplr/db');
var factory = require('..');
var { EVENT_KEYS } = require('../lib/hooks');
var applyMigrations = require('./applyMigrations');

var DB = 'xeplr_factory_events_' + process.pid;
var admin, knex, server, base, model, skip = null;
var calls = [];

async function call(method, url, body) {
  var res = await fetch(base + url, {
    method: method,
    headers: Object.assign({ 'x-company-id': 'c1' }, body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

function registerAll() {
  actions.clear();
  actions.register({
    name: 'cleanEmployee', event: 'beforeSave', description: 'Upper-cases the code; refuses one name',
    execute: function(ctx) {
      calls.push(['beforeSave', ctx.isNew, ctx.previous && ctx.previous.firstName]);
      if (ctx.values.firstName === 'Blocked') ctx.reject('This name is not allowed', { field: 'firstName' });
      return Object.assign({}, ctx.values, {
        employeeCode: ctx.values.employeeCode ? String(ctx.values.employeeCode).toUpperCase() : ctx.values.employeeCode,
        fullName: ctx.values.firstName + ' (' + ctx.values.employeeCode + ')'     // a column the form does not have
      });
    }
  });
  actions.register({
    name: 'tellHR', event: 'afterSave', description: 'Says a record was saved',
    execute: function(ctx) {
      calls.push(['afterSave', ctx.id, ctx.result.employeeCode]);
      if (ctx.values.firstName === 'AfterFails') throw new Error('mail server down');
      return { ignored: true };
    }
  });
  actions.register({ name: 'logFailure', event: 'onError', execute: function(ctx) { calls.push(['onError', ctx.op, ctx.error.message]); } });
  actions.register({
    name: 'hideHidden', event: 'beforeLoad',
    execute: function(ctx) { calls.push(['beforeLoad', ctx.many]); ctx.query.whereNot('employees.firstName', 'Hidden'); }
  });
  actions.register({
    name: 'keepProtected', event: 'beforeDelete',
    execute: function(ctx) { if (ctx.previous.firstName === 'Protected') ctx.reject('Protected employees cannot be deleted'); }
  });
  actions.register({ name: 'routeOnward', event: 'decide', execute: function() { return 'end_success'; } });
  actions.register({ name: 'sendEmail', execute: function() {} });   // a workflow step, not a screen function
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

test('events', async function(t) {
  if (skip) { t.skip(skip); return; }
  var employee = model.screensFromSpec({
    entity: 'employee',
    fields: [
      { label: 'First name', required: true },
      { label: 'Employee code', validation: { pattern: '^[A-Z]+-[0-9]+$', patternMessage: 'Codes look like ABC-1' } }
    ]
  });
  var EVENTS = { beforeLoad: 'hideHidden', beforeSave: 'cleanEmployee', afterSave: 'tellHR', beforeDelete: 'keepProtected', onError: 'logFailure' };
  var adaId;

  await t.test('the event names here and in @xeplr/ui-factory are the same list', function() {
    assert.deepEqual(EVENT_KEYS, model.SCREEN_EVENT_KEYS);
  });

  await t.test('1.x hook files stop startup, saying what replaced them', async function() {
    await assert.rejects(factory.init({ knex: knex, hooks: { employee_edit: { save: {} } } }), /hook files are gone.*@xeplr\/actions/);
    assert.throws(function() { factory.registerHooks('employee_edit', {}); }, /hook files are gone/);
    await factory.init({ knex: knex });
  });

  await t.test('GET /factory/functions lists the screen functions — names, events, descriptions, never code', async function() {
    var res = await call('GET', '/factory/functions');
    assert.equal(res.status, 200, res.body.message);
    var byName = Object.fromEntries(res.body.dataArray.map(function(f) { return [f.name, f]; }));
    assert.deepEqual(byName.cleanEmployee, { name: 'cleanEmployee', event: 'beforeSave', description: 'Upper-cases the code; refuses one name' });
    assert.equal(byName.routeOnward.event, 'decide', 'a flow\'s decide functions are listed too');
    assert.ok(!byName.sendEmail, 'a workflow step is not offered to a screen');
    assert.ok(res.body.dataArray.every(function(f) { return Object.keys(f).join() === 'name,event,description'; }));
  });

  await t.test('a screen naming a function nobody registered is refused at publish, by name', async function() {
    var doc = Object.assign({}, employee.edit, { events: { beforeSave: 'noSuchFunction', afterSave: 'cleanEmployee' } });
    await call('PUT', '/factory/screens/' + doc.id + '/draft', { document: doc });
    var res = await call('POST', '/factory/screens/' + doc.id + '/publish');
    assert.equal(res.status, 422);
    assert.match(res.body.message, /beforeSave: "noSuchFunction" is not a registered function/);
    assert.match(res.body.message, /afterSave: "cleanEmployee" is written for "beforeSave", not "afterSave"/);
    assert.equal((await knex.raw("select to_regclass('employees') as t")).rows[0].t, null, 'nothing was created');
  });

  await t.test('with its functions registered, it publishes', async function() {
    for (var doc of [Object.assign({}, employee.edit, { events: EVENTS }), employee.list]) {
      await call('PUT', '/factory/screens/' + doc.id + '/draft', { document: doc });
      var res = await call('POST', '/factory/screens/' + doc.id + '/publish');
      assert.equal(res.status, 200, doc.id + ': ' + res.body.message);
    }
    await knex.raw('ALTER TABLE employees ADD COLUMN "fullName" varchar(120), ADD COLUMN "salaryBand" varchar(10)');
  });

  await t.test('beforeSave changes the values, and the screen\'s rules check what it returns', async function() {
    calls = [];
    var res = await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'Ada', employeeCode: 'abc-1', salaryBand: 'X' } });
    assert.equal(res.status, 200, res.body.message);
    var row = res.body.dataArray[0];
    adaId = row.id;
    assert.equal(row.employeeCode, 'ABC-1', 'upper-cased — and then it passes the pattern');
    assert.equal(row.fullName, 'Ada (abc-1)', 'a column the form does not have, filled by the function');
    assert.equal(row.ignored, undefined, 'what afterSave returns is not the response');
    var db = (await knex.raw('select "salaryBand" from employees where id = ?', [adaId])).rows[0];
    assert.equal(db.salaryBand, null, 'a column the UI sent but the form does not have is NOT written');
    assert.deepEqual(calls, [['beforeSave', true, null], ['afterSave', adaId, 'ABC-1']]);
  });

  await t.test('on update it sees the previous row', async function() {
    calls = [];
    var res = await call('POST', '/factory/records/employee_edit/save', { id: adaId, values: { firstName: 'Augusta', employeeCode: 'abc-2' } });
    assert.equal(res.status, 200, res.body.message);
    assert.deepEqual(calls[0], ['beforeSave', false, 'Ada']);
  });

  await t.test('ctx.reject puts the message on the field; onError is told', async function() {
    calls = [];
    var res = await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'Blocked' } });
    assert.equal(res.status, 422);
    assert.deepEqual(res.body.error.fields, [{ field: 'firstName', message: 'This name is not allowed' }]);
    assert.deepEqual(calls, [['beforeSave', true, null], ['onError', 'save', 'This name is not allowed']]);
  });

  await t.test('an afterSave that fails does not undo the save', async function() {
    calls = [];
    var res = await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'AfterFails', employeeCode: 'x-9' } });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map(function(c) { return c[0]; }), ['beforeSave', 'afterSave', 'onError']);
    assert.equal((await knex.raw("select count(*)::int as n from employees where \"firstName\" = 'AfterFails'")).rows[0].n, 1);
  });

  await t.test('beforeLoad narrows the list and one record — and a list screen runs its edit screen\'s events', async function() {
    await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'Hidden' } });
    var list = await call('GET', '/factory/records/employee_list');
    assert.equal(list.status, 200, list.body.message);
    var names = list.body.dataArray.map(function(r) { return r.firstName; });
    assert.ok(names.includes('Augusta') && !names.includes('Hidden'));
    var hidden = (await knex.raw("select id from employees where \"firstName\" = 'Hidden'")).rows[0].id;
    assert.equal((await call('GET', '/factory/records/employee_edit/' + hidden)).status, 404);
  });

  await t.test('beforeDelete can refuse', async function() {
    var p = await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'Protected' } });
    var refused = await call('POST', '/factory/records/employee_edit/delete', { id: p.body.dataArray[0].id });
    assert.equal(refused.status, 422);
    assert.match(refused.body.message, /cannot be deleted/);
    assert.equal((await call('POST', '/factory/records/employee_edit/delete', { id: adaId })).status, 200);
  });

  await t.test('a function that stops being registered fails the save loudly, by name — never saves without its rule', async function() {
    actions.clear();
    actions.register({ name: 'logFailure', event: 'onError', execute: function() {} });
    var res = await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'Nobody' } });
    assert.equal(res.status, 500);
    assert.match(res.body.message, /runs "cleanEmployee" beforeSave, but no function of that name is registered/);
    assert.equal((await knex.raw("select count(*)::int as n from employees where \"firstName\" = 'Nobody'")).rows[0].n, 0);
    registerAll();
  });
});
