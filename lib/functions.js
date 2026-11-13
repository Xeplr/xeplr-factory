// THE APP'S FUNCTIONS THAT A SCREEN'S CONTROLS NAME — a list's rows, a
// column's hover box, an autocomplete's suggestions, a button's press.
// Registered with @xeplr/actions, each with an `event` saying what it is for
// (listRows, rowDetails, suggest, button), and named in the screen.
//
// ── what a request may choose ─────────────────────────────────────────────
// A request names a screen, a control and (for a button) a button id. The
// FUNCTION and its PARAMETERS come only from the PUBLISHED screen — never from
// the request — so nobody can run a function the screen does not name, or
// give a button values of their own. The only things a person sends are what
// they typed: a search, a chip, a note.
//
// A button acts on ONE RECORD of the screen's table, read here, scoped to the
// caller's company and to active rows. Whether it applies — its `when` and
// `disabledWhen` — is checked again on that row, so a button that is hidden
// or greyed out in the browser cannot be pressed by sending the request.

var { getMtContext } = require('@xeplr/db');
var { reject, resolve } = require('./hooks');
var { scopedTable } = require('./table');
var factoryModel = require('./model');

/** How long a search may be, and a note. */
var MAX_SEARCH = 200;
var MAX_NOTE = 1000;
/** A hover box lists a few entries, never the table. */
var MAX_DETAILS = 50;

/**
 * @param files  the files store — a button's ask.file uploads, and the files a press names
 */
function createFunctionsStore(knex, screens, models, files) {

  async function published(screenKey) {
    var screen = await screens.published(screenKey);
    if (!screen) throw status(404, 'Screen "' + screenKey + '" is not published');
    return screen.document;
  }

  /** The list a request names — by id, or the screen's only list fed by a function. */
  function fedList(doc, nodeId) {
    var fed = doc.nodes.filter(function(n) { return n.type === 'list' && n.props && n.props.rowsFrom; });
    var node = nodeId ? fed.find(function(n) { return n.id === nodeId; }) : (fed.length === 1 ? fed[0] : null);
    if (!node) {
      throw status(404, nodeId
        ? 'Screen "' + doc.id + '" has no list "' + nodeId + '" whose rows come from a function'
        : 'Screen "' + doc.id + '" has ' + (fed.length ? fed.length + ' lists fed by functions — say which (node)' : 'no list whose rows come from a function'));
    }
    return node;
  }

  /**
   * What every one of these functions is given. `access` is the caller's
   * req.access from the auth gate — { roles, apis } — frozen, or null: a
   * function that only some people may run (Reopen, for admins) reads it here,
   * because roles are on the access, not on the user.
   */
  function context(doc, screenKey, user, extra, access) {
    return Object.assign({
      screenKey: screenKey,
      screen: doc,
      user: user || null,
      access: frozenAccess(access),
      tenant: getMtContext(),
      knex: knex,
      // factory.table for any table: this company, active rows, audit, the model.
      db: function(table, options) { return scopedTable(knex, models, table, Object.assign({ user: user }, options)); },
      reject: reject
    }, extra);
  }

  // ── a list's rows ─────────────────────────────────────────────────────────

  /**
   * The rows of a list a function works out: { rows, counts, kpis, q, filter, kpi, from, to }.
   * The function is given ctx.query = { q, filter, kpi, from, to } — the search
   * typed, the KPI card clicked (one of the list's own, or ''), the date
   * range's days ('YYYY-MM-DD', '' for an open end) and the chip chosen (always one of the list's own chips; the first when none or
   * an unknown one is asked for, so an old link opens the first chip, not an
   * error) — and returns rows, or { rows, counts: { chipKey: n } }.
   */
  async function rows(screenKey, nodeId, query, user, access) {
    var doc = await published(screenKey);
    var node = fedList(doc, nodeId);
    var def = resolve(doc, 'listRows', node.props.rowsFrom);
    var chips = Array.isArray(node.props.filters) ? node.props.filters : [];
    var asked = query && query.filter;
    var filter = chips.some(function(c) { return c.key === asked; }) ? asked : (chips[0] ? chips[0].key : null);
    var q = String((query && query.q) || '').trim().slice(0, MAX_SEARCH);
    // A KPI card is one of the list's own, or none; a range is two real days
    // (either may be open), the first not after the second — anything else is
    // refused rather than quietly read as "everything".
    var cards = Array.isArray(node.props.kpis) ? node.props.kpis : [];
    var kpi = query && query.kpi && cards.some(function(c) { return c.key === query.kpi; }) ? query.kpi : '';
    var from = (query && query.from) || '';
    var to = (query && query.to) || '';
    var model = await factoryModel.load();
    if ((from && !model.isDay(from)) || (to && !model.isDay(to))) throw status(400, 'A date range is two days as YYYY-MM-DD');
    if (from && to && from > to) throw status(400, 'The range starts after it ends');
    if ((from || to) && !node.props.dateRange) throw status(400, 'This list has no date range');
    var ctx = context(doc, screenKey, user, { node: node, query: Object.freeze({ q: q, filter: filter, kpi: kpi, from: from, to: to }) }, access);
    var out = await def.execute(ctx);
    var list = Array.isArray(out) ? out : out && Array.isArray(out.rows) ? out.rows : null;
    if (!list) throw status(500, '"' + node.props.rowsFrom + '" returned neither rows nor { rows, counts }');
    var counts = out && !Array.isArray(out) && out.counts && typeof out.counts === 'object' ? out.counts : {};
    var kpis = out && !Array.isArray(out) && out.kpis && typeof out.kpis === 'object' ? out.kpis : {};
    return { rows: list, counts: counts, kpis: kpis, q: q, filter: filter, kpi: kpi, from: from, to: to };
  }

  /**
   * What one cell's hover box lists for one row: [{ text, sub?, at?, open? }],
   * from the column's `details` function, given ctx.id (the row) and ctx.column.
   */
  async function details(screenKey, nodeId, field, id, user, access) {
    var doc = await published(screenKey);
    var node = fedList(doc, nodeId);
    var column = (node.props.columns || []).find(function(c) { return c.field === field; });
    if (!column || !column.details) throw status(404, 'Column "' + field + '" of "' + doc.id + '" has no hover box');
    if (id === undefined || id === null || id === '') throw status(400, 'Say which row (id)');
    var def = resolve(doc, 'rowDetails', column.details);
    var out = await def.execute(context(doc, screenKey, user, { node: node, column: column, id: String(id) }, access));
    if (!Array.isArray(out)) throw status(500, '"' + column.details + '" returned no list of entries');
    return out.slice(0, MAX_DETAILS);
  }

  // ── an autocomplete's suggestions ─────────────────────────────────────────

  /**
   * What an autocomplete field suggests for what was typed:
   * [{ value, label, sub?, image?, fill? }], at most 20 — from the function
   * the PUBLISHED screen names in the field's suggestFrom (event "suggest"),
   * given ctx.query = { q } (trimmed, at most 200 characters). What it
   * answers is cleaned by the same rule the browser reads it with
   * (@xeplr/ui-factory suggestionsOf); a value it cannot use is dropped.
   */
  async function suggest(screenKey, nodeId, q, user, access) {
    var doc = await published(screenKey);
    var model = await factoryModel.load();
    var node = nodeId ? doc.nodes.find(function(n) { return n.id === nodeId && n.type === 'autocomplete'; }) : null;
    if (!node) throw status(404, 'Screen "' + doc.id + '" has no autocomplete field "' + (nodeId || '') + '"');
    var text = String(q == null ? '' : q).trim().slice(0, model.MAX_SUGGEST_QUERY);
    if (!model.shouldSuggest(node.props, text)) return [];
    var def = resolve(doc, model.SUGGEST_EVENT, node.props.suggestFrom);
    var out = await def.execute(context(doc, screenKey, user, { node: node, query: Object.freeze({ q: text }) }, access));
    return model.suggestionsOf(out);
  }

  // ── a button ──────────────────────────────────────────────────────────────

  /**
   * Press a button on one record: { button, message, output }.
   *
   * The function runs through @xeplr/actions' runAction, so its inputSchema
   * checks the parameters exactly as every other run does. It is given the
   * button's parameters (and the note, when the button asks for one, the
   * stored paths as `files`, when its ask.file takes them, and the values its
   * ask.fields asked for, under their names) as `input`, and the
   * record and caller as `system`:
   *   system = { record, id, user, access, tenant, knex, db, screen, screenKey, button, files, reject }
   * A checklist field (`type: "checklist"`) takes only ids its optionsFrom
   * function offers for this record now — asked again here, not trusted from
   * the dialog.
   * system.files = [{ path, name, size, fullPath }] — the bytes are read from fullPath.
   * What it returns is the answer; a `message` in it is shown to the person.
   */
  /** The published screen's button, and the screen — 404 for a button it does not have. */
  async function pressable(screenKey, buttonId) {
    var model = await factoryModel.load();
    var doc = await published(screenKey);
    var found = model.buttonById(doc, buttonId);
    if (!found) throw status(404, 'Screen "' + doc.id + '" has no button "' + buttonId + '"');
    if (!doc.source) throw status(409, 'Screen "' + doc.id + '" says no table (source), so its buttons have no record to act on');
    return { model: model, doc: doc, button: found.button };
  }

  /**
   * A file for a button's press, stored before it: checked against the
   * button's `ask.file` (from the published screen) → { path, name, size }.
   */
  async function storeButtonFile(screenKey, buttonId, file, user) {
    var found;
    try {
      found = await pressable(screenKey, buttonId);
    } catch (err) {
      if (file && file.path) await require('fs').promises.unlink(file.path).catch(function() {});
      throw err;
    }
    return files.storeForButton(found.doc.source, found.button, file, user);
  }

  /**
   * The record a button is pressed on — this company's, active — and whether
   * the button applies to it now. What the browser drew may be out of date
   * (somebody else changed the record), and a request can be sent by hand:
   * the record decides.
   */
  async function pressedRecord(found, id, user) {
    if (id === undefined || id === null || id === '') throw status(400, 'Say which record (id) the button is pressed on');
    var doc = found.doc;
    var record = await scopedTable(knex, models, doc.source, { user: user }).where(doc.source + '.id', String(id)).first();
    if (!record) throw status(404, 'No ' + doc.source + ' record "' + id + '"');
    record = models.forTable(doc.source).fromDb(record);
    if (!found.model.buttonShown(found.button, record) || found.model.buttonDisabled(found.button, record)) {
      throw status(409, '"' + found.button.label + '" does not apply to this record now — it may have just changed. Reload to see it as it is.');
    }
    return record;
  }

  /** What one checklist field offers for the record: the cleaned entries of its optionsFrom function. */
  async function offeredFor(found, field, record, id, user, access) {
    var def = resolve(found.doc, found.model.BUTTON_OPTIONS_EVENT, field.optionsFrom);
    var out = await def.execute(context(found.doc, found.doc.id, user, {
      record: record, id: String(id), button: found.button, field: Object.freeze(Object.assign({}, field))
    }, access));
    return found.model.checklistOptionsOf(out);
  }

  /**
   * What a checklist in a button's popup offers for one record:
   * [{ id, label, sub?, image? }], at most 200 — from the function the
   * PUBLISHED button's field names in optionsFrom (event "buttonOptions"),
   * given what a press gets (record, id, user, access, button, db…) and the
   * field. The record is read and the button's when / disabledWhen checked
   * exactly as a press does.
   */
  async function buttonOptions(screenKey, buttonId, id, fieldName, user, access) {
    var found = await pressable(screenKey, buttonId);
    var field = found.model.checklistFields(found.button).find(function(f) { return f.name === fieldName; });
    if (!field) throw status(404, 'Button "' + found.button.id + '" has no checklist "' + (fieldName || '') + '"');
    var record = await pressedRecord(found, id, user);
    return offeredFor(found, field, record, id, user, access);
  }

  async function press(screenKey, buttonId, body, user, access) {
    var found = await pressable(screenKey, buttonId);
    var model = found.model;
    var doc = found.doc;
    var button = found.button;
    var id = body && body.id;
    if (id === undefined || id === null || id === '') throw status(400, 'Say which record (id) the button is pressed on');
    var note = body && body.note;
    if (note !== undefined && note !== null && typeof note !== 'string') throw status(400, 'A note is text');
    if (note && note.length > MAX_NOTE) throw status(400, 'A note can be at most ' + MAX_NOTE + ' characters');
    var paths = body && body.files !== undefined && body.files !== null ? body.files : [];
    if (!Array.isArray(paths)) throw status(400, 'files is a list of stored paths');
    var fileProblem = model.askFileProblem(button, paths);
    if (fileProblem) throw status(400, fileProblem);

    var record = await pressedRecord(found, id, user);

    // What the button's ask.fields asked for, checked as the dialog did — a
    // checklist against what its function offers for this record now.
    var offered = {};
    var checklists = model.checklistFields(button);
    for (var i = 0; i < checklists.length; i++) {
      offered[checklists[i].name] = (await offeredFor(found, checklists[i], record, id, user, access)).map(function(o) { return o.id; });
    }
    var asked = model.askFieldValues(button, body && body.values, undefined, offered);
    if (asked.errors.length) {
      var e = status(400, asked.errors.map(function(x) { return x.message; }).join('; '));
      e.fields = asked.errors;
      throw e;
    }
    var attached = paths.length ? await files.buttonFiles(doc.source, button, paths, user) : [];

    resolve(doc, 'button', button.action);
    var actions = require('@xeplr/actions');
    var system = context(doc, screenKey, user, { record: record, id: String(id), button: button, files: attached }, access);
    var run = await actions.runAction({ name: button.action, input: model.buttonInput(button, note, paths, asked.values), system: system });
    if (run.status !== 'success') throw run.error || status(500, '"' + button.label + '" failed');
    var output = run.output && typeof run.output === 'object' ? run.output : {};
    return { button: button.id, message: typeof output.message === 'string' ? output.message : null, output: run.output === undefined ? null : run.output };
  }

  return { rows: rows, details: details, suggest: suggest, press: press, buttonOptions: buttonOptions, storeButtonFile: storeButtonFile };
}

/** The caller's access ({ roles, apis }), frozen all the way down — or null. */
function frozenAccess(access) {
  if (!access || typeof access !== 'object') return null;
  return deepFreeze(JSON.parse(JSON.stringify(access)));
}

function deepFreeze(o) {
  Object.keys(o).forEach(function(k) { if (o[k] && typeof o[k] === 'object') deepFreeze(o[k]); });
  return Object.freeze(o);
}

function status(code, message) {
  var e = new Error(message);
  e.status = code;
  return e;
}

module.exports = { createFunctionsStore: createFunctionsStore };
