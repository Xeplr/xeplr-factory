// @xeplr/factory against a REAL Postgres: the routes over HTTP, screens
// published, migrations generated and applied, records in real tables.
//
// Needs a Postgres the current user can create databases on (PGHOST/PGUSER/…
// as usual). Without one, the suite is skipped — said out loud, not passed.

var { test, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var http = require('node:http');
var express = require('express');
var knexLib = require('knex');
var { registerMTs, runWithMt } = require('@xeplr/db');
var factory = require('..');

var DB = 'xeplr_factory_test_' + process.pid;
var admin, knex, server, base, model, skip = null;

async function call(method, url, body, tenant) {
  var res = await fetch(base + url, {
    method: method,
    headers: Object.assign({ 'x-company-id': tenant || 'c1' }, body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

before(async function() {
  admin = knexLib({ client: 'pg', connection: { database: 'postgres' } });
  try {
    await admin.raw('SELECT 1');
  } catch (err) {
    skip = 'no Postgres available (' + err.message + ')';
    return;
  }
  await admin.raw('DROP DATABASE IF EXISTS ??', [DB]);
  await admin.raw('CREATE DATABASE ??', [DB]);
  knex = knexLib({ client: 'pg', connection: { database: DB } });
  await knex.raw(fs.readFileSync(path.join(__dirname, '..', 'migrations', '0001_factory_screens.sql'), 'utf8'));

  registerMTs({ l1: { name: 'companyId', header: 'x-company-id' } });
  model = await import('@xeplr/ui-factory/model');
  await factory.init({ knex: knex });

  var app = express();
  app.use(function(req, res, next) {
    req.user = { id: 'u1' };
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

test('an entity: screens, migrations, records in real tables', async function(t) {
  if (skip) { t.skip(skip); return; }

  var department = model.screensFromSpec({ entity: 'department', fields: [{ label: 'Name', required: true, validation: { maxLength: 80 } }] })
  var employee = model.screensFromSpec({
    entity: 'employee',
    fields: [
      { label: 'First name', required: true, validation: { maxLength: 80 } },
      { label: 'Department', type: 'dropdown', table: 'departments', required: true },
      { label: 'Start date', type: 'date' },
      { label: 'Salary', type: 'number', validation: { min: 0 } },
      { label: 'Remote', type: 'checkbox' }
    ]
  })

  await t.test('publishing refuses a screen whose table does not exist, and hands back the migration', async function() {
    assert.equal((await call('PUT', '/factory/screens/employee_edit/draft', { document: employee.edit })).status, 200);
    var res = await call('POST', '/factory/screens/employee_edit/publish');
    assert.equal(res.status, 409);
    assert.match(res.body.message, /Table "employees" does not exist/);
    assert.match(res.body.dataArray[0].migration, /CREATE TABLE IF NOT EXISTS "employees"/);
  });

  await t.test('after the migrations, both entities publish', async function() {
    await knex.raw(model.migrationFor(null, department.edit).sql);
    await knex.raw(model.migrationFor(null, employee.edit).sql);
    for (var doc of [department.edit, department.list, employee.list]) {
      assert.equal((await call('PUT', '/factory/screens/' + doc.id + '/draft', { document: doc })).status, 200);
    }
    for (var key of ['department_edit', 'department_list', 'employee_edit', 'employee_list']) {
      var res = await call('POST', '/factory/screens/' + key + '/publish');
      assert.equal(res.status, 200, key + ': ' + res.body.message);
      assert.equal(res.body.dataArray[0].version, 1);
    }
  });

  await t.test('a draft that does not validate is refused with every problem', async function() {
    var bad = JSON.parse(JSON.stringify(employee.edit));
    bad.nodes[1].props.name = 'isActive';
    var res = await call('PUT', '/factory/screens/employee_edit/draft', { document: bad });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields.some(function(e) { return /standard column/.test(e.message); }));
  });

  var financeId, adaId;

  await t.test('records save into the real columns', async function() {
    var dept = await call('POST', '/factory/records/department_edit/save', { values: { name: 'Finance' } });
    assert.equal(dept.status, 200);
    financeId = dept.body.dataArray[0].id;
    assert.equal(dept.body.dataArray[0].name, 'Finance');

    var opts = await call('GET', '/factory/options/departments');
    assert.deepEqual(opts.body.dataArray, [{ id: financeId, name: 'Finance' }]);

    var emp = await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'Ada', departmentId: financeId, startDate: '2026-10-01', salary: 120000.5 } });
    assert.equal(emp.status, 200, emp.body.message);
    var row = emp.body.dataArray[0];
    adaId = row.id;
    assert.equal(row.startDate, '2026-10-01', 'a date comes back as the date that was saved');
    assert.equal(row.salary, 120000.5, 'numeric comes back as a number');
    assert.equal(row.remote, false, 'an untouched checkbox is false');

    var sql = await knex.raw('select "firstName", "departmentId", "mtId1", "recordCreatedBy", "isActive" from employees where id = ?', [adaId]);
    assert.deepEqual(sql.rows[0], { firstName: 'Ada', departmentId: financeId, mtId1: 'c1', recordCreatedBy: 'u1', isActive: true });
    var jsonColumns = await knex.raw("select column_name from information_schema.columns where table_name = 'employees' and data_type in ('json', 'jsonb')");
    assert.equal(jsonColumns.rows.length, 0, 'no JSON columns');
  });

  await t.test('the screen\'s rules are enforced on the server', async function() {
    var missing = await call('POST', '/factory/records/employee_edit/save', { values: { departmentId: financeId } });
    assert.equal(missing.status, 422);
    assert.ok(missing.body.error.fields.some(function(f) { return f.field === 'firstName'; }));
    var tooLong = await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'x'.repeat(81), departmentId: financeId } });
    assert.equal(tooLong.status, 422);
    var negative = await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'N', departmentId: financeId, salary: -1 } });
    assert.equal(negative.status, 422);
  });

  await t.test('a dropdown id that does not exist is refused by the foreign key', async function() {
    var res = await call('POST', '/factory/records/employee_edit/save', { values: { firstName: 'Bad', departmentId: 'nope' } });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /no longer exists/);
  });

  await t.test('update keeps the id; the list shows the record', async function() {
    var res = await call('POST', '/factory/records/employee_edit/save', { id: adaId, values: { firstName: 'Augusta Ada', departmentId: financeId, remote: true } });
    assert.equal(res.status, 200, res.body.message);
    assert.equal(res.body.dataArray[0].id, adaId);
    assert.equal(res.body.dataArray[0].startDate, null, 'a field cleared in the form is cleared in the table');
    var list = await call('GET', '/factory/records/employee_list');
    assert.equal(list.status, 200, list.body.message);
    assert.equal(list.body.dataArray.length, 1);
    assert.equal(list.body.dataArray[0].firstName, 'Augusta Ada');
    assert.equal(list.body.dataArray[0].remote, true);
  });

  await t.test('another tenant sees none of it', async function() {
    assert.equal((await call('GET', '/factory/records/employee_list', null, 'c2')).body.dataArray.length, 0);
    assert.equal((await call('GET', '/factory/screens/employee_edit', null, 'c2')).status, 404, 'screens are per tenant too');
    var cross = await call('POST', '/factory/records/employee_edit/save', { id: adaId, values: { firstName: 'Hijack', departmentId: financeId } }, 'c2');
    assert.equal(cross.status, 404);
  });

  await t.test('a field that is a column is locked in the designer', async function() {
    var res = await call('GET', '/factory/screens/employee_edit');
    assert.ok(res.body.dataArray[0].lockedNames.includes('firstName'));
    assert.ok(res.body.dataArray[0].lockedNames.includes('departmentId'));
  });

  await t.test('a new field: publish refused with ALTER TABLE, then accepted after it runs', async function() {
    var v2 = model.addControl(employee.edit, 'text', { props: { label: 'Employee code', validation: { maxLength: 12 } } }).document;
    assert.equal((await call('PUT', '/factory/screens/employee_edit/draft', { document: v2 })).status, 200);
    var refused = await call('POST', '/factory/screens/employee_edit/publish');
    assert.equal(refused.status, 409);
    var migration = refused.body.dataArray[0].migration;
    assert.match(migration, /ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "employeeCode" varchar\(12\)/);
    assert.doesNotMatch(migration, /CREATE TABLE/);
    await knex.raw(migration);
    var ok = await call('POST', '/factory/screens/employee_edit/publish');
    assert.equal(ok.status, 200, ok.body.message);
    assert.equal(ok.body.dataArray[0].version, 2);
    var saved = await call('POST', '/factory/records/employee_edit/save', { id: adaId, values: { firstName: 'Ada', departmentId: financeId, employeeCode: 'E-001' } });
    assert.equal(saved.body.dataArray[0].employeeCode, 'E-001');
    var list = await call('GET', '/factory/screens');
    var entry = list.body.dataArray.find(function(s) { return s.screenKey === 'employee_edit'; });
    assert.equal(entry.version, 2);
    assert.equal(entry.hasDraft, false);
  });

  await t.test('only tables a published screen uses are served', async function() {
    assert.equal((await call('GET', '/factory/options/factory_screens')).status, 404);
    assert.equal((await call('GET', '/factory/records/nope')).status, 404);
    var tables = (await call('GET', '/factory/tables')).body.dataArray.map(function(t) { return t.id; });
    assert.deepEqual(tables, ['departments', 'employees']);
  });

  await t.test('delete is soft: gone from the list, still in the table', async function() {
    var res = await call('POST', '/factory/records/employee_edit/delete', { id: adaId });
    assert.equal(res.status, 200);
    assert.equal((await call('GET', '/factory/records/employee_list')).body.dataArray.length, 0);
    var sql = await knex.raw('select "isActive", "recordModifiedBy" from employees where id = ?', [adaId]);
    assert.deepEqual(sql.rows[0], { isActive: false, recordModifiedBy: 'u1' });
  });
});
