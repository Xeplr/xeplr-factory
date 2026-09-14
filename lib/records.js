// Records, in the entity's REAL table.
//
// A screen's `source` is a table ("employees") and each of its fields is a
// column named exactly as the field. Records are read and written with plain
// select / insert / update — no JSON, nothing a report cannot query.
//
// ── what a request may touch ─────────────────────────────────────────────
// Table and column names come ONLY from a PUBLISHED screen, never from the
// request: a request names a screen, the screen names its table and columns,
// and every name is checked against the table's real columns before it reaches
// knex (as an identifier, never interpolated into SQL). Values are checked
// against the screen's own rules with @xeplr/schema-handler's applySchema — the
// same rules the form enforced in the browser.

var { generateId } = require('@xeplr/utils/lib/helpers');
var { applySchema } = require('@xeplr/schema-handler');
var { scope, stampTenant, stampAudit } = require('./tenancy');
var factoryModel = require('./model');

var LIST_LIMIT = 1000;

function createRecordsStore(knex, screens) {
  // table → { at, columns: Map(name → { dataType, udtName }) }
  var columnCache = new Map();
  var COLUMN_TTL = 30000;

  /** The table's real columns. Cached briefly; forget() after a migration or publish. */
  async function columnsOf(table) {
    var hit = columnCache.get(table);
    if (hit && Date.now() - hit.at < COLUMN_TTL) return hit.columns;
    var rows = await knex('information_schema.columns')
      .select('column_name', 'data_type', 'udt_name')
      .where({ table_schema: knex.raw('current_schema()'), table_name: table });
    var columns = new Map(rows.map(function(r) { return [r.column_name, { dataType: r.data_type, udtName: r.udt_name }]; }));
    columnCache.set(table, { at: Date.now(), columns: columns });
    return columns;
  }

  /**
   * The select list for id + fields. A DATE column is read as text: pg would
   * otherwise hand back a JavaScript Date at local midnight, and turning that
   * back into "YYYY-MM-DD" can move it a day in any timezone east or west of UTC.
   */
  function selectList(table, fields, columns) {
    return ['id'].concat(fields).map(function(f) {
      var info = columns.get(f);
      if (info && info.udtName === 'date') return knex.raw('??::text as ??', [table + '.' + f, f]);
      return table + '.' + f;
    });
  }

  /** numeric comes back from pg as a string (it can exceed a JS number); the form wants a number. */
  function shapeRow(row, columns) {
    if (!row) return row;
    var out = {};
    Object.keys(row).forEach(function(k) {
      var info = columns.get(k);
      var v = row[k];
      out[k] = info && info.udtName === 'numeric' && v !== null && v !== undefined ? Number(v) : v;
    });
    return out;
  }

  function forget(table) {
    if (table) columnCache.delete(table); else columnCache.clear();
  }

  /**
   * The published screen a request names, and the edit screen whose fields
   * describe the table — itself, or for a list screen, the screen it edits in.
   */
  async function resolve(screenKey) {
    var model = await factoryModel.load();
    var screen = await screens.published(screenKey);
    if (!screen) throw notFound('Screen "' + screenKey + '" is not published');
    var doc = screen.document;
    var fieldsDoc = doc;
    if (!model.inputNodes(doc).length) {
      var list = doc.nodes.find(function(n) { return n.type === 'list' && n.props.editScreen; });
      var edit = list ? await screens.published(list.props.editScreen) : null;
      if (!edit) throw conflict('Screen "' + screenKey + '" has no fields, and the screen its list edits in is not published');
      fieldsDoc = edit.document;
    }
    var table = doc.source || fieldsDoc.source;
    if (!table) throw conflict('Screen "' + screenKey + '" does not say which table its records are in (source)');
    return { model: model, doc: doc, fieldsDoc: fieldsDoc, table: table };
  }

  /**
   * The fields that must be columns, and the ones that are missing.
   * @returns {{ fields, columns, missing }}
   */
  async function checkTable(model, fieldsDoc, table) {
    var fields = model.inputNodes(fieldsDoc).map(function(n) { return n.props.name; });
    var columns = await columnsOf(table);
    if (!columns.size) return { fields: fields, columns: columns, missing: fields, noTable: true };
    return { fields: fields, columns: columns, missing: fields.filter(function(f) { return !columns.has(f); }), noTable: false };
  }

  function tableProblem(table, check) {
    var e = conflict(check.noTable
      ? 'Table "' + table + '" does not exist — run its migration (xeplr-factory migration) first'
      : 'Table "' + table + '" has no column for: ' + check.missing.join(', ') + ' — run the migration that adds them');
    e.missing = check.missing;
    return e;
  }

  /** The records a screen lists: id and every field column, newest first. */
  async function list(screenKey) {
    var r = await resolve(screenKey);
    var check = await checkTable(r.model, r.fieldsDoc, r.table);
    if (check.noTable || check.missing.length) throw tableProblem(r.table, check);
    var cols = new Set(check.columns.keys());
    var query = scope(knex(r.table).select(selectList(r.table, check.fields, check.columns)), r.table, cols);
    if (cols.has('recordModifiedDate')) query.orderBy(r.table + '.recordModifiedDate', 'desc');
    var rows = await query.limit(LIST_LIMIT);
    return rows.map(function(row) { return shapeRow(row, check.columns); });
  }

  /**
   * Create (no id) or update (id) a record from what an edit screen entered.
   * @returns the saved row: id and the field columns
   */
  async function save(screenKey, body, user) {
    var r = await resolve(screenKey);
    if (r.fieldsDoc !== r.doc) throw badRequest('Screen "' + screenKey + '" is a list — save through the screen it edits in');
    var check = await checkTable(r.model, r.doc, r.table);
    if (check.noTable || check.missing.length) throw tableProblem(r.table, check);
    var cols = new Set(check.columns.keys());

    var values = (body && body.values) || {};
    // The screen's own rules, as schema-handler enforces them: types, required,
    // lengths, patterns, options. Anything the screen does not declare is dropped.
    var clean = applySchema(r.model.formSchema(r.doc), values, 'field');
    var row = {};
    check.fields.forEach(function(f) { if (Object.prototype.hasOwnProperty.call(clean, f)) row[f] = clean[f]; });

    var id = body && body.id;
    if (id === undefined || id === null || id === '') {
      row.id = generateId();
      r.model.inputNodes(r.doc).forEach(function(n) {
        if (n.type === 'checkbox' && !Object.prototype.hasOwnProperty.call(row, n.props.name)) row[n.props.name] = false;
      });
      stampTenant(row, cols);
      stampAudit(row, cols, user, true);
      await knex(r.table).insert(row);
      return shapeRow(await scope(knex(r.table).select(selectList(r.table, check.fields, check.columns)), r.table, cols).where(r.table + '.id', row.id).first(), check.columns);
    }

    // An update sends every field the screen has: a cleared field is saved as
    // empty, not left holding its old value — and an unticked checkbox as false
    // (its column is NOT NULL).
    var types = {};
    r.model.inputNodes(r.doc).forEach(function(n) { types[n.props.name] = n.type; });
    check.fields.forEach(function(f) {
      if (!Object.prototype.hasOwnProperty.call(row, f)) row[f] = types[f] === 'checkbox' ? false : null;
    });
    stampAudit(row, cols, user, false);
    var count = await scope(knex(r.table), r.table, cols).where(r.table + '.id', String(id)).update(row);
    if (!count) throw notFound('No ' + r.table + ' record "' + id + '"');
    return shapeRow(await scope(knex(r.table).select(selectList(r.table, check.fields, check.columns)), r.table, cols).where(r.table + '.id', String(id)).first(), check.columns);
  }

  /** Soft delete: isActive = false. The row, and anything pointing at it, stays. */
  async function remove(screenKey, id, user) {
    if (id === undefined || id === null || id === '') throw badRequest('An id is required');
    var r = await resolve(screenKey);
    var cols = new Set((await columnsOf(r.table)).keys());
    if (!cols.has('isActive')) throw conflict('Table "' + r.table + '" has no isActive column, so its records cannot be deleted softly');
    var patch = { isActive: false };
    stampAudit(patch, cols, user, false);
    var count = await scope(knex(r.table), r.table, cols).where(r.table + '.id', String(id)).update(patch);
    if (!count) throw notFound('No ' + r.table + ' record "' + id + '"');
    return { id: String(id) };
  }

  /** Every table a published screen reads or writes — the only ones this package serves. */
  async function allowedTables() {
    var docs = (await screens.allPublished()).map(function(s) { return s.document; });
    var tables = new Set();
    docs.forEach(function(d) {
      if (d.source) tables.add(d.source);
      d.nodes.forEach(function(n) {
        if (n.type === 'dropdown' && n.props.data && n.props.data.source === 'table') tables.add(n.props.data.table);
        if (n.type === 'list' && n.props.source) tables.add(n.props.source);
      });
    });
    return tables;
  }

  /** A dropdown's options: id and name from a table some published screen reads. */
  async function options(table) {
    var allowed = await allowedTables();
    if (!allowed.has(table)) throw notFound('No published screen reads options from "' + table + '"');
    var cols = new Set((await columnsOf(table)).keys());
    if (!cols.size) throw conflict('Table "' + table + '" does not exist');
    if (!cols.has('id') || !cols.has('name')) throw conflict('Table "' + table + '" needs "id" and "name" columns to be used for dropdown options');
    return scope(knex(table).select(table + '.id', table + '.name'), table, cols).orderBy(table + '.name');
  }

  /**
   * Whether an edit screen's table is ready for it. Used by publish: a screen
   * whose fields have no columns would fail on its first save, so it is not
   * published, and the migration that would make it ready is returned.
   */
  async function readiness(document, previousDocument) {
    var model = await factoryModel.load();
    if (!model.inputNodes(document).length || !document.source) return { ready: true };
    var check = await checkTable(model, document, document.source);
    if (!check.noTable && !check.missing.length) return { ready: true };
    var migration = null;
    try {
      migration = model.migrationFor(check.noTable ? null : previousDocument || null, document).sql;
    } catch (err) {
      migration = '-- ' + err.message.replace(/\n/g, '\n-- ');
    }
    var e = tableProblem(document.source, check);
    e.migration = migration;
    return { ready: false, error: e };
  }

  return { list: list, save: save, remove: remove, options: options, allowedTables: allowedTables, readiness: readiness, columnsOf: columnsOf, forget: forget };
}

function badRequest(message) { var e = new Error(message); e.status = 400; return e; }
function notFound(message) { var e = new Error(message); e.status = 404; return e; }
function conflict(message) { var e = new Error(message); e.status = 409; return e; }

module.exports = { createRecordsStore: createRecordsStore };
