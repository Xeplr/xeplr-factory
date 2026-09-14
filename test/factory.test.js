// @xeplr/factory against a REAL Postgres: the routes over HTTP, screens
// published (which creates and changes their tables), records in real tables.
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

test('an entity: screens published, tables changed, records in real tables', async function(t) {
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

  await t.test('publish creates the table — no migration step', async function() {
    for (var doc of [department.edit, department.list, employee.edit, employee.list]) {
      assert.equal((await call('PUT', '/factory/screens/' + doc.id + '/draft', { document: doc })).status, 200);
    }
    // The employee table points at departments: publishing it first fails in
    // the database, and changes nothing.
    var tooEarly = await call('POST', '/factory/screens/employee_edit/publish');
    assert.equal(tooEarly.status, 409);
    assert.match(tooEarly.body.message, /departments.*nothing was changed/);
    assert.equal((await knex.raw("select to_regclass('employees') as t")).rows[0].t, null);

    for (var key of ['department_edit', 'department_list', 'employee_edit', 'employee_list']) {
      var res = await call('POST', '/factory/screens/' + key + '/publish');
      assert.equal(res.status, 200, key + ': ' + res.body.message);
      assert.equal(res.body.dataArray[0].version, 1);
    }
    var created = await call('GET', '/factory/screens');
    assert.ok(created.body.dataArray.every(function(s) { return s.version === 1 && !s.hasDraft; }));
    var cols = (await knex.raw("select column_name from information_schema.columns where table_name = 'employees' order by ordinal_position")).rows.map(function(r) { return r.column_name; });
    assert.deepEqual(cols.slice(0, 6), ['id', 'firstName', 'departmentId', 'startDate', 'salary', 'remote']);
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

  await t.test('add a field and remove one: the new column is added, the old one dropped only when confirmed', async function() {
    await knex.raw('ALTER TABLE employees ADD COLUMN "legacyCode" varchar(10)');   // added by hand, not by a screen
    await knex.raw('UPDATE employees SET salary = 50000 WHERE id = ?', [adaId]);      // data the drop would lose
    var v2 = model.addControl(employee.edit, 'text', { props: { label: 'Employee code', validation: { maxLength: 12 } } }).document;
    v2 = model.removeNodes(v2, ['salary']);
    assert.equal((await call('PUT', '/factory/screens/employee_edit/draft', { document: v2 })).status, 200);

    var ask = await call('POST', '/factory/screens/employee_edit/publish');
    assert.equal(ask.status, 409);
    assert.match(ask.body.message, /removes 1 column.*salary \(1 value\)/);
    assert.deepEqual(ask.body.dataArray[0].confirm, [{ column: 'salary', records: 1 }]);
    assert.ok(ask.body.dataArray[0].keep.some(function(k) { return k.name === 'legacyCode'; }), 'a hand-made column is not offered for dropping');
    var stillThere = (await knex.raw("select count(*)::int as n from information_schema.columns where table_name = 'employees' and column_name in ('salary', 'employeeCode')")).rows[0].n;
    assert.equal(stillThere, 1, 'nothing changed before confirming: salary there, employeeCode not yet');

    var wrong = await call('POST', '/factory/screens/employee_edit/publish', { confirmDrop: ['somethingElse'] });
    assert.equal(wrong.status, 409, 'confirming a different column confirms nothing');

    var ok = await call('POST', '/factory/screens/employee_edit/publish', { confirmDrop: ['salary'] });
    assert.equal(ok.status, 200, ok.body.message);
    assert.equal(ok.body.dataArray[0].version, 2);
    assert.ok(ok.body.dataArray[0].statements.some(function(x) { return /ADD COLUMN IF NOT EXISTS "employeeCode" varchar\(12\)/.test(x); }));
    assert.ok(ok.body.dataArray[0].statements.some(function(x) { return /DROP COLUMN IF EXISTS "salary"/.test(x); }));
    var cols = (await knex.raw("select column_name from information_schema.columns where table_name = 'employees'")).rows.map(function(r) { return r.column_name; });
    assert.ok(cols.includes('employeeCode') && !cols.includes('salary') && cols.includes('legacyCode'));

    var saved = await call('POST', '/factory/records/employee_edit/save', { id: adaId, values: { firstName: 'Ada', departmentId: financeId, employeeCode: 'E-001' } });
    assert.equal(saved.status, 200, saved.body.message);
    assert.equal(saved.body.dataArray[0].employeeCode, 'E-001');
  });

  await t.test('a column another company\'s screen still uses is never dropped', async function() {
    // Company c2 publishes its own employee screen on the same table, keeping "remote".
    await call('PUT', '/factory/screens/employee_edit/draft', { document: employee.edit }, 'c2');
    await knex.raw('ALTER TABLE employees ADD COLUMN IF NOT EXISTS "salary" numeric');   // c2's screen has salary again
    assert.equal((await call('POST', '/factory/screens/employee_edit/publish', null, 'c2')).status, 200);

    // c1 removes "remote": c2 still uses it, so it is kept, and nothing needs confirming.
    var v3 = model.removeNodes(model.addControl(employee.edit, 'text', { props: { label: 'Employee code', validation: { maxLength: 12 } } }).document, ['salary', 'remote']);
    assert.equal((await call('PUT', '/factory/screens/employee_edit/draft', { document: v3 })).status, 200);
    var res = await call('POST', '/factory/screens/employee_edit/publish');
    assert.equal(res.status, 200, res.body.message);
    assert.ok(res.body.dataArray[0].keep.some(function(k) { return k.name === 'remote' && /another published screen/.test(k.reason); }));
    assert.ok((await knex.raw("select 1 from information_schema.columns where table_name = 'employees' and column_name = 'remote'")).rows.length === 1);
  });

  await t.test('a change that would lose data is refused, and nothing runs', async function() {
    var narrower = model.setNodeProperty(employee.edit, 'firstName', 'props.validation.maxLength', 10);
    await call('PUT', '/factory/screens/employee_edit/draft', { document: narrower });
    var res = await call('POST', '/factory/screens/employee_edit/publish');
    assert.equal(res.status, 409);
    assert.match(res.body.message, /would cut longer values/);
    assert.equal((await knex.raw("select character_maximum_length as n from information_schema.columns where table_name = 'employees' and column_name = 'firstName'")).rows[0].n, 80);
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
