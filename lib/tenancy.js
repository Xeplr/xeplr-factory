// Tenancy and audit for RAW knex queries.
//
// The entity tables are the app's own (employees, departments …), so there is
// no BaseModel class for them — and raw knex gets none of BaseModel's automatic
// scoping. This applies the same rules by hand, on every statement:
//
//   read / update / delete   (mtIdN = current OR mtIdN = '*') for each registered
//                            level, and isActive = true
//   insert                   mtIdN stamped from the request's context
//
// Exactly BaseModel's semantics (see @xeplr/db BaseModel.js): a level with no
// value in the request matches NOTHING rather than everything, and an app that
// never called registerMTs gets no tenant filter at all.

var { getMtContext, getMtConfig } = require('@xeplr/db');

/**
 * Narrow a query to the current tenant and to active rows.
 * @param query    a knex builder on `table`
 * @param columns  Set of the table's column names — only columns that exist are used
 */
function scope(query, table, columns) {
  var cfg = getMtConfig();
  var ctx = getMtContext();
  if (cfg.enabled) {
    for (var level = 1; level <= cfg.levels; level++) {
      var col = 'mtId' + level;
      if (!columns.has(col)) continue;
      var value = ctx[col];
      if (!value) {
        // No tenant in the request for a level the app requires: nothing.
        query.whereRaw('1 = 0');
        break;
      }
      query.where(function() {
        this.where(table + '.' + col, value).orWhere(table + '.' + col, '*');
      });
    }
  }
  if (columns.has('isActive')) query.where(table + '.isActive', true);
  return query;
}

/**
 * The tenant ids for a new row. Throws — naming the header — when the request
 * does not carry one the app requires, like BaseModel's $beforeInsert.
 */
function stampTenant(row, columns) {
  var cfg = getMtConfig();
  if (!cfg.enabled) return row;
  var ctx = getMtContext();
  for (var level = 1; level <= cfg.levels; level++) {
    var col = 'mtId' + level;
    if (!columns.has(col)) continue;
    if (!ctx[col]) {
      var slot = cfg.slots['l' + level] || {};
      var err = new Error('Tenant context (' + col + ') is required — the request has no ' + (slot.header || col) + ' header');
      err.status = 400;
      throw err;
    }
    row[col] = ctx[col];
  }
  return row;
}

/** Audit columns for an insert or an update, where the table has them. */
function stampAudit(row, columns, user, isInsert) {
  var now = new Date();
  var who = user && (user.id || user.userId) ? String(user.id || user.userId).slice(0, 25) : null;
  if (isInsert) {
    if (columns.has('recordCreatedDate')) row.recordCreatedDate = now;
    if (columns.has('recordCreatedBy') && who) row.recordCreatedBy = who;
    if (columns.has('isActive')) row.isActive = true;
  }
  if (columns.has('recordModifiedDate')) row.recordModifiedDate = now;
  if (columns.has('recordModifiedBy') && who) row.recordModifiedBy = who;
  return row;
}

module.exports = { scope: scope, stampTenant: stampTenant, stampAudit: stampAudit };
