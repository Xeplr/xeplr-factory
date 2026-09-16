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
var { getMtContext } = require('@xeplr/db');
var { scope, stampTenant, stampAudit } = require('./tenancy');
var { reject, quietly } = require('./hooks');
var factoryModel = require('./model');

/** Columns the factory writes itself; a hook may not set them. */
var RESERVED = new Set(['id', 'isActive', 'mtId1', 'mtId2', 'mtId3', 'mtId4', 'recordCreatedDate', 'recordModifiedDate', 'recordCreatedBy', 'recordModifiedBy']);

function clone(v) { return v === undefined ? {} : JSON.parse(JSON.stringify(v)); }
function deepFreeze(o) {
  Object.values(o).forEach(function(v) { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(o);
}

var LIST_LIMIT = 1000;

function createRecordsStore(knex, screens, hooks, models) {
  if (!hooks) hooks = require('./hooks').createHooks({});
  if (!models) models = require('./factoryModel').createModels([]);
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
   * A TIMESTAMP is read as text for the same reason: "2026-10-01 09:30" is the
   * moment that was typed in, and no timezone may move it on the way back.
   */
  var READ_AS_TEXT = { date: true, timestamp: true, timestamptz: true };

  function selectList(table, fields, columns) {
    return ['id'].concat(fields).map(function(f) {
      var info = columns.get(f);
      if (info && READ_AS_TEXT[info.udtName]) return knex.raw('??::text as ??', [table + '.' + f, f]);
      return table + '.' + f;
    });
  }

  /** The screen's input nodes by field name — what each column holds. */
  function nodesOf(r) {
    var byName = {};
    r.model.inputNodes(r.fieldsDoc).forEach(function(n) { byName[n.props.name] = n; });
    return byName;
  }

  /**
   * A choice from a FIXED list must be one of that list's ids. schema-handler's
   * `options` compares ONE value, so it covers a dropdown and a radio but cannot
   * check a multi-select, whose value is an array — and an array of ids is
   * exactly what a request could make up. Options that come from a table are
   * left to the column's foreign key.
   */
  function checkChoices(r, nodes, values) {
    Object.keys(values).forEach(function(f) {
      var node = nodes[f];
      if (!node || (node.type !== 'multiselect' && node.type !== 'radio')) return;
      var allowed = r.model.chooseable(node);            // null unless the list is the screen's own
      if (!allowed) return;
      var chosen = Array.isArray(values[f]) ? values[f] : [values[f]];
      var stray = chosen.filter(function(v) {
        if (v === null || v === undefined || v === '') return false;
        return !allowed.some(function(o) { return r.model.sameId(o.id, v); });
      });
      if (!stray.length) return;
      var e = badRequest('"' + (node.props.label || f) + '" must be chosen from its options: ' + stray.join(', ') + (stray.length === 1 ? ' is not one of them' : ' are not among them'));
      e.fields = [{ field: f, message: e.message }];
      throw e;
    });
  }

  /**
   * A row as the database hands it back → what a model, a hook and the form see.
   * numeric comes back from pg as a string (it can exceed a JS number); the form
   * wants a number. Then every field goes through the screen's own fromDbValue,
   * BEFORE the model: a multi-select is an array again, not "a,b", and a
   * date-and-time is "YYYY-MM-DDTHH:mm", whatever the column wrote.
   */
  function shapeRow(row, columns, r, nodes) {
    if (!row) return row;
    var out = {};
    Object.keys(row).forEach(function(k) {
      var info = columns.get(k);
      var v = row[k];
      if (info && info.udtName === 'numeric' && v !== null && v !== undefined) v = Number(v);
      out[k] = nodes && nodes[k] ? r.model.fromDbValue(nodes[k], v) : v;
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
      ? 'Table "' + table + '" does not exist — publish the screen that saves to it'
      : 'Table "' + table + '" has no column for: ' + check.missing.join(', ') + ' — publish the screen to add them');
    e.missing = check.missing;
    return e;
  }

  // ── hooks context ───────────────────────────────────────────────────────

  /** What every hook receives. `input` is exactly what the UI sent, frozen. */
  function baseContext(op, r, screenKey, user, extra) {
    return Object.assign({
      op: op,
      screenKey: screenKey,
      screen: r.doc,
      table: r.table,
      user: user || null,
      tenant: getMtContext(),
      knex: knex,
      // factory.table for this form's table: this company, active rows, audit, the model.
      db: function(options) { return require('./table').scopedTable(knex, models, r.table, Object.assign({ user: user }, options)); },
      reject: reject
    }, extra);
  }

  function hooksFor(op, r, screenKey) {
    return hooks.forOperation(op, screenKey, r.fieldsDoc !== r.doc ? r.fieldsDoc.id : null);
  }

  /** error(ctx, err) — told, never allowed to replace the real error. */
  async function tellError(h, ctx, err) {
    if (h.error) await quietly(function() { return h.error(ctx, err); }, ctx.screenKey + '.' + ctx.op + '.error');
  }

  /**
   * after(ctx) — runs once the operation succeeded. A value it returns replaces
   * the result. If it throws, the operation still happened: the error hook is
   * told, it is logged, and the result stands.
   */
  async function runAfter(h, ctx) {
    if (!h.after) return ctx.result;
    try {
      var out = await h.after(ctx);
      return out === undefined ? ctx.result : out;
    } catch (err) {
      console.error('[factory] ' + ctx.screenKey + '.' + ctx.op + '.after failed:', err);
      await tellError(h, ctx, err);
      return ctx.result;
    }
  }

  // ── get: the list, or one record ──────────────────────────────────────────

  /**
   * A screen's records (no id) or one record (id).
   *
   * get.before(ctx) may narrow ctx.query — a knex builder already scoped to the
   * tenant and to active rows — e.g. ctx.query.where('departmentId', …).
   */
  async function get(screenKey, id, user) {
    var r = await resolve(screenKey);
    var h = hooksFor('get', r, screenKey);
    var one = id !== undefined && id !== null && id !== '';
    var ctx = baseContext('get', r, screenKey, user, { id: one ? String(id) : null, many: !one, input: Object.freeze(one ? { id: String(id) } : {}) });
    if (h.override) return h.override(ctx);

    try {
      var check = await checkTable(r.model, r.fieldsDoc, r.table);
      if (check.noTable || check.missing.length) throw tableProblem(r.table, check);
      var cols = new Set(check.columns.keys());
      var nodes = nodesOf(r);
      ctx.query = scope(knex(r.table).select(selectList(r.table, check.fields, check.columns)), r.table, cols);
      if (one) ctx.query.where(r.table + '.id', ctx.id);
      else if (cols.has('recordModifiedDate')) ctx.query.orderBy(r.table + '.recordModifiedDate', 'desc');
      if (h.before) {
        var replaced = await h.before(ctx);
        if (replaced && typeof replaced.then === 'function' && typeof replaced.where === 'function') ctx.query = replaced;
      }
      var Model = models.forTable(r.table);
      var rows = (await ctx.query.limit(one ? 1 : LIST_LIMIT)).map(function(row) { return Model.fromDb(shapeRow(row, check.columns, r, nodes)); });
      if (one && !rows.length) throw notFound('No ' + r.table + ' record "' + ctx.id + '"');
      ctx.result = one ? rows[0] : rows;
    } catch (err) {
      await tellError(h, ctx, err);
      throw err;
    }
    return runAfter(h, ctx);
  }

  function list(screenKey, user) {
    return get(screenKey, null, user);
  }

  // ── save ──────────────────────────────────────────────────────────────────

  /**
   * Create (no id) or update (id) a record.
   *
   *   save.before(ctx)  ctx.values — what the UI sent — and ctx.previous on update.
   *                     Return new values to replace them; they are checked
   *                     against the screen's rules AFTER, so a value a hook
   *                     fills in is validated like a typed one.
   *   [rules → insert / update, in a transaction]
   *   save.after(ctx)   ctx.id, ctx.result (the saved row), ctx.input, ctx.previous
   *
   * A before hook may also set COLUMNS THE FORM DOES NOT HAVE (a computed
   * fullName): written when the table has that column. The UI cannot do the
   * same — a key the UI sent that is not a field is dropped.
   */
  async function save(screenKey, body, user) {
    var r = await resolve(screenKey);
    if (r.fieldsDoc !== r.doc) throw badRequest('Screen "' + screenKey + '" is a list — save through the screen it edits in');
    var h = hooksFor('save', r, screenKey);
    var rawId = body && body.id;
    var id = rawId === undefined || rawId === null || rawId === '' ? null : String(rawId);
    var sent = clone((body && body.values) || {});
    var ctx = baseContext('save', r, screenKey, user, { id: id, isNew: id === null, input: deepFreeze(clone(sent)), values: sent, previous: null });
    if (h.override) return h.override(ctx);

    try {
      var check = await checkTable(r.model, r.doc, r.table);
      if (check.noTable || check.missing.length) throw tableProblem(r.table, check);
      var cols = new Set(check.columns.keys());
      var nodes = nodesOf(r);
      var Model = models.forTable(r.table);
      var readBack = function(q, rowId) {
        return q.select(selectList(r.table, check.fields, check.columns)).where(r.table + '.id', rowId).first();
      };

      if (id !== null) {
        var found = shapeRow(await readBack(scope(knex(r.table), r.table, cols), id), check.columns, r, nodes);
        ctx.previous = found ? Model.fromDb(found) : null;
        if (!ctx.previous) throw notFound('No ' + r.table + ' record "' + id + '"');
      }

      if (h.before) {
        var out = await h.before(ctx);
        if (out !== undefined) {
          if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error(screenKey + '.save.before must return the values object (or nothing)');
          ctx.values = out;
        }
      }

      // The model's setters first — your code may hand over an array for a
      // column that stores text — then the screen's own rules on what will be written.
      var dbValues = Model.toDb(ctx.values);
      var clean = applySchema(r.model.formSchema(r.doc), dbValues, 'field');
      checkChoices(r, nodes, clean);
      // …and then into what the column holds: a multi-select's ids joined by
      // commas, everything else as it was. See toDbValue in @xeplr/ui-factory.
      var row = {};
      check.fields.forEach(function(f) {
        if (!Object.prototype.hasOwnProperty.call(clean, f)) return;
        row[f] = nodes[f] ? r.model.toDbValue(nodes[f], clean[f]) : clean[f];
      });
      // Columns a hook added that the form does not have — never ones the UI sent.
      var extra = [];
      Object.keys(dbValues).forEach(function(k) {
        if (check.fields.indexOf(k) !== -1 || Object.prototype.hasOwnProperty.call(sent, k)) return;
        if (RESERVED.has(k)) throw new Error(screenKey + '.save.before cannot set "' + k + '" — it is managed by the factory');
        if (!cols.has(k)) throw new Error(screenKey + '.save.before set "' + k + '", but "' + r.table + '" has no such column');
        row[k] = dbValues[k];
        extra.push(k);
      });

      var types = {};
      r.model.inputNodes(r.doc).forEach(function(n) { types[n.props.name] = n.type; });
      var savedId = await knex.transaction(async function(trx) {
        if (id === null) {
          row.id = generateId();
          check.fields.forEach(function(f) { if (types[f] === 'checkbox' && !Object.prototype.hasOwnProperty.call(row, f)) row[f] = false; });
          stampTenant(row, cols);
          stampAudit(row, cols, user, true);
          await trx(r.table).insert(row);
          return row.id;
        }
        // An update writes every field: a cleared field is saved as empty, and
        // an unticked checkbox as false (its column is NOT NULL).
        check.fields.forEach(function(f) {
          if (!Object.prototype.hasOwnProperty.call(row, f)) row[f] = types[f] === 'checkbox' ? false : null;
        });
        stampAudit(row, cols, user, false);
        var count = await scope(trx(r.table), r.table, cols).where(r.table + '.id', id).update(row);
        if (!count) throw notFound('No ' + r.table + ' record "' + id + '"');
        return id;
      });

      ctx.id = savedId;
      var saved = shapeRow(await readBack(scope(knex(r.table), r.table, cols), savedId), check.columns, r, nodes);
      if (extra.length) {
        var more = await scope(knex(r.table).select(extra.map(function(k) { return r.table + '.' + k; })), r.table, cols).where(r.table + '.id', savedId).first();
        Object.assign(saved, shapeRow(more, check.columns, r, nodes));
      }
      ctx.result = Model.fromDb(saved);
    } catch (err) {
      await tellError(h, ctx, err);
      throw err;
    }
    return runAfter(h, ctx);
  }

  // ── delete ────────────────────────────────────────────────────────────────

  /**
   * Soft delete: isActive = false. The row, and anything pointing at it, stays.
   *   delete.before(ctx)  ctx.id, ctx.previous — reject to refuse
   *   delete.after(ctx)
   */
  async function remove(screenKey, id, user) {
    if (id === undefined || id === null || id === '') throw badRequest('An id is required');
    var r = await resolve(screenKey);
    var h = hooksFor('delete', r, screenKey);
    var ctx = baseContext('delete', r, screenKey, user, { id: String(id), input: Object.freeze({ id: String(id) }), previous: null });
    if (h.override) return h.override(ctx);

    try {
      var columns = await columnsOf(r.table);
      var cols = new Set(columns.keys());
      if (!cols.has('isActive')) throw conflict('Table "' + r.table + '" has no isActive column, so its records cannot be deleted softly');
      var fields = r.model.inputNodes(r.fieldsDoc).map(function(n) { return n.props.name; }).filter(function(f) { return cols.has(f); });
      var before = shapeRow(await scope(knex(r.table).select(selectList(r.table, fields, columns)), r.table, cols).where(r.table + '.id', ctx.id).first(), columns, r, nodesOf(r));
      ctx.previous = before ? models.forTable(r.table).fromDb(before) : null;
      if (!ctx.previous) throw notFound('No ' + r.table + ' record "' + id + '"');
      if (h.before) await h.before(ctx);
      var patch = { isActive: false };
      stampAudit(patch, cols, user, false);
      var count = await scope(knex(r.table), r.table, cols).where(r.table + '.id', ctx.id).update(patch);
      if (!count) throw notFound('No ' + r.table + ' record "' + id + '"');
      ctx.result = { id: ctx.id };
    } catch (err) {
      await tellError(h, ctx, err);
      throw err;
    }
    return runAfter(h, ctx);
  }

  /** Every table a published screen reads or writes — the only ones this package serves. */
  async function allowedTables() {
    var docs = (await screens.allPublished()).map(function(s) { return s.document; });
    var tables = new Set();
    docs.forEach(function(d) {
      if (d.source) tables.add(d.source);
      d.nodes.forEach(function(n) {
        // Every control that offers options — dropdown, radio, multi-select.
        if (n.props.data && n.props.data.source === 'table' && n.props.data.table) tables.add(n.props.data.table);
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

  /** The table as Postgres describes it — lengths and foreign keys too — or null if it does not exist. */
  async function describeTable(table) {
    var rows = await knex('information_schema.columns')
      .select('column_name', 'udt_name', 'character_maximum_length')
      .where({ table_schema: knex.raw('current_schema()'), table_name: table })
      .orderBy('ordinal_position');
    if (!rows.length) return null;
    var fks = await knex.raw(
      'SELECT kcu.column_name, ccu.table_name AS ref ' +
      'FROM information_schema.table_constraints tc ' +
      'JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema ' +
      'JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema ' +
      "WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema() AND tc.table_name = ?", [table]);
    var refs = {};
    fks.rows.forEach(function(r) { refs[r.column_name] = r.ref; });
    return {
      table: table,
      columns: rows.map(function(r) {
        return { name: r.column_name, udtName: r.udt_name, maxLength: r.character_maximum_length, references: refs[r.column_name] };
      })
    };
  }

  /**
   * PUBLISH: the draft becomes the next version, and its table is changed to
   * match — directly, in the same transaction, so either both happen or neither.
   *
   *   refused      a change that would lose or break data (narrowing, another kind of value) — 409
   *   to confirm   columns a removed field would drop, with how many values each holds — 409,
   *                until the same request comes back with confirmDrop naming every one of them
   *   otherwise    CREATE / ALTER / DROP run, and the screen is published
   */
  async function publish(screenKey, options, user) {
    options = options || {};
    var model = await factoryModel.load();
    var draft = await screens.draft(screenKey);
    if (!draft) throw notFound('Screen "' + screenKey + '" has no draft to publish');
    var doc = draft.document;

    // A screen with no fields (a list) changes no table.
    if (!model.inputNodes(doc).length || !doc.source) {
      var plain = await screens.publishDraft(screenKey, user);
      return { version: plain.version, statements: [] };
    }

    var table = doc.source;
    var current = await describeTable(table);
    var others = await screens.publishedOnTableAllTenants(table);
    var managed = new Set();
    var inUse = new Set();
    var latestSeen = new Set();
    others.forEach(function(s) {
      var names = model.inputNodes(s.document).map(function(n) { return n.props.name; });
      names.forEach(function(n) { managed.add(n); });
      var identity = s.screenKey + '|' + s.mt.join('|');
      if (latestSeen.has(identity)) return;            // rows come newest first: only a screen's latest version is "in use"
      latestSeen.add(identity);
      var isThisScreen = s.screenKey === screenKey && s.mt.join('|') === draft.mt.join('|');
      if (!isThisScreen) names.forEach(function(n) { inUse.add(n); });
    });

    var plan = model.planTableChange(current, doc, { managed: Array.from(managed), inUse: Array.from(inUse), confirmDrop: options.confirmDrop });

    if (plan.refused.length) {
      var refused = conflict('Cannot publish "' + screenKey + '" — ' + plan.refused.map(function(r) { return (r.column ? '"' + r.column + '": ' : '') + r.reason; }).join('; '));
      refused.body = { refused: plan.refused };
      throw refused;
    }

    if (plan.unconfirmed.length) {
      // How much would be lost, across every company — the column is shared.
      var counts = [];
      for (var i = 0; i < plan.drop.length; i++) {
        var name = plan.drop[i].name;
        var c = await knex(table).whereNotNull(name).count({ n: '*' }).first();
        counts.push({ column: name, records: Number(c.n) });
      }
      var ask = conflict('Publishing removes ' + plan.drop.length + ' column' + (plan.drop.length === 1 ? '' : 's') + ' from "' + table + '", with all their data: ' +
        counts.map(function(x) { return x.column + ' (' + x.records + ' value' + (x.records === 1 ? '' : 's') + ')'; }).join(', ') + '. Confirm to continue.');
      ask.body = { confirm: counts, keep: plan.keep };
      throw ask;
    }

    try {
      var published = await knex.transaction(async function(trx) {
        for (var s = 0; s < plan.statements.length; s++) await trx.raw(plan.statements[s]);
        return screens.publishDraft(screenKey, user, trx);
      });
      forget(table);
      return { version: published.version, statements: plan.statements, keep: plan.keep };
    } catch (err) {
      forget(table);
      if (err.code && /^(42|23)/.test(err.code)) {
        // A table this screen points at does not exist (42P01), a value that
        // does not fit, … — the database's own reason, and nothing was changed.
        var failed = conflict('Could not change "' + table + '": ' + err.message + ' — nothing was changed');
        failed.body = { statements: plan.statements };
        throw failed;
      }
      throw err;
    }
  }

  return { get: get, list: list, save: save, remove: remove, options: options, allowedTables: allowedTables, publish: publish, describeTable: describeTable, columnsOf: columnsOf, forget: forget, resolve: resolve };
}

function badRequest(message) { var e = new Error(message); e.status = 400; return e; }
function notFound(message) { var e = new Error(message); e.status = 404; return e; }
function conflict(message) { var e = new Error(message); e.status = 409; return e; }

module.exports = { createRecordsStore: createRecordsStore };
