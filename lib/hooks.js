// EVENTS — the app's own code around each operation on a screen's records,
// picked BY NAME in the screen itself:
//
//   doc.events = { beforeLoad, beforeSave, afterSave, beforeDelete, onError }
//
// each the name of a function the app registered with @xeplr/actions, its
// `event` set to that key:
//
//   require('@xeplr/actions').register({
//     name: 'checkSalaryBand', event: 'beforeSave',
//     description: 'Refuses a salary outside the grade band',
//     execute: function(ctx) { if (ctx.values.salary > 200000) ctx.reject('Above the band', { field: 'salary' }) }
//   })
//
// The screen is the ONE place that says what runs — there are no hook files
// beside it (they were @xeplr/factory 1.x). A list screen runs the events of
// the screen it edits in, so one set covers an entity.
//
// Per operation:
//   before(ctx)       first. beforeSave may return new values; beforeLoad may
//                     narrow ctx.query or return a new one. ctx.reject(message,
//                     { field }) stops with a message on that field.
//   [the generic work — save: the screen's rules + insert/update; get: select; delete: soft delete]
//   after(ctx)        afterSave, once it succeeded; ctx.result. What it returns is ignored.
//   error(ctx, err)   onError, if anything above failed; ctx.error.

// Which event runs at which moment of which operation.
var BY_OPERATION = {
  get:    { before: 'beforeLoad',   error: 'onError' },
  save:   { before: 'beforeSave',   after: 'afterSave', error: 'onError' },
  delete: { before: 'beforeDelete', error: 'onError' }
};

// The same keys as @xeplr/ui-factory's SCREEN_EVENT_KEYS (its model is ESM,
// loaded asynchronously — see lib/model.js); test/events.test.js holds them equal.
var EVENT_KEYS = ['beforeLoad', 'beforeSave', 'afterSave', 'beforeDelete', 'onError'];

/**
 * @xeplr/actions, the app's registry — required only when a screen names a
 * function, so an app that uses no events does not need it installed.
 */
function registry() {
  try {
    return require('@xeplr/actions');
  } catch (err) {
    var e = new Error('@xeplr/factory: this screen names functions in its events, so @xeplr/actions must be installed — the registry they are registered in');
    e.status = 500;
    throw e;
  }
}

/**
 * The registered function for one event of one screen — or a loud failure.
 * A screen that names a function nobody registered (renamed, deleted, never
 * written) refuses rather than quietly saving without its rule.
 */
function resolve(doc, event, name) {
  var def = registry().get(name);
  var e;
  if (!def) {
    e = new Error('Screen "' + doc.id + '" runs "' + name + '" ' + event + ', but no function of that name is registered — register it with @xeplr/actions, or change the screen\'s events');
  } else if (def.event !== event) {
    e = new Error('Screen "' + doc.id + '" runs "' + name + '" ' + event + ', but "' + name + '" is written for ' + (def.event ? '"' + def.event + '"' : 'a workflow step'));
  }
  if (e) { e.status = 500; throw e; }
  return def;
}

/**
 * { before, after, error } for one operation, from the screen's events. Only
 * the moments the screen names a function for are present, exactly as the
 * record code expects of hooks.
 */
function eventsFor(op, doc) {
  var named = (doc && doc.events) || {};
  var moments = BY_OPERATION[op] || {};
  var out = {};
  Object.keys(moments).forEach(function(moment) {
    var event = moments[moment];
    var name = named[event];
    if (!name) return;
    if (moment === 'error') {
      out.error = function(ctx, err) { return resolve(doc, event, name).execute(Object.assign({}, ctx, { error: err })); };
    } else if (moment === 'after') {
      // An after event's answer is not the response — it does something.
      out.after = async function(ctx) { await resolve(doc, event, name).execute(ctx); return undefined; };
    } else {
      out.before = function(ctx) { return resolve(doc, event, name).execute(ctx); };
    }
  });
  return out;
}

/**
 * @xeplr/factory 1.x took hook files ({ hooks } at init, registerHooks). They
 * would be IGNORED now, and a rule that silently stops running is the worst
 * kind of failure — so passing them stops the app at startup, saying what
 * replaced them.
 */
function refuseHookFiles(hooks) {
  if (hooks === undefined || hooks === null) return;
  if (typeof hooks === 'object' && !Array.isArray(hooks) && !Object.keys(hooks).length) return;
  throw new Error('@xeplr/factory 2: hook files are gone. Register each function with @xeplr/actions (with its `event`: ' +
    EVENT_KEYS.join(', ') + ') and name it in the screen\'s events — see the README, "Events".');
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

module.exports = { eventsFor: eventsFor, refuseHookFiles: refuseHookFiles, reject: reject, quietly: quietly, BY_OPERATION: BY_OPERATION, EVENT_KEYS: EVENT_KEYS };
