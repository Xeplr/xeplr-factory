// The routes. Full paths under /factory; the host mounts the router at its
// root, the same as @xeplr/jobs.
//
//   GET  /factory/screens                  every screen: latest version, draft waiting?
//   GET  /factory/screens/:key             latest published (?draft=true → the draft, else published)
//   PUT  /factory/screens/:key/draft       save the draft          { document }
//   POST /factory/screens/:key/publish     draft → next version, and its table changed to match   { confirmDrop?, confirmConvert? }
//   POST /factory/entities                 a new form: its list + edit screens as drafts   { entity, plural? }
//   GET  /factory/tables                   tables published screens use
//   GET  /factory/options/:table           [{ id, name }] for a dropdown
//   GET  /factory/records/:key             a screen's records
//   GET  /factory/records/:key/:id         one record
//   POST /factory/records/:key/save        create / update         { id?, values }
//   POST /factory/records/:key/delete      soft delete             { id }
//   POST /factory/files/:key/:field        one file for a file field (multipart "file")
//   GET  /factory/files/<stored path>      that file back, to whoever may read the record
//
// Each route is in the access catalog (migrations-auth/), under the name in
// API_NAMES. With { access: true } a route answers only a caller whose
// req.access.apis — set by the auth gate from /auth/api/me — holds its name.
// Responses are xeplr's { code, message, error, dataArray }.

var express = require('express');
var { respond } = require('@xeplr/utils/lib/response');
var { HTTP, STATUS } = require('@xeplr/utils/isomorphic');

// Route → its row in the "apis" catalog. The names are the ones the
// migrations-auth SQL inserts; change one here and there together.
var API_NAMES = {
  listScreens: 'List factory screens',
  getScreen: 'Get factory screen',
  saveDraft: 'Save factory screen draft',
  publish: 'Publish factory screen',
  createEntity: 'Create factory form',
  listTables: 'List factory tables',
  listOptions: 'List factory options',
  listRecords: 'List factory records',
  getRecord: 'Get factory record',
  saveRecord: 'Save factory record',
  deleteRecord: 'Delete factory record'
};

/**
 * @param stores   { screens, records }
 * @param options.auth    a middleware for every route, or { view, write, design }
 * @param options.access  true: each route also requires its API_NAMES entry in req.access.apis
 */
function createFactoryRouter(stores, options) {
  options = options || {};
  var areas = normalizeAuth(options.auth);
  // auth.view(name) → [the area's middleware, and the catalog check when asked for]
  var auth = {};
  ['view', 'write', 'design'].forEach(function(area) {
    auth[area] = function(name) { return options.access ? [areas[area], requireApi(name)] : [areas[area]]; };
  });
  var router = express.Router();
  router.use(express.json({ limit: '2mb' }));
  var screens = stores.screens;
  var records = stores.records;
  var files = stores.files;

  router.get('/factory/screens', auth.view(API_NAMES.listScreens), handle(async function(req) {
    return screens.list();
  }));

  router.get('/factory/screens/:key', auth.view(API_NAMES.getScreen), handle(async function(req) {
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

  router.put('/factory/screens/:key/draft', auth.design(API_NAMES.saveDraft), handle(async function(req) {
    return [await screens.saveDraft(req.params.key, req.body && req.body.document, req.user)];
  }));

  router.post('/factory/screens/:key/publish', auth.design(API_NAMES.publish), handle(async function(req) {
    var body = req.body || {};
    var confirmDrop = Array.isArray(body.confirmDrop) ? body.confirmDrop.map(String) : [];
    var confirmConvert = Array.isArray(body.confirmConvert) ? body.confirmConvert.map(String) : [];
    var result = await records.publish(req.params.key, { confirmDrop: confirmDrop, confirmConvert: confirmConvert }, req.user);
    return [Object.assign({ screenKey: req.params.key }, result)];
  }));

  router.post('/factory/entities', auth.design(API_NAMES.createEntity), handle(async function(req) {
    return [await stores.entities.create(req.body || {}, req.user)];
  }));

  router.get('/factory/tables', auth.view(API_NAMES.listTables), handle(async function() {
    return Array.from(await records.allowedTables()).sort().map(function(t) { return { id: t, name: t }; });
  }));

  router.get('/factory/options/:table', auth.view(API_NAMES.listOptions), handle(async function(req) {
    return records.options(req.params.table);
  }));

  router.get('/factory/records/:key', auth.view(API_NAMES.listRecords), handle(async function(req) {
    return records.get(req.params.key, null, req.user);
  }));

  router.get('/factory/records/:key/:id', auth.view(API_NAMES.getRecord), handle(async function(req) {
    var row = await records.get(req.params.key, req.params.id, req.user);
    return Array.isArray(row) ? row : [row];
  }));

  router.post('/factory/records/:key/save', auth.write(API_NAMES.saveRecord), handle(async function(req) {
    var saved = await records.save(req.params.key, req.body || {}, req.user);
    return Array.isArray(saved) ? saved : [saved];
  }));

  router.post('/factory/records/:key/delete', auth.write(API_NAMES.deleteRecord), handle(async function(req) {
    var removed = await records.remove(req.params.key, req.body && req.body.id, req.user);
    return Array.isArray(removed) ? removed : [removed];
  }));

  // ── files ───────────────────────────────────────────────────────────────
  // A file field's value is a path, so uploading one is saving a record's
  // value: the upload is guarded like save, and reading it back like get.
  // Neither adds a row to the access catalog.

  router.post('/factory/files/:key/:field', auth.write(API_NAMES.saveRecord), receive('file'), handle(async function(req) {
    return [await files.store(req.params.key, req.params.field, req.file)];
  }));

  // The stored path is the rest of the URL — a RegExp because a trailing
  // wildcard is spelt differently in express 4 and 5.
  router.get(/^\/factory\/files\/(.+)$/, auth.view(API_NAMES.getRecord), async function(req, res) {
    try {
      var file = await files.download(req.params[0]);
      res.download(file.path, file.name);
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * multer, for one file, made on the first upload. Its middleware ends with
   * an error handler of its own; this runs the chain and turns what it refuses
   * into the same { code, message, … } as every other route.
   */
  function receive(fieldName) {
    return async function(req, res, next) {
      var chain;
      try {
        chain = await files.uploadChain(fieldName);
      } catch (err) {
        return sendError(res, err);                 // multer is not installed
      }
      var steps = chain.slice(0, -1);
      var i = 0;
      (function step(err) {
        if (err) return sendError(res, uploadError(err));
        var fn = steps[i++];
        if (!fn) return next();
        try { fn(req, res, step); } catch (e) { step(e); }
      })();
    };
  }

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

/** What multer refuses on its own, said the way this package says everything else. */
function uploadError(err) {
  var code = err && err.code;
  if (code === 'LIMIT_FILE_SIZE') return status(HTTP.BAD_REQUEST, 'That file is larger than this app accepts');
  if (code === 'LIMIT_UNEXPECTED_FILE') return status(HTTP.BAD_REQUEST, 'Send one file, in a form field named "file"');
  return err;
}

/**
 * The caller may use this route only if its access list names it.
 *
 * FAILS CLOSED: a request with no req.access at all is refused, not waved
 * through — it means the router is mounted where no auth gate ran, and "we
 * could not tell" must never read as "allowed".
 */
function requireApi(name) {
  return function(req, res, next) {
    var apis = req.access && req.access.apis;
    if (!Array.isArray(apis)) {
      return res.status(HTTP.FORBIDDEN).send({ code: STATUS.FORBIDDEN, message: 'No access information on the request — mount @xeplr/factory behind the auth gate', error: null, dataArray: [], updatedIds: [] });
    }
    if (apis.indexOf(name) === -1) {
      return res.status(HTTP.FORBIDDEN).send({ code: STATUS.FORBIDDEN, message: 'Access denied: ' + name, error: null, dataArray: [], updatedIds: [] });
    }
    next();
  };
}

function normalizeAuth(auth) {
  var noop = function(req, res, next) { next(); };
  if (!auth) return { view: noop, write: noop, design: noop };
  if (typeof auth === 'function') return { view: auth, write: auth, design: auth };
  return { view: auth.view || noop, write: auth.write || auth.view || noop, design: auth.design || auth.write || noop };
}

module.exports = createFactoryRouter;
module.exports.API_NAMES = API_NAMES;
