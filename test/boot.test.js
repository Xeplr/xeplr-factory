// What an app does at startup: publish the screens it ships with, and guard
// the routes by the access catalog. Real Postgres, with tenancy on.

var { test, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var http = require('node:http');
var express = require('express');
var knexLib = require('knex');
var { registerMTs, runWithMt } = require('@xeplr/db');
var factory = require('..');

var DB = 'xeplr_factory_boot_' + process.pid;
var admin, knex, server, base, model, skip = null;

async function call(method, url, body, apis) {
  var headers = { 'x-company-id': 'c1', 'x-test-apis': apis === undefined ? '*' : apis };
  if (body) headers['content-type'] = 'application/json';
  var res = await fetch(base + url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

before(async function() {
  admin = knexLib({ client: 'pg', connection: { database: 'postgres' } });
  try { await admin.raw('SELECT 1'); } catch (err) { skip = 'no Postgres available (' + err.message + ')'; return; }
  await admin.raw('DROP DATABASE IF EXISTS ??', [DB]);
  await admin.raw('CREATE DATABASE ??', [DB]);
  knex = knexLib({ client: 'pg', connection: { database: DB } });
  await knex.raw(fs.readFileSync(path.join(factory.migrationsDir, '0001_factory_screens.sql'), 'utf8'));
  registerMTs({ l1: { name: 'companyId', header: 'x-company-id' } });
  model = await import('@xeplr/ui-factory/model');
  await factory.init({ knex: knex });

  var app = express();
  // Stands in for the auth gate: req.access from /auth/api/me.
  app.use(function(req, res, next) {
    req.user = { id: 'u1' };
    var apis = req.headers['x-test-apis'];
    if (apis !== 'none') req.access = { apis: apis === '*' ? Object.values(factory.API_NAMES) : apis.split('|') };
    runWithMt({ mtId1: req.headers['x-company-id'] }, next);
  });
  app.use(factory.router({ access: true }));
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

test('startup', async function(t) {
  if (skip) { t.skip(skip); return; }

  await t.test('the migration folders are where the package says', function() {
    assert.ok(fs.existsSync(path.join(factory.migrationsDir, '0001_factory_screens.sql')));
    var authSql = fs.readdirSync(factory.authMigrationsDir).map(function(f) { return fs.readFileSync(path.join(factory.authMigrationsDir, f), 'utf8'); }).join('\n');
    Object.values(factory.API_NAMES).forEach(function(name) {
      assert.ok(authSql.indexOf("'" + name + "'") !== -1, name + ' is in the access catalog SQL');
    });
  });

  var department = model.screensFromSpec({ entity: 'department', fields: [{ label: 'Name', required: true }] });
  var employee = model.screensFromSpec({ entity: 'employee', fields: [{ label: 'First name', required: true }, { label: 'Department', type: 'dropdown', table: 'departments' }] });

  await t.test('publishScreens: tables before the dropdowns that point at them, lists last', async function() {
    // Deliberately the wrong order.
    var result = await factory.publishScreens([employee.list, employee.edit, department.list, department.edit]);
    assert.deepEqual(result.published, ['department_edit', 'employee_edit', 'employee_list', 'department_list']);
    var fk = await knex.raw("select count(*)::int as n from information_schema.table_constraints where table_name = 'employees' and constraint_type = 'FOREIGN KEY'");
    assert.equal(fk.rows[0].n, 1);
  });

  await t.test('...shared by every company', async function() {
    var rows = (await knex.raw('select distinct "mtId1" from factory_screens')).rows;
    assert.deepEqual(rows, [{ mtId1: '*' }]);
    var seen = await call('GET', '/factory/screens/employee_edit');
    assert.equal(seen.status, 200, seen.body.message);
  });

  await t.test('...and never over a screen that is already published', async function() {
    var changed = Object.assign({}, employee.edit, { name: 'Changed in the file' });
    var result = await factory.publishScreens([changed, employee.list]);
    assert.deepEqual(result.published, []);
    assert.deepEqual(result.kept.sort(), ['employee_edit', 'employee_list']);
    var doc = (await call('GET', '/factory/screens/employee_edit')).body.dataArray[0].document;
    assert.notEqual(doc.name, 'Changed in the file');
  });

  await t.test('records saved by a company are that company\'s', async function() {
    var saved = await call('POST', '/factory/records/department_edit/save', { values: { name: 'Finance' } });
    assert.equal(saved.status, 200, saved.body.message);
    assert.equal((await knex.raw('select "mtId1" from departments')).rows[0].mtId1, 'c1');
  });

  await t.test('access: a route answers only when the caller\'s access names it', async function() {
    var denied = await call('GET', '/factory/records/department_list', null, 'List factory screens');
    assert.equal(denied.status, 403);
    assert.match(denied.body.message, /Access denied: List factory records/);
    var allowed = await call('GET', '/factory/records/department_list', null, 'List factory records');
    assert.equal(allowed.status, 200);
    var noDesign = await call('POST', '/factory/screens/department_edit/publish', {}, 'List factory records|Save factory record');
    assert.equal(noDesign.status, 403, 'publishing changes tables — its own permission');
  });

  await t.test('access: no access information at all is refused, not waved through', async function() {
    var res = await call('GET', '/factory/screens', null, 'none');
    assert.equal(res.status, 403);
    assert.match(res.body.message, /behind the auth gate/);
  });
});

test('a new form, made in the app from its name', async function(t) {
  if (skip) { t.skip(skip); return; }

  await t.test('creates both screens as drafts, with a starter field — no table until published', async function() {
    var res = await call('POST', '/factory/entities', { entity: 'Farming department' });
    assert.equal(res.status, 200, res.body.message);
    assert.deepEqual(res.body.dataArray[0], { entity: 'Farming department', name: 'Farming departments', source: 'farming_departments', edit: 'farming_department_edit', list: 'farming_department_list' });
    var draft = await call('GET', '/factory/screens/farming_department_edit?draft=true');
    assert.equal(draft.status, 200, draft.body.message);
    assert.deepEqual(model.inputNodes(draft.body.dataArray[0].document).map(function(n) { return n.props.name; }), ['name']);
    assert.equal((await knex.raw("select to_regclass('farming_departments') as t")).rows[0].t, null);
  });

  await t.test('publishing the form, then the list, makes the table and a usable list', async function() {
    assert.equal((await call('POST', '/factory/screens/farming_department_edit/publish', {})).status, 200);
    assert.equal((await call('POST', '/factory/screens/farming_department_list/publish', {})).status, 200);
    var saved = await call('POST', '/factory/records/farming_department_edit/save', { values: { name: 'North field' } });
    assert.equal(saved.status, 200, saved.body.message);
    assert.equal((await call('GET', '/factory/records/farming_department_list')).body.dataArray[0].name, 'North field');
  });

  await t.test('refuses a name that is taken, a table that exists, and no name', async function() {
    var again = await call('POST', '/factory/entities', { entity: 'farming department' });
    assert.equal(again.status, 409);
    assert.match(again.body.message, /already exists/);
    await knex.raw('CREATE TABLE "invoices" ("id" varchar(25) PRIMARY KEY)');
    var table = await call('POST', '/factory/entities', { entity: 'invoice' });
    assert.equal(table.status, 409);
    assert.match(table.body.message, /A table named "invoices" already exists/);
    assert.equal((await call('POST', '/factory/entities', { entity: '  ' })).status, 422);
  });

  await t.test('a design permission: refused without it', async function() {
    var res = await call('POST', '/factory/entities', { entity: 'crop' }, 'Save factory screen draft|Publish factory screen');
    assert.equal(res.status, 403);
    assert.match(res.body.message, /Create factory form/);
  });
});
