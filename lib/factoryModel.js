// A FORM'S MODEL — how its values are shaped between your code and its table,
// like Sequelize's getters and setters.
//
//   class TaskModel extends FactoryModel {
//     static table = 'tasks'
//     static fields = {
//       tags: {
//         set: (value) => (Array.isArray(value) ? value.join(',') : value),   // before it is written
//         get: (value) => (value ? value.split(',') : [])                     // after it is read
//       }
//     }
//   }
//   factory.init({ knex, models: [TaskModel] })     // or factory.registerModel(TaskModel)
//
// Used on every path: the screens' routes (after save.before, before the
// screen's rules; after reading, before get.after) and factory.table().
//
// For more than per-field conversions, override toDb / fromDb and call super:
//
//   static toDb(values) {
//     return super.toDb({ ...values, fullName: values.firstName + ' ' + values.lastName })
//   }

class FactoryModel {
  /** The values about to be written: each field's set(value, values). */
  static toDb(values) {
    return convert(values, this.fields, 'set');
  }

  /** A row just read: each field's get(value, row). */
  static fromDb(row) {
    return convert(row, this.fields, 'get');
  }
}

FactoryModel.table = null;
FactoryModel.fields = {};

function convert(values, fields, direction) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return values;
  var out = Object.assign({}, values);
  Object.keys(fields || {}).forEach(function(name) {
    var fn = fields[name] && fields[name][direction];
    if (typeof fn === 'function' && Object.prototype.hasOwnProperty.call(out, name)) out[name] = fn(out[name], values);
  });
  return out;
}

/** table → model. A table with none gets FactoryModel itself, which changes nothing. */
function createModels(initial) {
  var byTable = new Map();

  function register(Model) {
    if (typeof Model !== 'function' || !(Model === FactoryModel || Model.prototype instanceof FactoryModel)) {
      throw new Error('@xeplr/factory models: expected a class that extends FactoryModel');
    }
    if (!Model.table || typeof Model.table !== 'string') {
      throw new Error('@xeplr/factory models: ' + (Model.name || 'a model') + ' needs static table = "<its table>"');
    }
    Object.keys(Model.fields || {}).forEach(function(name) {
      var f = Model.fields[name];
      ['get', 'set'].forEach(function(k) {
        if (f && f[k] !== undefined && typeof f[k] !== 'function') throw new Error('@xeplr/factory models: ' + Model.name + '.fields.' + name + '.' + k + ' must be a function');
      });
    });
    byTable.set(Model.table, Model);
  }

  (initial || []).forEach(register);
  return { register: register, forTable: function(table) { return byTable.get(table) || FactoryModel; } };
}

module.exports = { FactoryModel: FactoryModel, createModels: createModels };
