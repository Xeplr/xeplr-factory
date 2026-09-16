// The controls that do not go into their column as they are read — multi-select
// (several ids in one text column) and date-and-time (a timestamp) — and the
// file field: what the upload route accepts, and what it refuses.
//
// Against a real Postgres, like the rest of the suite; skipped, out loud, when
// there is none.

var { test, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');
var http = require('node:http');
var express = require('express');
var knexLib = require('knex');
var { registerMTs, runWithMt } = require('@xeplr/db');
var factory = require('..');

var DB = 'xeplr_factory_files_' + process.pid;
var FILES = path.join(os.tmpdir(), 'xeplr-factory-files-' + process.pid);
var admin, knex, server, base, model, skip = null;

async function call(method, url, body, company) {
  var res = await fetch(base + url, {
    method: method,
    headers: Object.assign({ 'x-company-id': company || 'c1' }, body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

/** One file, as a browser sends it: multipart, in a field called "file". */
async function upload(url, name, content, type) {
  var form = new FormData();
  form.append('file', new Blob([content], { type: type || 'application/octet-stream' }), name);
  var res = await fetch(base + url, { method: 'POST', headers: { 'x-company-id': 'c1' }, body: form });
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
  await factory.init({ knex: knex, filesDir: FILES });
  var app = express();
  app.use(function(req, res, next) { req.user = { id: 'u1' }; runWithMt({ mtId1: req.headers['x-company-id'] }, next); });
  app.use(factory.router());
  server = http.createServer(app);
  await new Promise(function(r) { server.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;

  var survey = model.screensFromSpec({
    entity: 'survey',
    fields: [
      { label: 'Title', required: true },
      { label: 'Topics', type: 'multiselect', options: ['Soil', 'Water', 'Seed'] },
      { label: 'Mood', type: 'radio', options: ['Happy', 'Sad'] },
      { label: 'Starts at', type: 'datetime' },
      { label: 'Report', type: 'file', accept: '.pdf,.txt', maxSize: 1 }
    ]
  });
  await factory.publishScreens([survey.edit, survey.list]);
});

after(async function() {
  if (server) await new Promise(function(r) { server.close(r); });
  if (knex) await knex.destroy();
  if (admin && !skip) await admin.raw('DROP DATABASE IF EXISTS ??', [DB]);
  if (admin) await admin.destroy();
  fs.rmSync(FILES, { recursive: true, force: true });
});

test('multi-select, date-and-time, and files', async function(t) {
  if (skip) { t.skip(skip); return; }
  var id;

  await t.test('a multi-select is one text column, and an array on the wire', async function() {
    var saved = await call('POST', '/factory/records/survey_edit/save', {
      values: { title: 'Spring', topics: ['soil', 'water'], mood: 'happy' }
    });
    assert.equal(saved.status, 200, saved.body.message);
    id = saved.body.dataArray[0].id;
    assert.deepEqual(saved.body.dataArray[0].topics, ['soil', 'water'], 'the saved row comes back as an array');

    var raw = (await knex.raw('select topics, mood from surveys where id = ?', [id])).rows[0];
    assert.equal(raw.topics, 'soil,water', 'one column, ids joined by commas');
    assert.equal(raw.mood, 'happy', 'a radio is one id, like a dropdown');

    var one = await call('GET', '/factory/records/survey_edit/' + id);
    assert.deepEqual(one.body.dataArray[0].topics, ['soil', 'water']);
    var list = await call('GET', '/factory/records/survey_list');
    assert.deepEqual(list.body.dataArray[0].topics, ['soil', 'water'], 'the list sends the converted value');

    var emptied = await call('POST', '/factory/records/survey_edit/save', { id: id, values: { title: 'Spring', topics: [] } });
    assert.equal(emptied.status, 200, emptied.body.message);
    assert.equal((await knex.raw('select topics from surveys where id = ?', [id])).rows[0].topics, null, 'nothing chosen is nothing stored');
  });

  await t.test('a date and time comes back as the moment that was typed in', async function() {
    var saved = await call('POST', '/factory/records/survey_edit/save', {
      id: id, values: { title: 'Spring', topics: ['seed'], startsAt: '2026-10-01T09:30' }
    });
    assert.equal(saved.status, 200, saved.body.message);
    assert.equal(saved.body.dataArray[0].startsAt, '2026-10-01T09:30');
    assert.equal((await knex.raw('select "startsAt"::text as at from surveys where id = ?', [id])).rows[0].at, '2026-10-01 09:30:00');
    var one = await call('GET', '/factory/records/survey_edit/' + id);
    assert.equal(one.body.dataArray[0].startsAt, '2026-10-01T09:30', 'and again when it is read back');
  });

  await t.test('a choice that is not on the screen\'s own list is refused', async function() {
    var strayed = await call('POST', '/factory/records/survey_edit/save', {
      values: { title: 'Autumn', topics: ['soil', 'moon'] }
    });
    assert.equal(strayed.status, 400, JSON.stringify(strayed.body));
    assert.match(strayed.body.message, /moon/);
    assert.deepEqual(strayed.body.error.fields.map(function(f) { return f.field; }), ['topics']);
    assert.equal((await knex.raw("select count(*) as n from surveys where title = 'Autumn'")).rows[0].n, '0');

    // One value, one option list: the screen's rules already say so (422).
    var badRadio = await call('POST', '/factory/records/survey_edit/save', { values: { title: 'Autumn', mood: 'furious' } });
    assert.equal(badRadio.status, 422, JSON.stringify(badRadio.body));
  });

  var stored;

  await t.test('an upload is kept per company and per table, under its own name', async function() {
    var res = await upload('/factory/files/survey_edit/report', 'Field notes (May).txt', 'sun and rain\n', 'text/plain');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    stored = res.body.dataArray[0];
    assert.equal(stored.name, 'Field notes (May).txt', 'the name the person gave it');
    assert.equal(stored.size, 13);
    // Spaces and brackets are not in a path this app writes, so they are not.
    assert.match(stored.path, /^c1\/surveys\/[A-Za-z0-9]+__Field_notes_May_\.txt$/, stored.path);
    assert.equal(fs.readFileSync(path.join(FILES, stored.path), 'utf8'), 'sun and rain\n');

    var saved = await call('POST', '/factory/records/survey_edit/save', { id: id, values: { title: 'Spring', report: stored.path } });
    assert.equal(saved.status, 200, saved.body.message);
    assert.equal(saved.body.dataArray[0].report, stored.path, 'the column holds the path');
  });

  await t.test('and comes back only through the route, under the name it was given', async function() {
    var res = await fetch(base + '/factory/files/' + stored.path, { headers: { 'x-company-id': 'c1' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="Field_notes_May_\.txt"/, 'the name after the id, not the id');
    assert.equal(await res.text(), 'sun and rain\n');

    var missing = await fetch(base + '/factory/files/c1/surveys/nothing__here.txt', { headers: { 'x-company-id': 'c1' } });
    assert.equal(missing.status, 404);
  });

  await t.test('another company cannot fetch the file, path or no path', async function() {
    var other = await fetch(base + '/factory/files/' + stored.path, { headers: { 'x-company-id': 'c2' } });
    assert.equal(other.status, 404, 'the same path, from another company');
    // The folder is the line: its own company still gets it.
    var ours = await fetch(base + '/factory/files/' + stored.path, { headers: { 'x-company-id': 'c1' } });
    assert.equal(ours.status, 200);
  });

  await t.test('a path that climbs out of the files directory is refused', async function() {
    var res = await fetch(base + '/factory/files/..%2f..%2fetc%2fpasswd', { headers: { 'x-company-id': 'c1' } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).message, /not in this app/);
  });

  await t.test('the field\'s own rules decide: the extension, then the size', async function() {
    var wrongKind = await upload('/factory/files/survey_edit/report', 'payload.exe', 'MZ', 'text/plain');
    assert.equal(wrongKind.status, 400, JSON.stringify(wrongKind.body));
    assert.match(wrongKind.body.message, /\.pdf, \.txt/);

    var tooBig = await upload('/factory/files/survey_edit/report', 'huge.txt', 'x'.repeat(1024 * 1024 + 10), 'text/plain');
    assert.equal(tooBig.status, 400, JSON.stringify(tooBig.body));
    assert.match(tooBig.body.message, /up to 1 MB/);

    assert.deepEqual(fs.readdirSync(path.join(FILES, '.incoming')), [], 'nothing a field refused is left behind');
  });

  await t.test('only a file field takes a file', async function() {
    var notAFile = await upload('/factory/files/survey_edit/title', 'notes.txt', 'hello', 'text/plain');
    assert.equal(notAFile.status, 400, JSON.stringify(notAFile.body));
    assert.match(notAFile.body.message, /is not a file field/);

    var noSuchField = await upload('/factory/files/survey_edit/invoice', 'notes.txt', 'hello', 'text/plain');
    assert.equal(noSuchField.status, 404, JSON.stringify(noSuchField.body));

    var nothingSent = await call('POST', '/factory/files/survey_edit/report');
    assert.equal(nothingSent.status, 400, JSON.stringify(nothingSent.body));
    assert.match(nothingSent.body.message, /No file was sent/);

    var wrongField = new FormData();
    wrongField.append('attachment', new Blob(['hello']), 'notes.txt');
    var misnamed = await fetch(base + '/factory/files/survey_edit/report', { method: 'POST', headers: { 'x-company-id': 'c1' }, body: wrongField });
    assert.equal(misnamed.status, 400);
    assert.match((await misnamed.json()).message, /form field named "file"/);
  });
});
