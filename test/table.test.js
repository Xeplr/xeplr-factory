// Models (getters / setters, toDb / fromDb with super) and factory.table() —
// on a real Postgres, with tenancy on.

var { test, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var http = require('node:http');
var express = require('express');
var knexLib = require('knex');
var { registerMTs, runWithMt } = require('@xeplr/db');
var factory = require('..');
var { createModels } = require('../lib/factoryModel');

var DB = 'xeplr_factory_table_' + process.pid;
var admin, knex, server, base, model, skip = null;

class NoteModel extends factory.FactoryModel {
  static toDb(values) {
    // More than a field: a value worked out from others, then the field setters.
    return super.toDb(Object.assign({}, values, values.title ? { title: String(values.title).trim() } : {}));
  }
}
NoteModel.table = 'notes';
NoteModel.fields = {
  tags: {
    set: function(v) { return Array.isArray(v) ? v.join(',') : v; },
    get: function(v) { return v ? v.split(',') : []; }
  }
};

async function call(method, url, body, company) {
  var res = await fetch(base + url, {
    method: method,
    headers: Object.assign({ 'x-company-id': company || 'c1' }, body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
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
  await factory.init({ knex: knex, models: [NoteModel] });
  var app = express();
  app.use(function(req, res, next) { req.user = { id: 'u1' }; runWithMt({ mtId1: req.headers['x-company-id'] }, next); });
  app.use(factory.router());
  server = http.createServer(app);
  await new Promise(function(r) { server.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
  var note = model.screensFromSpec({ entity: 'note', fields: [{ label: 'Title', required: true }, { label: 'Tags', validation: { maxLength: 200 } }] });
  await factory.publishScreens([note.edit, note.list]);
});

after(async function() {
  if (server) await new Promise(function(r) { server.close(r); });
  if (knex) await knex.destroy();
  if (admin && !skip) await admin.raw('DROP DATABASE IF EXISTS ??', [DB]);
  if (admin) await admin.destroy();
});

test('models and factory.table', async function(t) {
  if (skip) { t.skip(skip); return; }

  await t.test('a malformed model fails at startup', function() {
    assert.throws(function() { createModels([class Nope {}]); }, /extends FactoryModel/);
    class NoTable extends factory.FactoryModel {}
    assert.throws(function() { createModels([NoTable]); }, /static table/);
    class BadField extends factory.FactoryModel {}
    BadField.table = 'x';
    BadField.fields = { a: { get: 'nope' } };
    assert.throws(function() { createModels([BadField]); }, /must be a function/);
  });

  await t.test('the routes: stored as text, read back as an array — setters run before the rules', async function() {
    var saved = await call('POST', '/factory/records/note_edit/save', { values: { title: '  Soil  ', tags: 'red,clay' } });
    assert.equal(saved.status, 200, saved.body.message);
    assert.deepEqual(saved.body.dataArray[0].tags, ['red', 'clay']);
    assert.equal(saved.body.dataArray[0].title, 'Soil', 'toDb override, through super');
    var raw = (await knex.raw('select tags from notes')).rows[0].tags;
    assert.equal(raw, 'red,clay');
    var list = await call('GET', '/factory/records/note_list');
    assert.deepEqual(list.body.dataArray[0].tags, ['red', 'clay']);
  });

  await t.test('factory.table: insert fills id, company and audit; values through the setters', async function() {
    await runWithMt({ mtId1: 'c1' }, async function() {
      await factory.table('notes', { user: { id: 'u9' } }).insert({ title: 'Seeds', tags: ['wheat', 'rice'] });
    });
    var row = (await knex.raw("select * from notes where title = 'Seeds'")).rows[0];
    assert.ok(row.id && row.id.length > 10);
    assert.equal(row.mtId1, 'c1');
    assert.equal(row.recordCreatedBy, 'u9');
    assert.equal(row.tags, 'wheat,rice');
  });

  await t.test('factory.table: reads see this company\'s active rows, through the getters', async function() {
    await runWithMt({ mtId1: 'c2' }, async function() {
      await factory.table('notes').insert({ title: 'Other company', tags: 'x' });
    });
    var mine = await runWithMt({ mtId1: 'c1' }, function() { return factory.table('notes').orderBy('title'); });
    assert.deepEqual(mine.map(function(r) { return r.title; }), ['Seeds', 'Soil']);
    assert.deepEqual(mine[0].tags, ['wheat', 'rice']);
    var one = await runWithMt({ mtId1: 'c1' }, function() { return factory.table('notes').where({ title: 'Soil' }).first(); });
    assert.deepEqual(one.tags, ['red', 'clay'], 'first() is shaped too');
  });

  await t.test('factory.table: update stamps audit and cannot move a row to another company; del is soft', async function() {
    await runWithMt({ mtId1: 'c1' }, async function() {
      var n = await factory.table('notes', { user: { id: 'u7' } }).where({ title: 'Seeds' }).update({ tags: ['barley'], mtId1: 'c2' });
      assert.equal(n, 1);
      var gone = await factory.table('notes').where({ title: 'Other company' }).update({ tags: 'hacked' });
      assert.equal(gone, 0, 'another company\'s row is out of reach');
    });
    var row = (await knex.raw("select * from notes where title = 'Seeds'")).rows[0];
    assert.equal(row.tags, 'barley');
    assert.equal(row.mtId1, 'c1');
    assert.equal(row.recordModifiedBy, 'u7');

    await runWithMt({ mtId1: 'c1' }, function() { return factory.table('notes').where({ title: 'Seeds' }).del(); });
    assert.equal((await knex.raw("select \"isActive\" from notes where title = 'Seeds'")).rows[0].isActive, false);
    var left = await runWithMt({ mtId1: 'c1' }, function() { return factory.table('notes'); });
    assert.deepEqual(left.map(function(r) { return r.title; }), ['Soil']);
  });

  await t.test('hooks get the same thing as ctx.db()', async function() {
    var seen = null;
    factory.registerHooks('note_edit', { get: { after: async function(ctx) { seen = await ctx.db().count('* as n').first(); } } });
    await call('GET', '/factory/records/note_edit/' + (await knex.raw("select id from notes where title = 'Soil'")).rows[0].id);
    assert.equal(Number(seen.n), 1);
  });
});
