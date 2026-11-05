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
var { registerMTs, runWithMt, registerApplication } = require('@xeplr/db');
var actions = require('@xeplr/actions');
var factory = require('..');
var applyMigrations = require('./applyMigrations');

var DB = 'xeplr_factory_files_' + process.pid;
// The data root an app sets: each company's screen files are in its own
// <root>/<app>/<company>/screens folder.
var DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-factory-data-')));
process.env.XEPLR_DATA_DIR = DATA;
var FILES = path.join(DATA, 'xeplr-factory-test', 'c1', 'screens');
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
async function upload(url, name, content, type, user) {
  var form = new FormData();
  form.append('file', new Blob([content], { type: type || 'application/octet-stream' }), name);
  var res = await fetch(base + url, { method: 'POST', headers: Object.assign({ 'x-company-id': 'c1' }, user ? { 'x-user-id': user } : {}), body: form });
  return { status: res.status, body: await res.json() };
}

before(async function() {
  admin = knexLib({ client: 'pg', connection: { database: 'postgres' } });
  try { await admin.raw('SELECT 1'); } catch (err) { skip = 'no Postgres available (' + err.message + ')'; return; }
  await admin.raw('DROP DATABASE IF EXISTS ??', [DB]);
  await admin.raw('CREATE DATABASE ??', [DB]);
  knex = knexLib({ client: 'pg', connection: { database: DB } });
  await applyMigrations(knex, factory.migrationsDir);
  registerApplication('xeplr-factory-test');
  registerMTs({ l1: { name: 'companyId', header: 'x-company-id' } });
  model = await import('@xeplr/ui-factory/model');
  await assert.rejects(factory.init({ knex: knex, filesDir: '/somewhere' }), /filesDir is gone/);
  await factory.init({ knex: knex });
  var app = express();
  app.use(function(req, res, next) { req.user = { id: req.headers['x-user-id'] || 'u1' }; runWithMt({ mtId1: req.headers['x-company-id'] }, next); });
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

  await t.test('an upload is kept in its company\'s own folder, per table, under its own name', async function() {
    var res = await upload('/factory/files/survey_edit/report', 'Field notes (May).txt', 'sun and rain\n', 'text/plain');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    stored = res.body.dataArray[0];
    assert.equal(stored.name, 'Field notes (May).txt', 'the name the person gave it');
    assert.equal(stored.size, 13);
    // Spaces and brackets are not in a path this app writes, so they are not.
    assert.match(stored.path, /^surveys\/[A-Za-z0-9]+__Field_notes_May_\.txt$/, stored.path);
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

    var missing = await fetch(base + '/factory/files/surveys/nothing__here.txt', { headers: { 'x-company-id': 'c1' } });
    assert.equal(missing.status, 404);
  });

  await t.test('another company cannot fetch the file, path or no path', async function() {
    var other = await fetch(base + '/factory/files/' + stored.path, { headers: { 'x-company-id': 'c2' } });
    assert.equal(other.status, 404, 'the same path, from another company, names nothing in its folder');
    var climb = await fetch(base + '/factory/files/..%2f..%2fc1%2fscreens%2f' + encodeURIComponent(stored.path), { headers: { 'x-company-id': 'c2' } });
    assert.equal(climb.status, 400, 'and climbing to it is refused');
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

// ── several files in one field, and a button whose press takes files ───────

var given = [];

test('several files, and a button that takes them', async function(t) {
  if (skip) { t.skip(skip); return; }
  var recordId;

  // A form whose Photos field holds several pictures.
  var parcel = model.screensFromSpec({ entity: 'parcel', fields: [{ label: 'Label', required: true }, { label: 'Photos', type: 'file', accept: '.png,.jpg', maxSize: 1 }] });
  var photosNode = parcel.edit.nodes.find(function(n) { return n.props && n.props.name === 'photos'; });
  var edit = model.setNodeProperty(parcel.edit, photosNode.id, 'props.multiple', true);
  edit = model.setNodeProperty(edit, photosNode.id, 'props.maxFiles', 3);

  await t.test('a field holding several files is a text column, and a list on the wire', async function() {
    await factory.publishScreens([edit, parcel.list]);
    var col = await knex('information_schema.columns').where({ table_name: 'parcels', column_name: 'photos' }).first('data_type');
    assert.equal(col.data_type, 'text');
    var a = await upload('/factory/files/parcel_edit/photos', 'front.png', 'PNG1', 'image/png');
    var b = await upload('/factory/files/parcel_edit/photos', 'back.jpg', 'JPG1', 'image/jpeg');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    var saved = await call('POST', '/factory/records/parcel_edit/save', { values: { label: 'P1', photos: [a.body.dataArray[0].path, b.body.dataArray[0].path] } });
    assert.equal(saved.status, 200, saved.body.message);
    recordId = saved.body.dataArray[0].id;
    var row = await knex('parcels').where('id', recordId).first('photos');
    assert.equal(row.photos, a.body.dataArray[0].path + ',' + b.body.dataArray[0].path, 'one text column, comma separated');
    var back = await call('GET', '/factory/records/parcel_edit/' + recordId);
    assert.deepEqual(back.body.dataArray[0].photos, [a.body.dataArray[0].path, b.body.dataArray[0].path]);
  });

  await t.test('...more than maxFiles is refused, as the screen says', async function() {
    var res = await call('POST', '/factory/records/parcel_edit/save', { id: recordId, values: { label: 'P1', photos: ['parcels/a__1.png', 'parcels/b__2.png', 'parcels/c__3.png', 'parcels/d__4.png'] } });
    assert.equal(res.status, 422, res.body.message);
    assert.match(res.body.message, /at most 3/);
  });

  // A button whose press takes photos.
  actions.register({
    name: 'addParcelPhotos', event: 'button',
    inputSchema: [{ name: 'files', type: 'array', required: true }, { name: 'note', type: 'string' }],
    execute: function(arg) {
      given.push({ input: arg.input, files: arg.system.files.map(function(f) { return { path: f.path, name: f.name, size: f.size, bytes: fs.readFileSync(f.fullPath, 'utf8') }; }) });
      return { message: arg.system.files.length + ' added to ' + arg.system.record.label };
    }
  });
  var PHOTOS = { id: 'photos', label: 'Add photos', action: 'addParcelPhotos',
    ask: { note: 'Note', file: { label: 'Photos', accept: '.png,.jpg', maxSize: 1, multiple: true, maxFiles: 2, required: true } } };
  var actionsDoc = model.addControl(model.createScreen({ id: 'parcel_actions', name: 'Parcel actions', source: 'parcels' }), 'buttons', { props: { buttons: [PHOTOS] } }).document;

  await t.test('a button that asks for a file publishes only when its function takes "files"', async function() {
    await factory.publishScreens([actionsDoc]);
  });

  var stored = [];
  await t.test('POST /factory/buttons/:screen/:button/files: checked against ask.file, kept for this button and this person', async function() {
    var a = await upload('/factory/buttons/parcel_actions/photos/files', 'door.png', 'DOOR', 'image/png');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.match(a.body.dataArray[0].path, /^parcels\/_buttons\/photos\/u1\/[^/]+__door\.png$/);
    stored.push(a.body.dataArray[0].path);
    assert.ok(fs.existsSync(path.join(FILES, a.body.dataArray[0].path)));
    var pdf = await upload('/factory/buttons/parcel_actions/photos/files', 'scan.pdf', '%PDF', 'application/pdf');
    assert.equal(pdf.status, 400);
    assert.match(pdf.body.message, /"Photos" takes \.png, \.jpg/);
    var big = await upload('/factory/buttons/parcel_actions/photos/files', 'huge.png', 'x'.repeat(1024 * 1024 + 10), 'image/png');
    assert.equal(big.status, 400);
    var none = await upload('/factory/buttons/parcel_actions/nothing/files', 'door.png', 'DOOR', 'image/png');
    assert.equal(none.status, 404, 'a button the screen does not have');
    assert.deepEqual(fs.readdirSync(path.join(FILES, '.incoming')), [], 'nothing refused is left behind');
  });

  await t.test('a press with them: the function gets the paths, and the bytes through system.files', async function() {
    var res = await call('POST', '/factory/buttons/parcel_actions/photos', { id: recordId, note: 'at the door', files: stored });
    assert.equal(res.status, 200, res.body.message);
    assert.equal(res.body.dataArray[0].message, '1 added to P1');
    var got = given.pop();
    assert.deepEqual(got.input, { note: 'at the door', files: stored });
    assert.deepEqual(got.files, [{ path: stored[0], name: 'door.png', size: 4, bytes: 'DOOR' }]);
  });

  await t.test('...none, when required, is refused before anything runs', async function() {
    var res = await call('POST', '/factory/buttons/parcel_actions/photos', { id: recordId });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Photos is required');
    assert.equal(given.length, 0);
  });

  await t.test('...more than maxFiles is refused', async function() {
    var res = await call('POST', '/factory/buttons/parcel_actions/photos', { id: recordId, files: [stored[0], stored[0], stored[0]] });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /at most 2 files/);
  });

  await t.test('...a path typed by hand — another field\'s file, or one climbing out — is refused', async function() {
    var field = await upload('/factory/files/parcel_edit/photos', 'other.png', 'OTHER', 'image/png');
    for (var p of [field.body.dataArray[0].path, 'parcels/_buttons/photos/u1/../../../../etc/passwd', '/etc/passwd']) {
      var res = await call('POST', '/factory/buttons/parcel_actions/photos', { id: recordId, files: [p] });
      assert.equal(res.status, 400, p + ': ' + res.body.message);
      assert.match(res.body.message, /is not a file stored for "Add photos"/);
    }
    assert.equal(given.length, 0);
  });

  await t.test('...another person\'s file is refused', async function() {
    var theirs = await upload('/factory/buttons/parcel_actions/photos/files', 'mine.png', 'MINE', 'image/png', 'u2');
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
    var res = await call('POST', '/factory/buttons/parcel_actions/photos', { id: recordId, files: [theirs.body.dataArray[0].path] });
    assert.equal(res.status, 400);
  });

  await t.test('...files to a button that takes none are refused', async function() {
    actions.register({ name: 'archiveParcel', event: 'button', inputSchema: [], execute: function() { given.push('archive'); return {}; } });
    var doc = model.addControl(model.createScreen({ id: 'parcel_more', name: 'More', source: 'parcels' }), 'buttons', { props: { buttons: [{ id: 'archive', label: 'Archive', action: 'archiveParcel' }] } }).document;
    await factory.publishScreens([doc]);
    var res = await call('POST', '/factory/buttons/parcel_more/archive', { id: recordId, files: stored });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'This button takes no files');
    var up = await upload('/factory/buttons/parcel_more/archive/files', 'door.png', 'DOOR', 'image/png');
    assert.equal(up.status, 400);
    assert.match(up.body.message, /takes no files/);
    assert.equal(given.length, 0);
  });

  await t.test('...the file is still read back through the signed route', async function() {
    var res = await fetch(base + '/factory/files/' + stored[0], { headers: { 'x-company-id': 'c1' } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'DOOR');
  });
});
