// EVERY migration, in order — what a suite must run before it touches the
// schema.
//
// Each suite used to read `0001_factory_screens.sql` by name, which meant the
// tests ran against the schema as it was when they were written: the day a
// second migration landed, every suite was testing last year's table and the
// failure, when it came, named a column rather than a missing migration.
var fs = require('fs');
var path = require('path');

var DIR = path.join(__dirname, '..', 'migrations');

module.exports = async function applyMigrations(knex, dir) {
  var from = dir || DIR;
  var files = fs.readdirSync(from).filter(function(f) { return f.endsWith('.sql'); }).sort();
  for (var i = 0; i < files.length; i++) {
    await knex.raw(fs.readFileSync(path.join(from, files[i]), 'utf8'));
  }
  return files;
};
