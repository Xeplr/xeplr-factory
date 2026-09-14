#!/usr/bin/env node

// xeplr-factory-migrate — creates factory_screens in the APP's database.
//
// Reads process.env ONLY. The consuming app loads its .env (e.g. via dotenv-cli
// in the npm script) — @xeplr/* packages never read .env files.
//
// The entity tables themselves (employees, departments, …) are NOT created
// here: they are the app's own migrations, written with `xeplr-factory
// migration` and applied by the app's normal migrate:up.

var path = require('path');
var { sqlMigrator, resolveConfig, migrationsFor, ensureDatabaseFor } = require('@xeplr/db');

function parseArgs(argv) {
  var args = { _: [] };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      var eq = argv[i].indexOf('=');
      if (eq !== -1) { args[argv[i].slice(2, eq)] = argv[i].slice(eq + 1); continue; }
      args[argv[i].slice(2)] = argv[i + 1] || true;
      i++;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

async function main() {
  var args = parseArgs(process.argv.slice(2));
  var command = args._[0];
  var options = {
    db: args.db || process.env.DB_FACTORY,
    dir: path.join(__dirname, '..', 'migrations'),
    extDir: args.extDir || args['ext-dir'] || migrationsFor('factory'),
    type: 'precede',
    connectionName: args['connection-name'] || args.connectionName || 'factory'
  };

  if (command !== 'up' && command !== 'status') {
    console.error('Usage: xeplr-factory-migrate <up|status> [--db <name>] [--connection-name <name>]');
    process.exit(1);
  }
  // No fallback to some other database name: creating factory_screens in the
  // wrong database is the one mistake a migration tool must not make quietly.
  if (!options.db) {
    console.error('Missing database: set DB_FACTORY (the app database the screens and entity tables live in) or pass --db <name>.');
    process.exit(1);
  }
  var resolved = await resolveConfig(options.connectionName);
  if (command === 'up') {
    await ensureDatabaseFor(resolved, options.db);
    await sqlMigrator.up(options);
  } else {
    await sqlMigrator.status(options);
  }
}

main().then(function() { process.exit(0); }).catch(function(err) {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
