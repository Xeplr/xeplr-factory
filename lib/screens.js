// factory_screens — the designs, versioned.
//
//   draft      at most one per screen: what the designer autosaves into
//   published  every version ever published; screens render the latest
//
// Every query is tenant-scoped (lib/tenancy.js); a row with mtIdN = '*' is a
// screen shared by every tenant.

var { generateId } = require('@xeplr/utils/lib/helpers');
var { scope, stampTenant, stampAudit } = require('./tenancy');
var factoryModel = require('./model');

var TABLE = 'factory_screens';
var COLUMNS = new Set([
  'id', 'screenKey', 'version', 'status', 'name', 'source', 'document', 'publishedAt', 'publishedBy',
  'isActive', 'mtId1', 'mtId2', 'mtId3', 'mtId4',
  'recordCreatedDate', 'recordModifiedDate', 'recordCreatedBy', 'recordModifiedBy'
]);

function createScreensStore(knex) {
  function q() { return scope(knex(TABLE), TABLE, COLUMNS); }

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      screenKey: row.screenKey,
      version: row.version,
      status: row.status,
      name: row.name,
      source: row.source,
      document: typeof row.document === 'string' ? JSON.parse(row.document) : row.document,
      publishedAt: row.publishedAt,
      recordModifiedDate: row.recordModifiedDate
    };
  }

  /** The latest published version of a screen, or null. */
  async function published(screenKey) {
    var row = await q().where({ screenKey: screenKey, status: 'published' }).orderBy('version', 'desc').first();
    return shape(row);
  }

  async function draft(screenKey) {
    return shape(await q().where({ screenKey: screenKey, status: 'draft' }).first());
  }

  /** One row per screen: its latest published version, and whether a draft is waiting. */
  async function list() {
    var rows = await q().select('screenKey', 'version', 'status', 'name', 'source', 'recordModifiedDate')
      .orderBy('screenKey').orderBy('version', 'desc');
    var byKey = new Map();
    rows.forEach(function(r) {
      var entry = byKey.get(r.screenKey) || { screenKey: r.screenKey, name: r.name, source: r.source, version: null, hasDraft: false };
      if (r.status === 'draft') { entry.hasDraft = true; if (!entry.name) entry.name = r.name; }
      else if (entry.version === null) { entry.version = r.version; entry.name = r.name; entry.source = r.source; }
      byKey.set(r.screenKey, entry);
    });
    return Array.from(byKey.values());
  }

  /** Every published screen's latest document — for "which tables may be read". */
  async function allPublished() {
    var rows = await q().where({ status: 'published' }).orderBy('screenKey').orderBy('version', 'desc');
    var seen = new Set();
    return rows.filter(function(r) {
      if (seen.has(r.screenKey)) return false;
      seen.add(r.screenKey);
      return true;
    }).map(shape);
  }

  /**
   * Save the draft. Refuses a document that does not validate, or whose id is
   * not the screen it is saved as.
   */
  async function saveDraft(screenKey, document, user) {
    var model = await factoryModel.load();
    if (!document || document.id !== screenKey) {
      throw badRequest('The document\'s id "' + (document && document.id) + '" is not the screen "' + screenKey + '"');
    }
    var check = model.validateDocument(document);
    if (!check.ok) throw invalidDocument(check.errors);

    return knex.transaction(async function(trx) {
      var scoped = function() { return scope(trx(TABLE), TABLE, COLUMNS); };
      var existing = await scoped().where({ screenKey: screenKey, status: 'draft' }).first();
      var patch = { name: document.name, source: document.source || null, document: JSON.stringify(document) };
      if (existing) {
        stampAudit(patch, COLUMNS, user, false);
        await scoped().where({ id: existing.id }).update(patch);
        return shape(await scoped().where({ id: existing.id }).first());
      }
      var top = await scoped().where({ screenKey: screenKey }).max('version as v').first();
      var row = Object.assign({ id: generateId(), screenKey: screenKey, version: (top && top.v ? Number(top.v) : 0) + 1, status: 'draft' }, patch);
      stampTenant(row, COLUMNS);
      stampAudit(row, COLUMNS, user, true);
      await trx(TABLE).insert(row);
      return shape(row);
    });
  }

  /** The draft becomes the next published version. */
  async function publishDraft(screenKey, user) {
    return knex.transaction(async function(trx) {
      var scoped = function() { return scope(trx(TABLE), TABLE, COLUMNS); };
      var row = await scoped().where({ screenKey: screenKey, status: 'draft' }).first();
      if (!row) throw notFound('Screen "' + screenKey + '" has no draft to publish');
      var patch = { status: 'published', publishedAt: new Date() };
      if (user && user.id) patch.publishedBy = String(user.id).slice(0, 25);
      stampAudit(patch, COLUMNS, user, false);
      await scoped().where({ id: row.id }).update(patch);
      return shape(await scoped().where({ id: row.id }).first());
    });
  }

  return { published: published, draft: draft, list: list, allPublished: allPublished, saveDraft: saveDraft, publishDraft: publishDraft };
}

function badRequest(message) { var e = new Error(message); e.status = 400; return e; }
function notFound(message) { var e = new Error(message); e.status = 404; return e; }
function invalidDocument(errors) {
  var e = new Error('The screen has ' + errors.length + ' problem' + (errors.length === 1 ? '' : 's') + ': ' + errors.slice(0, 3).map(function(x) { return (x.path || '(screen)') + ' ' + x.message; }).join('; '));
  e.status = 422;
  e.fields = errors;
  return e;
}

module.exports = { createScreensStore: createScreensStore, TABLE: TABLE };
