// HOOKS — the app's own code around each operation on a screen's records.
//
//   // src/screens/employee/employee.hooks.js
//   module.exports = {
//     save:   { before, after, error, override },
//     get:    { before, after, error, override },   // the list, and one record (ctx.id set)
//     delete: { before, after, error, override }
//   }
//
// Registered by screen id: factory.init({ hooks: { employee_edit: require('./employee.hooks') } }).
// A list screen uses the hooks of the screen it edits in, so one file covers
// an entity.
//
// Per operation, without an override:
//   before(ctx)       first. Return new values (save) to replace them; call
//                     ctx.reject(message, { field }) to stop with a message on that field.
//   [the generic work — save: the screen's rules + insert/update; get: select; delete: soft delete]
//   after(ctx)        once it succeeded; ctx.id, ctx.result. Return a value to replace the result.
//   error(ctx, err)   if anything above failed.
//
// With an OVERRIDE, nothing else runs — no rules, no before, no generic work,
// no after, no error hook. override(ctx) does the whole operation, and what it
// returns is the response.

var OPERATIONS = ['save', 'get', 'delete'];
var HOOKS = ['before', 'after', 'error', 'override'];

/**
 * Checks a { screenId → hooks } map and fails LOUDLY on anything it would
 * otherwise ignore: `beforeSave` instead of `save.before`, a string where a
 * function belongs. A hook that silently never runs is the hardest bug there is.
 */
function validateHooks(map) {
  if (map === undefined || map === null) return {};
  if (typeof map !== 'object' || Array.isArray(map)) throw new Error('@xeplr/factory hooks: expected { screenId: { save, get, delete } }');
  Object.keys(map).forEach(function(screenId) {
    var entry = map[screenId];
    if (!entry || typeof entry !== 'object') throw new Error('@xeplr/factory hooks "' + screenId + '": expected { save, get, delete }');
    Object.keys(entry).forEach(function(op) {
      if (OPERATIONS.indexOf(op) === -1) {
        throw new Error('@xeplr/factory hooks "' + screenId + '": "' + op + '" is not an operation — use save, get or delete, each with before / after / error / override');
      }
      var hooks = entry[op];
      if (!hooks || typeof hooks !== 'object') throw new Error('@xeplr/factory hooks "' + screenId + '.' + op + '": expected { before, after, error, override }');
      Object.keys(hooks).forEach(function(name) {
        if (HOOKS.indexOf(name) === -1) throw new Error('@xeplr/factory hooks "' + screenId + '.' + op + '.' + name + '": not a hook — before, after, error or override');
        if (hooks[name] !== undefined && typeof hooks[name] !== 'function') throw new Error('@xeplr/factory hooks "' + screenId + '.' + op + '.' + name + '": must be a function');
      });
    });
  });
  return map;
}

function createHooks(initial) {
  var registry = Object.assign({}, validateHooks(initial));

  /** The hooks for one operation: the screen's own, else those of the screen it edits in. */
  function forOperation(op, screenId, editScreenId) {
    var entry = registry[screenId] || (editScreenId && registry[editScreenId]) || {};
    return entry[op] || {};
  }

  function register(screenId, hooks) {
    var one = {};
    one[screenId] = hooks;
    validateHooks(one);
    registry[screenId] = hooks;
  }

  return { forOperation: forOperation, register: register };
}

/**
 * Stop the operation with a message on a field — shown by the form exactly
 * like one of the screen's own rules.
 */
function reject(message, options) {
  var e = new Error(message);
  e.name = 'ValidationError';
  e.status = 422;
  e.details = [{ field: (options && options.field) || null, message: message }];
  throw e;
}

/** An error in a hook that runs after the fact must not become the response. */
async function quietly(fn, label) {
  try {
    return await fn();
  } catch (err) {
    console.error('[factory] ' + label + ' failed:', err);
    return undefined;
  }
}

module.exports = { createHooks: createHooks, validateHooks: validateHooks, reject: reject, quietly: quietly, OPERATIONS: OPERATIONS, HOOKS: HOOKS };
