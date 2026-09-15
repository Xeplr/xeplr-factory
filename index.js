// @xeplr/factory — the server side of @xeplr/ui-factory.
//
// Screens are designed in the builder (or drafted by Claude) and saved here as
// versioned designs; the records they create live in the app's REAL tables —
// one table per entity, one column per field — which the app creates with
// ordinary migrations (`xeplr-factory migration`).
//
//   var factory = require('@xeplr/factory')
//   await factory.init({ knex: appKnex })                  // or { database, connection }
//   app.use(factory.router({ auth: auth.mtMembershipGate }))
//
// Before first use: `xeplr-factory-migrate up` (creates factory_screens), and
// the access rows in migrations-auth/.

var path = require('path');
var { getConnection, getMtConfig, runWithMt } = require('@xeplr/db');
var createFactoryRouter = require('./lib/router');
var { createScreensStore } = require('./lib/screens');
var { createRecordsStore } = require('./lib/records');
var { createHooks } = require('./lib/hooks');

var requiredEnv = [];

var _knex = null;
var _stores = null;

/**
 * @param config.knex        the app's knex instance — the database the entity tables are in
 * @param config.database    …or open one: the app database name
 * @param config.connection  its connection (encrypted string or { host, port, user, password })
 * @param config.connectionName  default 'factory'
 * @param config.hooks       { screenId: { save, get, delete } } — see lib/hooks.js
 */
async function init(config) {
  config = config || {};
  if (config.knex) {
    _knex = config.knex;
  } else {
    var dbName = config.database || process.env.DB_FACTORY;
    if (!dbName) throw new Error('@xeplr/factory: no database. Pass { knex } or { database, connection } (or set DB_FACTORY).');
    _knex = await getConnection(dbName, config.connection, { bind: false, connectionName: config.connectionName || 'factory' });
  }
  var hooks = createHooks(config.hooks);            // throws on a malformed hooks file, at startup
  var screens = createScreensStore(_knex);
  var records = createRecordsStore(_knex, screens, hooks);
  _stores = { screens: screens, records: records, hooks: hooks };
  return _stores;
}

function stores() {
  if (!_stores) throw new Error('@xeplr/factory: call init() before router()');
  return _stores;
}

/**
 * @param options.auth  middleware for every route, or { view, write, design }
 */
function router(options) {
  return createFactoryRouter(stores(), options);
}

/**
 * Publish the screens an app ships with — its starting designs — the first
 * time it runs.
 *
 * ONLY screens with no published version are published. Once a person has
 * refined a screen in the designer, the database is the design and the file is
 * history, so a restart never puts the file back over their work.
 *
 * Shared by every tenant: published with '*' in each tenancy level, so every
 * company starts from the same screens (a company's own later version wins
 * for that company). Ordered so a table is created before a dropdown points
 * at it, and a list after the form whose table it shows.
 *
 * @param documents  screen documents, in any order
 * @param options.user  who to record as the publisher (default { id: 'system' })
 * @returns {{ published: string[], kept: string[] }}
 */
async function publishScreens(documents, options) {
  var s = stores();
  var user = (options && options.user) || { id: 'system' };
  var model = await require('./lib/model').load();
  var cfg = getMtConfig();
  var everyone = {};
  if (cfg.enabled) for (var level = 1; level <= cfg.levels; level++) everyone['mtId' + level] = '*';

  var ordered = orderForPublish(documents || [], model);
  return runWithMt(everyone, async function() {
    var result = { published: [], kept: [] };
    for (var i = 0; i < ordered.length; i++) {
      var doc = ordered[i];
      if (await s.screens.published(doc.id)) { result.kept.push(doc.id); continue; }
      await s.screens.saveDraft(doc.id, doc, user);
      try {
        await s.records.publish(doc.id, {}, user);
      } catch (err) {
        err.message = 'Could not publish screen "' + doc.id + '": ' + err.message;
        throw err;
      }
      result.published.push(doc.id);
    }
    return result;
  });
}

/** Forms whose table others point at first, forms next, lists (no fields) last. */
function orderForPublish(documents, model) {
  var forms = documents.filter(function(d) { return d.source && model.inputNodes(d).length; });
  var rest = documents.filter(function(d) { return forms.indexOf(d) === -1; });
  var bySource = {};
  forms.forEach(function(d) { bySource[d.source] = d; });
  var done = [];
  var visiting = new Set();
  function visit(d) {
    if (done.indexOf(d) !== -1 || visiting.has(d)) return;     // a cycle is published in file order
    visiting.add(d);
    model.inputNodes(d).forEach(function(n) {
      var data = n.props && n.props.data;
      if (data && data.source === 'table' && bySource[data.table] && bySource[data.table] !== d) visit(bySource[data.table]);
    });
    done.push(d);
  }
  forms.forEach(visit);
  return done.concat(rest);
}

/** Add or replace one screen's hooks after init. */
function registerHooks(screenId, hooks) {
  stores().hooks.register(screenId, hooks);
}

module.exports = {
  requiredEnv: requiredEnv,
  init: init,
  router: router,
  stores: stores,
  registerHooks: registerHooks,
  publishScreens: publishScreens,
  // For an app that runs migrations itself: factory_screens into its own
  // database, and the access rows into the auth database (XEPLR_AUTH_MIGRATIONS).
  migrationsDir: path.join(__dirname, 'migrations'),
  authMigrationsDir: path.join(__dirname, 'migrations-auth'),
  API_NAMES: createFactoryRouter.API_NAMES
};
