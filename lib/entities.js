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
var KEY_RE = /^[a-z][a-z0-9_]{0,60}$/;

var STARTER_FIELDS = [{ label: 'Name', required: true, validation: { maxLength: 200 } }];

function createEntitiesStore(knex, screens, records) {
  /**
   * @param spec.key      the form's KEY — lowercase letters, digits and _, singular:
   *                      "farming_department" → screens farming_department_list / _edit,
   *                      table farming_departments. Fixed once published.
   * @param spec.label    what people see — the screens' names ("Farming departments").
   *                      Renamed any time in the designer. Default: from the key.
   * @param spec.entity   instead of key: a singular name, e.g. "farming department"
   * @param spec.plural   when irregular, e.g. "people"
   * @returns {{ key, entity, name, source, edit, list }}
   */
  async function create(spec, user) {
    spec = spec || {};
    var model = await factoryModel.load();
    var key = spec.key === undefined || spec.key === null ? '' : String(spec.key).trim();
    if (key && !KEY_RE.test(key)) throw status(422, 'The key "' + key + '" — lowercase letters, digits and _, starting with a letter, e.g. farming_department');
    var entity = key ? key.replace(/_/g, ' ') : String(spec.entity || '').trim();
    if (!entity) throw status(422, 'Give the form a key, e.g. "farming_department"');

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

    var label = spec.label === undefined || spec.label === null ? '' : String(spec.label).trim();
    if (label.length > 200) throw status(422, 'The label is longer than 200 characters');
    if (label) {
      made.list.name = label;
      made.edit.name = label;
    }

    await screens.saveDraft(made.edit.id, made.edit, user);
    await screens.saveDraft(made.list.id, made.list, user);
    return { key: made.edit.id.replace(/_edit$/, ''), entity: entity, name: made.list.name, source: made.edit.source, edit: made.edit.id, list: made.list.id };
  }

  return { create: create };
}

function status(code, message) {
  var e = new Error(message);
  e.status = code;
  return e;
}

module.exports = { createEntitiesStore: createEntitiesStore };
