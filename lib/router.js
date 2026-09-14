// The routes. Full paths under /factory; the host mounts the router at its
// root, the same as @xeplr/jobs.
//
//   GET  /factory/screens                  every screen: latest version, draft waiting?
//   GET  /factory/screens/:key             latest published (?draft=true → the draft, else published)
//   PUT  /factory/screens/:key/draft       save the draft          { document }
//   POST /factory/screens/:key/publish     draft → next version (refused, with the migration, if the table is not ready)
//   GET  /factory/tables                   tables published screens use
//   GET  /factory/options/:table           [{ id, name }] for a dropdown
//   GET  /factory/records/:key             a screen's records
//   POST /factory/records/:key/save        create / update         { id?, values }
//   POST /factory/records/:key/delete      soft delete             { id }
//
// Each route is in migrations-auth/0001_factory_access.sql. Responses are
// xeplr's { code, message, error, dataArray }.

var express = require('express');
var { respond } = require('@xeplr/utils/lib/response');
var { HTTP, STATUS } = require('@xeplr/utils/isomorphic');

/**
 * @param stores   { screens, records }
 * @param options.auth  a middleware for every route, or { view, write, design }
 */
function createFactoryRouter(stores, options) {
  options = options || {};
  var auth = normalizeAuth(options.auth);
  var router = express.Router();
  router.use(express.json({ limit: '2mb' }));
  var screens = stores.screens;
  var records = stores.records;

  router.get('/factory/screens', auth.view, handle(async function(req) {
    return screens.list();
  }));

  router.get('/factory/screens/:key', auth.view, handle(async function(req) {
    var key = req.params.key;
    var wantDraft = req.query.draft === 'true' || req.query.draft === '1';
    var row = (wantDraft && await screens.draft(key)) || await screens.published(key);
    if (!row) throw status(404, 'Screen "' + key + '" does not exist');
    // Field names that are already columns: the designer shows them read-only,
    // because renaming one would leave its data behind.
    var lockedNames = [];
    if (row.document.source) {
      var cols = await records.columnsOf(row.document.source);
      lockedNames = (await require('./model').load()).inputNodes(row.document)
        .map(function(n) { return n.props.name; })
        .filter(function(name) { return cols.has(name); });
    }
    return [Object.assign({}, row, { lockedNames: lockedNames })];
  }));

  router.put('/factory/screens/:key/draft', auth.design, handle(async function(req) {
    return [await screens.saveDraft(req.params.key, req.body && req.body.document, req.user)];
  }));

  router.post('/factory/screens/:key/publish', auth.design, handle(async function(req) {
    var key = req.params.key;
    var draft = await screens.draft(key);
    if (!draft) throw status(404, 'Screen "' + key + '" has no draft to publish');
    records.forget(draft.document.source);
    var previous = await screens.published(key);
    var ready = await records.readiness(draft.document, previous && previous.document);
    if (!ready.ready) {
      var err = ready.error;
      err.body = { migration: ready.error.migration };
      throw err;
    }
    var published = await screens.publishDraft(key, req.user);
    return [{ screenKey: published.screenKey, version: published.version, publishedAt: published.publishedAt }];
  }));

  router.get('/factory/tables', auth.view, handle(async function() {
    return Array.from(await records.allowedTables()).sort().map(function(t) { return { id: t, name: t }; });
  }));

  router.get('/factory/options/:table', auth.view, handle(async function(req) {
    return records.options(req.params.table);
  }));

  router.get('/factory/records/:key', auth.view, handle(async function(req) {
    return records.list(req.params.key);
  }));

  router.post('/factory/records/:key/save', auth.write, handle(async function(req) {
    return [await records.save(req.params.key, req.body || {}, req.user)];
  }));

  router.post('/factory/records/:key/delete', auth.write, handle(async function(req) {
    return [await records.remove(req.params.key, req.body && req.body.id, req.user)];
  }));

  return router;
}

/** One place for the try/catch every xeplr route has, and the error → status mapping. */
function handle(fn) {
  return async function(req, res) {
    try {
      var rows = await fn(req, res);
      respond(res, HTTP.OK, STATUS.SUCCESS, 'success', { dataArray: rows || [] });
    } catch (err) {
      sendError(res, err);
    }
  };
}

function sendError(res, err) {
  var name = err && err.name;
  if (name === 'ValidationError') {
    // schema-handler: one entry per field that failed.
    return res.status(HTTP.VALIDATION_ERROR).send({ code: STATUS.BAD_REQUEST, message: err.message, error: { fields: err.details || err.fields || [] }, dataArray: [], updatedIds: [] });
  }
  var pgCode = err && err.code;
  var httpStatus = err && err.status
    || (pgCode === '23503' ? HTTP.CONFLICT          // foreign key: a dropdown id that does not exist
      : pgCode === '23505' ? HTTP.CONFLICT          // unique
      : pgCode === '23502' || pgCode === '22P02' || pgCode === '22001' || pgCode === '22003' ? HTTP.BAD_REQUEST
      : HTTP.SERVER_ERROR);
  var message = err && err.message ? err.message : 'Something went wrong';
  if (pgCode === '23503') message = 'A chosen option no longer exists: ' + (err.detail || err.message);
  var body = {
    code: httpStatus >= 500 ? STATUS.SERVER_ERROR : STATUS.BAD_REQUEST,
    message: httpStatus >= 500 && !err.status ? 'Something went wrong' : message,
    error: err && err.fields ? { fields: err.fields } : null,
    dataArray: err && err.body ? [err.body] : [],
    updatedIds: []
  };
  if (httpStatus >= 500) console.error('[factory]', err);
  return res.status(httpStatus).send(body);
}

function status(code, message) {
  var e = new Error(message);
  e.status = code;
  return e;
}

function normalizeAuth(auth) {
  var noop = function(req, res, next) { next(); };
  if (!auth) return { view: noop, write: noop, design: noop };
  if (typeof auth === 'function') return { view: auth, write: auth, design: auth };
  return { view: auth.view || noop, write: auth.write || auth.view || noop, design: auth.design || auth.write || noop };
}

module.exports = createFactoryRouter;
