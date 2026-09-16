// A STEPPER SCREEN, SERVED. The bar is not a field: it holds no value and gets
// no column, and the steps are a way through one form rather than several
// forms. So every field is a column, is checked and is saved whichever step it
// sits on — including one the person never opened.
//
// Real Postgres, like the rest of the suite; skipped out loud without one.

var { test, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var http = require('node:http');
var express = require('express');
var knexLib = require('knex');
var { registerMTs, runWithMt } = require('@xeplr/db');
var factory = require('..');

var DB = 'xeplr_factory_stepper_' + process.pid;
var admin, knex, server, base, model, skip = null;

async function call(method, url, body) {
  var headers = { 'x-company-id': 'c1' };
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

test('a screen with a stepper: steps are a way through one table', async function(t) {
  if (skip) { t.skip(skip); return; }

  var onboarding = model.screensFromSpec({
    entity: 'onboarding',
    fields: [
      { type: 'stepper', steps: ['Details', 'Address', 'Review'] },
      { label: 'Full name', step: 'Details', required: true, validation: { maxLength: 80 } },
      { label: 'City', step: 'Address', required: true },
      { label: 'Notes', type: 'textarea', step: 'Review' }
    ]
  });

  await t.test('publish: the bar gets no column, every step\'s fields do', async function() {
    for (var doc of [onboarding.edit, onboarding.list]) {
      assert.equal((await call('PUT', '/factory/screens/' + doc.id + '/draft', { document: doc })).status, 200);
    }
    for (var key of ['onboarding_edit', 'onboarding_list']) {
      var res = await call('POST', '/factory/screens/' + key + '/publish');
      assert.equal(res.status, 200, key + ': ' + res.body.message);
    }
    var cols = (await knex.raw("select column_name from information_schema.columns where table_name = 'onboardings' order by ordinal_position")).rows
      .map(function(r) { return r.column_name; });
    assert.deepEqual(cols.slice(0, 4), ['id', 'fullName', 'city', 'notes']);
    assert.ok(cols.indexOf('steps') === -1 && cols.indexOf('stepper') === -1, 'the stepper itself is not a column');
  });

  var id;

  await t.test('a record carries the fields of every step, opened or not', async function() {
    var saved = await call('POST', '/factory/records/onboarding_edit/save', {
      values: { fullName: 'Ada Lovelace', city: 'Lagos', notes: 'Starts in October' }
    });
    assert.equal(saved.status, 200, saved.body.message);
    id = saved.body.dataArray[0].id;
    assert.equal(saved.body.dataArray[0].city, 'Lagos');

    var read = await call('GET', '/factory/records/onboarding_edit/' + id);
    assert.equal(read.body.dataArray[0].notes, 'Starts in October');
  });

  await t.test('a required field on a step the person never opened still refuses', async function() {
    var res = await call('POST', '/factory/records/onboarding_edit/save', { values: { fullName: 'Grace Hopper' } });
    assert.equal(res.status, 422);
    assert.match(res.body.message, /City/i, 'says which field, even though it is on another step');
  });

  await t.test('the list screen reads the columns of every step', async function() {
    var list = await call('GET', '/factory/records/onboarding_list');
    assert.equal(list.status, 200);
    var row = list.body.dataArray.find(function(r) { return r.id === id; });
    assert.equal(row.fullName, 'Ada Lovelace');
    assert.equal(row.city, 'Lagos');
  });
});
