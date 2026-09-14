// Hooks — save / get / delete, each with before / after / error / override —
// against a real Postgres, through the routes.

var { test, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var http = require('node:http');
var express = require('express');
var knexLib = require('knex');
var { registerMTs, runWithMt } = require('@xeplr/db');
var factory = require('..');
var { validateHooks } = require('../lib/hooks');

var DB = 'xeplr_factory_hooks_' + process.pid;
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

var HOOKS = {
  employee_edit: {
    save: {
      before: function(ctx) {
        calls.push(['save.before', ctx.isNew, ctx.previous && ctx.previous.firstName]);
        if (ctx.values.firstName === 'Blocked') ctx.reject('This name is not allowed', { field: 'firstName' });
        var sentName = ctx.input.firstName;
        try { ctx.input.firstName = 'changed'; } catch (_) { /* strict mode throws; sloppy mode ignores */ }
        assert.equal(ctx.input.firstName, sentName, 'input is read-only');
        return Object.assign({}, ctx.values, {
          employeeCode: ctx.values.employeeCode ? String(ctx.values.employeeCode).toUpperCase() : ctx.values.employeeCode,
          fullName: ctx.values.firstName + ' (' + ctx.values.employeeCode + ')'     // a column the form does not have
        });
      },
      after: function(ctx) {
        calls.push(['save.after', ctx.id, ctx.result.employeeCode, ctx.input.employeeCode]);
        if (ctx.values.firstName === 'AfterFails') throw new Error('mail server down');
        return Object.assign({}, ctx.result, { greeting: 'Saved ' + ctx.result.firstName });
      },
      error: function(ctx, err) { calls.push(['save.error', err.message]); }
    },
    get: {
      before: function(ctx) {
        calls.push(['get.before', ctx.many]);
        ctx.query.whereNot('employees.firstName', 'Hidden');
      },
      after: function(ctx) {
        if (ctx.many) return ctx.result;
        return Object.assign({}, ctx.result, { loadedBy: 'hook' });
      }
    },
    delete: {
      before: function(ctx) {
        if (ctx.previous.firstName === 'Protected') ctx.reject('Protected employees cannot be deleted');
      },
      after: function(ctx) { calls.push(['delete.after', ctx.id]); }
    }
  },
  department_edit: {
    save: {
      before: function() { throw new Error('before must not run when there is an override'); },
      after: function() { throw new Error('after must not run when there is an override'); },
      error: function() { throw new Error('error must not run when there is an override'); },
      override: function(ctx) {
        calls.push(['department.save.override', ctx.input.name, ctx.isNew]);
        return { id: 'from-override', name: String(ctx.input.name).toUpperCase() };
      }
    },
    get: { override: function(ctx) { return ctx.id ? { id: ctx.id, name: 'One' } : [{ id: 'd1', name: 'Static' }]; } },
    delete: { override: function(ctx) { if (ctx.id === 'nope') throw Object.assign(new Error('Override says no'), { status: 409 }); return { id: ctx.id, archived: true }; } }
  }
};

before(async function() {
  admin = knexLib({ client: 'pg', connection: { database: 'postgres' } });
  try { await admin.raw('SELECT 1'); } catch (err) { skip = 'no Postgres available (' + err.message + ')'; return; }
  await admin.raw('DROP DATABASE IF EXISTS ??', [DB]);
  await admin.raw('CREATE DATABASE ??', [DB]);
  knex = knexLib({ client: 'pg', connection: { database: DB } });
  await knex.raw(fs.readFileSync(path.join(__dirname, '..', 'migrations', '0001_factory_screens.sql'), 'utf8'));
  registerMTs({ l1: { name: 'companyId', header: 'x-company-id' } });
  model = await import('@xeplr/ui-factory/model');
  await factory.init({ knex: knex, hooks: HOOKS });

  var app = express();
  app.use(function(req, res, next) { req.user = { id: 'u1' }; runWithMt({ mtId1: req.headers['x-company-id'] }, next); });
  app.use(factory.router());
  server = http.createServer(app);
  await new Promise(function(r) { server.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;

  // Tables come from publishing the screens.
  var department = model.screensFromSpec({ entity: 'department', fields: [{ label: 'Name', required: true }] });
  var employee = model.screensFromSpec({
    entity: 'employee',
    fields: [
      { label: 'First name', required: true },
      { label: 'Employee code', validation: { pattern: '^[A-Z]+-[0-9]+$', patternMessage: 'Codes look like ABC-1' } }
    ]
  });
  for (var doc of [department.edit, employee.edit, employee.list]) {
    await call('PUT', '/factory/screens/' + doc.id + '/draft', { document: doc });
    var res = await call('POST', '/factory/screens/' + doc.id + '/publish');
    if (res.status !== 200) throw new Error('publish ' + doc.id + ': ' + res.body.message);
  }
  // Columns the form does not have: one a hook fills, one only the database knows.
  await knex.raw('ALTER TABLE employees ADD COLUMN "fullName" varchar(120), ADD COLUMN "salaryBand" varchar(10)');
});

after(async function() {
  if (server) await new Promise(function(r) { server.close(r); });
  if (knex) await knex.destroy();
  if (admin && !skip) await admin.raw('DROP DATABASE IF EXISTS ??', [DB]);
  if (admin) await admin.destroy();
});

test('hooks', async function(t) {
  if (skip) { t.skip(skip); return; }
  var adaId;

  await t.test('a malformed hooks file fails at startup, not silently', function() {
    assert.throws(function() { validateHooks({ employee_edit: { beforeSave: function() {} } }); }, /"beforeSave" is not an operation/);
    assert.throws(function() { validateHooks({ employee_edit: { save: { onSaved: function() {} } } }); }, /not a hook/);
    assert.throws(function() { validateHooks({ employee_edit: { save: { before: 'x' } } }); }, /must be a function/);
  });

  await t.test('save.before changes the values, and they are validated after', async function() {
    calls = [];
    var res = await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'Ada', employeeCode: 'abc-1', salaryBand: 'X' } });
    assert.equal(res.status, 200, res.body.message);
    var row = res.body.dataArray[0];
    adaId = row.id;
    assert.equal(row.employeeCode, 'ABC-1', 'uppercased by the hook — and then it passes the pattern');
    assert.equal(row.fullName, 'Ada (abc-1)', 'a column the form does not have, filled by the hook');
    assert.equal(row.greeting, 'Saved Ada', 'after replaced the result');
    var db = (await knex.raw('select "fullName", "salaryBand" from employees where id = ?', [adaId])).rows[0];
    assert.equal(db.fullName, 'Ada (abc-1)');
    assert.equal(db.salaryBand, null, 'a column the UI sent but the form does not have is NOT written');
    assert.deepEqual(calls, [['save.before', true, null], ['save.after', adaId, 'ABC-1', 'abc-1']]);
  });

  await t.test('update: before sees the previous row', async function() {
    calls = [];
    var res = await call('POST', '/factory/records/employee_edit/save', { id: adaId, values: { firstName: 'Augusta', employeeCode: 'abc-2' } });
    assert.equal(res.status, 200, res.body.message);
    assert.deepEqual(calls[0], ['save.before', false, 'Ada']);
  });

  await t.test('before can reject, with the message on the field; error is told', async function() {
    calls = [];
    var res = await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'Blocked' } });
    assert.equal(res.status, 422);
    assert.deepEqual(res.body.error.fields, [{ field: 'firstName', message: 'This name is not allowed' }]);
    assert.deepEqual(calls.map(function(c) { return c[0]; }), ['save.before', 'save.error']);
    assert.equal((await knex.raw("select count(*)::int as n from employees where \"firstName\" = 'Blocked'")).rows[0].n, 0);
  });

  await t.test('the screen\'s rules still apply after before', async function() {
    calls = [];
    var res = await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'Bad', employeeCode: 'not a code' } });
    assert.equal(res.status, 422);
    assert.equal(calls[calls.length - 1][0], 'save.error');
  });

  await t.test('an after that fails does not undo the save', async function() {
    calls = [];
    var res = await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'AfterFails', employeeCode: 'x-9' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.dataArray[0].greeting, undefined, 'the plain saved row is returned');
    assert.deepEqual(calls.map(function(c) { return c[0]; }), ['save.before', 'save.after', 'save.error']);
    assert.equal((await knex.raw("select count(*)::int as n from employees where \"firstName\" = 'AfterFails'")).rows[0].n, 1);
  });

  await t.test('get.before narrows the list — and a list screen uses its edit screen\'s hooks', async function() {
    await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'Hidden' } });
    var list = await call('GET', '/factory/records/employee_list');
    assert.equal(list.status, 200, list.body.message);
    var names = list.body.dataArray.map(function(r) { return r.firstName; });
    assert.ok(names.includes('Augusta') && !names.includes('Hidden'));
  });

  await t.test('get one record: after adds to it', async function() {
    var one = await call('GET', '/factory/records/employee_edit/' + adaId);
    assert.equal(one.status, 200, one.body.message);
    assert.equal(one.body.dataArray[0].firstName, 'Augusta');
    assert.equal(one.body.dataArray[0].loadedBy, 'hook');
    var hidden = (await knex.raw("select id from employees where \"firstName\" = 'Hidden'")).rows[0].id;
    assert.equal((await call('GET', '/factory/records/employee_edit/' + hidden)).status, 404, 'get.before applies to one record too');
  });

  await t.test('delete.before can refuse; after runs on success', async function() {
    var p = await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'Protected' } });
    var refused = await call('POST', '/factory/records/employee_edit/delete', { id: p.body.dataArray[0].id });
    assert.equal(refused.status, 422);
    assert.match(refused.body.message, /cannot be deleted/);
    calls = [];
    var ok = await call('POST', '/factory/records/employee_edit/delete', { id: adaId });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, [['delete.after', adaId]]);
  });

  await t.test('override replaces everything: no rules, no before / after / error, no generic save', async function() {
    calls = [];
    var saved = await call('POST', '/factory/records/department_edit/save', { values: { name: 'finance' } });
    assert.equal(saved.status, 200, saved.body.message);
    assert.deepEqual(saved.body.dataArray[0], { id: 'from-override', name: 'FINANCE' });
    assert.deepEqual(calls, [['department.save.override', 'finance', true]]);
    assert.equal((await knex.raw('select count(*)::int as n from departments')).rows[0].n, 0, 'the generic insert did not run');

    var empty = await call('POST', '/factory/records/department_edit/save', { values: {} });
    assert.equal(empty.status, 200, 'the screen\'s required rule did not run either');

    assert.deepEqual((await call('GET', '/factory/records/department_edit')).body.dataArray, [{ id: 'd1', name: 'Static' }]);
    assert.deepEqual((await call('GET', '/factory/records/department_edit/42')).body.dataArray, [{ id: '42', name: 'One' }]);
    assert.deepEqual((await call('POST', '/factory/records/department_edit/delete', { id: 'd7' })).body.dataArray, [{ id: 'd7', archived: true }]);
    var failed = await call('POST', '/factory/records/department_edit/delete', { id: 'nope' });
    assert.equal(failed.status, 409, 'an override\'s own error goes to the UI');
    assert.equal(failed.body.message, 'Override says no');
  });
});
