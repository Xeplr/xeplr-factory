// A NEW FORM, made in the app rather than by Claude: an entity's two screens —
// a list, and the add / edit form the list opens — saved as drafts from just
// its name. Its table does not exist until the form is published.
//
// Refused, rather than quietly merged into something already there:
//   • a name whose screens exist (for any company — ids are global)
//   • a name whose table exists — publishing onto it would ALTER a table the
//     form does not own (users, companies, a hand-written one)

var factoryModel = require('./model');

// Every new form starts with one field, so it is a valid screen that can be
// published straight away; the rest is added in the designer.
var STARTER_FIELDS = [{ label: 'Name', required: true, validation: { maxLength: 200 } }];

function createEntitiesStore(knex, screens, records) {
  /**
   * @param spec.entity   singular name, e.g. "farming department"
   * @param spec.plural   when irregular, e.g. "people"
   * @returns {{ entity, name, source, edit, list }}
   */
  async function create(spec, user) {
    spec = spec || {};
    var model = await factoryModel.load();
    var entity = String(spec.entity || '').trim();
    if (!entity) throw status(422, 'Give the form a name, e.g. "farming department"');

    var made;
    try {
      made = model.screensFromSpec({ entity: entity, plural: spec.plural ? String(spec.plural).trim() : undefined, fields: STARTER_FIELDS });
    } catch (err) {
      throw status(422, err.message);
    }
    var keys = [made.edit.id, made.list.id];

    // Unscoped on purpose: a screen id is one id for every company.
    var taken = await knex('factory_screens').whereIn('screenKey', keys).first('screenKey');
    if (taken) throw status(409, 'A form named "' + entity + '" already exists (' + taken.screenKey + ')');
    if (await records.describeTable(made.edit.source)) {
      throw status(409, 'A table named "' + made.edit.source + '" already exists — choose another name');
    }

    await screens.saveDraft(made.edit.id, made.edit, user);
    await screens.saveDraft(made.list.id, made.list, user);
    return { entity: entity, name: made.list.name, source: made.edit.source, edit: made.edit.id, list: made.list.id };
  }

  return { create: create };
}

function status(code, message) {
  var e = new Error(message);
  e.status = code;
  return e;
}

module.exports = { createEntitiesStore: createEntitiesStore };
