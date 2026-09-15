// factory.table('tasks') — knex on a form's table, with the rules the
// factory's own routes follow already applied:
//
//   reads     only this request's company (mtId1…, when the app has tenancy)
//             and only active rows; each row through the model's getters
//   insert    an id, the company and the audit columns filled in; values
//             through the model's setters
//   update    audit columns filled in; values through the model's setters
//   del       SOFT — isActive = false, like the Delete button
//
// Everything else is plain knex: where, orderBy, join, first, count … Plain
// knex('tasks') is still there for the rare job that must see every company.
//
// For tables made by forms — they have the standard columns (id, isActive,
// mtId1–4, record… audit columns).

var { generateId } = require('@xeplr/utils/lib/helpers');
var { scope, stampTenant, stampAudit } = require('./tenancy');

var STANDARD = new Set(['id', 'isActive', 'mtId1', 'mtId2', 'mtId3', 'mtId4', 'recordCreatedDate', 'recordModifiedDate', 'recordCreatedBy', 'recordModifiedBy']);

/**
 * @param knex
 * @param models   the registry (forTable)
 * @param table    a form's table
 * @param options.user  who to record in the audit columns
 */
function scopedTable(knex, models, table, options) {
  if (!table || typeof table !== 'string') throw new Error('factory.table: name the table, e.g. factory.table("tasks")');
  var user = options && options.user;
  var Model = models.forTable(table);
  var qb = scope(knex(table), table, STANDARD);

  var insert = qb.insert;
  qb.insert = function(data) {
    var prep = function(values) {
      var row = Model.toDb(Object.assign({}, values));
      if (!row.id) row.id = generateId();
      stampTenant(row, STANDARD);
      stampAudit(row, STANDARD, user, true);
      return row;
    };
    var rest = Array.prototype.slice.call(arguments, 1);
    return insert.apply(this, [Array.isArray(data) ? data.map(prep) : prep(data)].concat(rest));
  };

  var update = qb.update;
  qb.update = function(data) {
    var rest = Array.prototype.slice.call(arguments, 1);
    if (!data || typeof data !== 'object') return update.apply(this, arguments);
    var patch = Model.toDb(Object.assign({}, data));
    ['id', 'mtId1', 'mtId2', 'mtId3', 'mtId4', 'recordCreatedDate', 'recordCreatedBy'].forEach(function(k) { delete patch[k]; });
    stampAudit(patch, STANDARD, user, false);
    return update.apply(this, [patch].concat(rest));
  };

  qb.del = qb.delete = function() {
    return qb.update({ isActive: false });
  };

  var then = qb.then;
  qb.then = function(onFulfilled, onRejected) {
    return then.call(this, function(result) {
      var shaped = Array.isArray(result)
        ? result.map(function(row) { return isRow(row) ? Model.fromDb(row) : row; })
        : isRow(result) ? Model.fromDb(result) : result;
      return onFulfilled ? onFulfilled(shaped) : shaped;
    }, onRejected);
  };

  return qb;
}

function isRow(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

module.exports = { scopedTable: scopedTable };
