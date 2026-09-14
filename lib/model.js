// The screen model — validation, the form's schema, the table a screen
// describes — lives in @xeplr/ui-factory, where the builder and Claude use it.
// The server uses the SAME code, so what a screen accepts in the browser and
// what this package writes to a table cannot drift apart.
//
// That package is ESM. Loaded with import() once, so this CommonJS package
// runs on any Node that has it, and the result is cached.

var cached = null;

function load() {
  if (!cached) cached = import('@xeplr/ui-factory/model');
  return cached;
}

module.exports = { load: load };
