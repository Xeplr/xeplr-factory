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

var { getConnection } = require('@xeplr/db');
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

/** Add or replace one screen's hooks after init. */
function registerHooks(screenId, hooks) {
  stores().hooks.register(screenId, hooks);
}

module.exports = { requiredEnv: requiredEnv, init: init, router: router, stores: stores, registerHooks: registerHooks };
