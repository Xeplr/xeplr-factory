// THE APP'S FUNCTIONS THAT A SCREEN'S CONTROLS NAME — a list's rows, a
// column's hover box, a button's press. Registered with @xeplr/actions, each
// with an `event` saying what it is for (listRows, rowDetails, button), and
// named in the screen.
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

  /** What every one of these functions is given. */
  function context(doc, screenKey, user, extra) {
    return Object.assign({
      screenKey: screenKey,
      screen: doc,
      user: user || null,
      tenant: getMtContext(),
      knex: knex,
      // factory.table for any table: this company, active rows, audit, the model.
      db: function(table, options) { return scopedTable(knex, models, table, Object.assign({ user: user }, options)); },
      reject: reject
    }, extra);
  }

  // ── a list's rows ─────────────────────────────────────────────────────────

  /**
   * The rows of a list a function works out: { rows, counts, q, filter }.
   * The function is given ctx.query = { q, filter } — the search typed and the
   * chip chosen (always one of the list's own chips; the first when none or
   * an unknown one is asked for, so an old link opens the first chip, not an
   * error) — and returns rows, or { rows, counts: { chipKey: n } }.
   */
  async function rows(screenKey, nodeId, query, user) {
    var doc = await published(screenKey);
    var node = fedList(doc, nodeId);
    var def = resolve(doc, 'listRows', node.props.rowsFrom);
    var chips = Array.isArray(node.props.filters) ? node.props.filters : [];
    var asked = query && query.filter;
    var filter = chips.some(function(c) { return c.key === asked; }) ? asked : (chips[0] ? chips[0].key : null);
    var q = String((query && query.q) || '').trim().slice(0, MAX_SEARCH);
    var ctx = context(doc, screenKey, user, { node: node, query: Object.freeze({ q: q, filter: filter }) });
    var out = await def.execute(ctx);
    var list = Array.isArray(out) ? out : out && Array.isArray(out.rows) ? out.rows : null;
    if (!list) throw status(500, '"' + node.props.rowsFrom + '" returned neither rows nor { rows, counts }');
    var counts = out && !Array.isArray(out) && out.counts && typeof out.counts === 'object' ? out.counts : {};
    return { rows: list, counts: counts, q: q, filter: filter };
  }

  /**
   * What one cell's hover box lists for one row: [{ text, sub?, at?, open? }],
   * from the column's `details` function, given ctx.id (the row) and ctx.column.
   */
  async function details(screenKey, nodeId, field, id, user) {
    var doc = await published(screenKey);
    var node = fedList(doc, nodeId);
    var column = (node.props.columns || []).find(function(c) { return c.field === field; });
    if (!column || !column.details) throw status(404, 'Column "' + field + '" of "' + doc.id + '" has no hover box');
    if (id === undefined || id === null || id === '') throw status(400, 'Say which row (id)');
    var def = resolve(doc, 'rowDetails', column.details);
    var out = await def.execute(context(doc, screenKey, user, { node: node, column: column, id: String(id) }));
    if (!Array.isArray(out)) throw status(500, '"' + column.details + '" returned no list of entries');
    return out.slice(0, MAX_DETAILS);
  }

  // ── a button ──────────────────────────────────────────────────────────────

  /**
   * Press a button on one record: { button, message, output }.
   *
   * The function runs through @xeplr/actions' runAction, so its inputSchema
   * checks the parameters exactly as every other run does. It is given the
   * button's parameters (and the note, when the button asks for one, and the
   * stored paths as `files`, when its ask.file takes them) as `input`, and the
   * record and caller as `system`:
   *   system = { record, id, user, tenant, knex, db, screen, screenKey, button, files, reject }
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

  async function press(screenKey, buttonId, body, user) {
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
    var attached = paths.length ? await files.buttonFiles(doc.source, button, paths, user) : [];

    var record = await scopedTable(knex, models, doc.source, { user: user }).where(doc.source + '.id', String(id)).first();
    if (!record) throw status(404, 'No ' + doc.source + ' record "' + id + '"');
    record = models.forTable(doc.source).fromDb(record);
    // What the browser drew may be out of date — somebody else changed the
    // record — and a request can be sent by hand. The record decides.
    if (!model.buttonShown(button, record) || model.buttonDisabled(button, record)) {
      throw status(409, '"' + button.label + '" does not apply to this record now — it may have just changed. Reload to see it as it is.');
    }

    resolve(doc, 'button', button.action);
    var actions = require('@xeplr/actions');
    var system = context(doc, screenKey, user, { record: record, id: String(id), button: button, files: attached });
    var run = await actions.runAction({ name: button.action, input: model.buttonInput(button, note, paths), system: system });
    if (run.status !== 'success') throw run.error || status(500, '"' + button.label + '" failed');
    var output = run.output && typeof run.output === 'object' ? run.output : {};
    return { button: button.id, message: typeof output.message === 'string' ? output.message : null, output: run.output === undefined ? null : run.output };
  }

  return { rows: rows, details: details, press: press, storeButtonFile: storeButtonFile };
}

function status(code, message) {
  var e = new Error(message);
  e.status = code;
  return e;
}

module.exports = { createFunctionsStore: createFunctionsStore };
