# @xeplr/factory

**The server side of [`@xeplr/ui-factory`](https://www.npmjs.com/package/@xeplr/ui-factory).** It keeps versioned screen designs, and saves the records those screens create into **real tables** — one table per entity, one column per field — with the screen's own validation.

```sql
select e."firstName", d."name", e."startDate"
from employees e join departments d on d.id = e."departmentId"
where e."isActive"
```

Records are never stored as JSON. Every entity is an ordinary table your reports can query.

## How the pieces fit

| what | where |
|---|---|
| Screen designs (layout, labels, validation, styles) | `factory_screens` — one row per screen per version, draft or published |
| Records | the entity's own table: `employees`, `departments`, … |
| Creating and changing those tables | **Publish** — directly, in the publish transaction; dropping a column needs confirmation |
| Forms, lists, the designer | `@xeplr/ui-factory` in the browser, talking to these routes |
| Anything an entity needs beyond save / get / delete | functions named in the screen's [events](#events--the-apps-code-picked-by-name-in-the-screen) |

## Install

```sh
npm i @xeplr/factory @xeplr/ui-factory
```

Node 22.12 or later. Peer: `express`.

```js
var factory = require('@xeplr/factory')

await factory.init({ knex: appKnex })               // the app database — the entity tables live here
// or: await factory.init({ database: 'myapp', connection: process.env.APP_CONNECTION })

app.use(factory.router({ access: true, auth: auth.mtMembershipGate }))
// or per area: factory.router({ access: true, auth: { view, write, design } })
```

Mount it after `mtMiddleware()`: every query is scoped to the request's tenant (`mtId1…`), exactly like `BaseModel`. An app without tenancy (no `registerMTs`) gets no tenant filter.

Once:

```sh
DB_FACTORY=myapp xeplr-factory-migrate up        # creates factory_screens
```

or, in an app that runs its own migrations, put `factory.migrationsDir` first in its `sqlMigrator.up`. Add `factory.authMigrationsDir` (`node_modules/@xeplr/factory/migrations-auth`) to `XEPLR_AUTH_MIGRATIONS` for the route permissions.

### Access

Every route is a row in the auth database's `apis` catalog — `factory:view` (screens, records, options), `factory:write` (save, delete records), `factory:design` (drafts, new forms, **publish — which changes tables**) — granted to Super Admin and CompanyAdmin (all), Creator (view, write) and Viewer (view).

With `{ access: true }` each route answers only a caller whose `req.access.apis` (put on the request by the auth gate, from `/auth/api/me`) names it; anyone else gets 403 `Access denied: Publish factory screen`. A request with no `req.access` at all is refused too — the router is then mounted where no gate ran. The names are `factory.API_NAMES`.

Access is per route, not yet per screen or table: whoever may save records may save them on any published screen.

The two file routes add no rows of their own: a file field's value is a record's value, so uploading one is `Save factory record` and reading it back is `Get factory record`. Nothing new to migrate.

### The screens an app ships with

```js
await factory.publishScreens([require('./screens/task/task-edit.screen.json'), require('./screens/task/task-list.screen.json')])
```

At startup: publishes each screen that has **no published version yet** — creating its table — and leaves the rest alone, so a restart never puts a file back over a design someone has since changed. Ordered for you (a table before the dropdowns that point at it, lists last). Published for every tenant (`'*'`); a company's own later version wins for that company.

## A new entity, start to finish

Usually done by Claude from a request like *"a form for farming departments with name, region and head"*:

```sh
npx xeplr-factory screens farming-department.entity.json -o src/screens/farming-department
```

Save the two screens as drafts and **Publish** them (from the designer, or `PUT …/draft` then `POST …/publish`). **Publishing creates the table** — no migration files. Nothing else to deploy: the routes below serve every screen by its id.

## Changing a form later

Edit the draft and publish again. The table is compared with the screen **as the table really is** in the database, and changed in the same transaction that publishes — both happen or neither:

| change | on publish |
|---|---|
| new field | `ADD COLUMN` |
| wider (varchar 80 → 120, varchar → text, integer → numeric) | `ALTER COLUMN … TYPE` |
| narrower, a foreign key moved, timestamp → date | **refused** (409), nothing runs |
| a field that changed kind (text → number, date, yes/no; number → text; decimal → whole) | **a conversion.** Every saved value is checked first, across every company: if any will not fit, 409 with `wontFit: [{ column, from, to, failing, samples }]` and nothing runs. If all fit, it **asks first** (409 with `convert: [{ column, from, to, records }]`); publish again with `{ "confirmConvert": ["age"] }` to `ALTER … TYPE … USING`, blanks becoming NULL |
| field removed | **asks first** (409 with `confirm: [{ column, records }]`); publish again with `{ "confirmDrop": ["phone"] }` to `DROP COLUMN` — the column and all its values, for every company |
| a column no screen created, or one another company's screen still uses | never dropped (reported in `keep`) |
| field renamed | field names that are already columns are **locked** in the designer (`lockedNames`) — a rename would drop the old column's data |

The database user needs permission to create and alter tables in the app database. `npx xeplr-factory migration edit.screen.json` previews the SQL without running it.

## Columns

| control | column |
|---|---|
| text | `varchar(maxLength)` (255 without one) |
| textarea | `text` |
| number | `integer` if whole numbers only, else `numeric` |
| date | `date` |
| date & time | `timestamp` |
| checkbox | `boolean NOT NULL DEFAULT false` |
| dropdown / radio from a table | `varchar(25) REFERENCES "<table>"("id")` — a real foreign key |
| dropdown / radio with fixed options | `varchar(50)` |
| multi-select | `text` — every chosen id, joined by commas |
| file | `varchar(255)` — the stored file's path, not its bytes |
| stepper, label | **no column** — they hold no value |

Plus every xeplr table's `id`, `isActive`, `mtId1–4`, `recordCreated/Modified Date/By`. A table a dropdown, radio or multi-select reads needs an `id` and a `name` column.

A **stepper** is a way through one form, not several forms. The step a field sits on is `node.step` beside its `x/y/w/h` — nothing a table knows about — so every field is a column, is checked and is saved whichever step is showing, including a step nobody opened. Holding back at a step until its own fields are filled in is the browser's job; a save that arrives without a required field on a later step is refused here like any other, naming that field.

**Two of them do not go into their column as they are read**, and the conversion is `@xeplr/ui-factory`'s (`toDbValue` / `fromDbValue`), so the browser and the server cannot drift apart:

| | on the wire | in the column |
|---|---|---|
| multi-select | `["soil", "water"]` | `soil,water` — one column, so an option id may not contain a comma |
| date & time | `"2026-10-01T09:30"` | `timestamp`, read back **as text**, like a `date`: no timezone may move the moment that was typed in |

A choice from a **fixed** list is checked against that list on the server too — `@xeplr/schema-handler`'s `options` compares one value, so it covers a dropdown and a radio but cannot check a multi-select's array. An id nobody offered is 400, naming the field. Options that come from a table are left to the column's foreign key.

## Files

A **file** field stores one thing in its column: the path the upload answered with. The bytes live under `filesDir`, in a folder per company and per table:

```
<filesDir>/<mtId1 or 'shared'>/<table>/<id>__<name>       c1/surveys/9f3c…__Field_notes.txt
```

The id in front keeps two people's `scan.pdf` apart; the name after `__` is what the form shows and what the download is called (`fileLabel()` in `@xeplr/ui-factory` reads it, on both sides). A name is reduced to letters, digits, dot, dash and underscore — nothing that could become a directory of its own.

```js
await factory.init({ knex: appKnex, filesDir: '/var/lib/myapp/files' })
```

`filesDir` defaults to `FACTORY_FILES_DIR`, and without one to `./uploads/factory`. Uploading needs **`multer`** (`npm i multer`) — an optional peer, loaded on the first upload, so an app with no file fields never installs it.

**The field's own rules decide, and the extension is the authority.** `POST /factory/files/:key/:field` looks the screen up, finds that `file` field, and checks the file against *its* `accept` (a list of extensions) and `maxSize` (megabytes) — 400 either way, with the field's label in the message. A browser's content type is the sender's word for it and is not consulted at all. Anything refused is deleted, not left in a corner of the disk.

**Nothing is served from the disk.** There is no static directory: the only way back out is `GET /factory/files/<path>`, behind the same guard as reading a record. The path is resolved inside `filesDir` and anything that climbs out of it is refused (400); a path with nothing at it is 404. **A file in another company's folder is 404 as well** — the folder is the same `mtId1` the rows are scoped by, so a path is not a permission just because someone has it.

One limit worth knowing: within a company the route checks **access, not ownership** — a caller who may read that table's records may fetch any of its stored paths. And a file whose record is deleted, or whose value is replaced, stays on disk; tidying those up is the app's to schedule.

## Events — the app's code, picked by name in the screen

When an entity needs more than the generic save — a code worked out on save, an email after, a list only managers see — write a **function**, register it with `@xeplr/actions` under the **event** it is for, and name it in the screen:

```js
// functions/employees.js — loaded once at startup
var { register } = require('@xeplr/actions')

register({
  name: 'checkSalaryBand', event: 'beforeSave',
  description: 'Refuses a salary outside the grade band',
  execute: function(ctx) {
    if (ctx.values.salary > 200000) ctx.reject('Above the band for this grade', { field: 'salary' })
    return Object.assign({}, ctx.values, { employeeCode: String(ctx.values.employeeCode).toUpperCase() })
  }
})
register({ name: 'notifyHR', event: 'afterSave', execute: async function(ctx) { if (ctx.isNew) await mail.welcome(ctx.result) } })
register({ name: 'ownDepartmentOnly', event: 'beforeLoad', execute: function(ctx) { if (!ctx.user.isManager) ctx.query.where('employees.departmentId', ctx.user.departmentId) } })
```

```json
"events": { "beforeSave": "checkSalaryBand", "afterSave": "notifyHR", "beforeLoad": "ownDepartmentOnly" }
```

The designer offers each event the functions written for it (`GET /factory/functions`); a screen saved by hand or by Claude names them the same way.

| event | runs | `ctx` adds | return |
|---|---|---|---|
| `beforeLoad` | before the list, and one record for Edit, are read | `query` (knex — narrow it), `id` / `many` | nothing, or a new query |
| `beforeSave` | before create and update — the screen's rules then check what it returns | `values`, `isNew`, `previous` (update) | the values to save, or nothing |
| `afterSave` | once saved | `result` (the saved row) | ignored. If it throws, the save **still happened**: it is logged and `onError` is told |
| `beforeDelete` | before a delete (`isActive = false`) | `previous` | nothing |
| `onError` | when loading, saving or deleting failed | `error` | ignored — the original error is still the response |

Anywhere, `ctx.reject(message, { field })` stops with a 422 whose message the form shows **on that field**.

**The rules:**

- **One way.** The screen is the one place that says what runs — one function per event, named there. There are no hook files beside it.
- **Every event runs on the server.** A rule in the browser is one a person can skip.
- **A list screen runs the events of the screen it edits in**, so one set covers an entity.
- **Nothing fails quietly.** Publishing refuses a screen that names a function nobody registered, or one written for another event — by name (422, `body.missingFunctions`). A function that later stops being registered fails the operation with its name (500), rather than saving without its rule.
- `@xeplr/actions` (`^1.4.0`) is a **peer** dependency: the app's one registry, shared with `@xeplr/workflow-engine`, whose flows pick `decide` functions from it the same way. An app whose screens name no functions does not need it.

`ctx` always holds:

| field | |
|---|---|
| `op`, `screenKey`, `screen`, `table` | what is running, and the published screen |
| `user`, `tenant` | `req.user` and the request's `mtId1…` |
| `knex` | the app database — for your own queries |
| `db()` | `factory.table()` on this form's table: this company, active rows, audit, the model |
| `input` | what the UI sent, read-only |
| `id` | the record; `null` for a new record or a list |
| `reject(message, { field })` | refuse, with the message on a field |

### From 1.x

1.x attached **hook files** per screen (`init({ hooks })`, `registerHooks`, `save.before` / `get.after` / `override`). 2.0 removes them, and passing them **stops startup** with a message saying so — a rule that silently stopped running would be worse. Move each hook into a registered function and name it in the screen's events: `save.before` → `beforeSave`, `save.after` → `afterSave`, `get.before` → `beforeLoad`, `delete.before` → `beforeDelete`, `error` → `onError`. `get.after` and `override` have no event: shape a record with the table's model (`FactoryModel`) instead.

## Models

How a form's values are shaped between your code and its table — like Sequelize's getters and setters. One file per form (`api/screens/task/task.model.js`):

```js
var { FactoryModel } = require('@xeplr/factory')

class TaskModel extends FactoryModel {
  static table = 'tasks'
  static fields = {
    tags: {
      set: (value) => (Array.isArray(value) ? value.join(',') : value),   // before it is written
      get: (value) => (value ? value.split(',') : [])                     // after it is read
    }
  }
  // More than one field at a time: override and call super.
  static toDb(values) { return super.toDb(values) }
  static fromDb(row) { return super.fromDb(row) }
}

await factory.init({ knex, models: [TaskModel] })     // or factory.registerModel(TaskModel)
```

Every path uses it: the screens' routes (setters after `beforeSave` and before the screen's rules; getters as records are read) and `factory.table()`. A table with no model is left as it is. **Models shape data; events decide behaviour.**

## Your own queries: `factory.table()`

The form tables are ordinary tables, so plain `knex('tasks')` works — but then the factory's rules are yours to remember. `factory.table()` is knex with them applied:

```js
var open = await factory.table('tasks').where({ status: 'todo' })             // this company's active rows, through the getters
await factory.table('tasks', { user: req.user }).insert({ title: 'Plant seeds' })   // id, company, audit filled in; setters
await factory.table('tasks', { user: req.user }).where({ id }).update({ status: 'done' })   // audit; cannot change the company
await factory.table('tasks').where({ id }).del()                              // soft: isActive = false
```

Everything else is knex (`join`, `orderBy`, `count`, `first` …). Inside a hook it is `ctx.db()`. Use plain `knex('tasks')` only for work that must see every company.

## Routes

All under `/factory`; responses are xeplr's `{ code, message, error, dataArray }`.

| route | does |
|---|---|
| `GET /factory/screens` | every screen: latest published version, draft waiting? |
| `GET /factory/screens/:key` | latest published (`?draft=true` for the draft), with `lockedNames` |
| `PUT /factory/screens/:key/draft` | save the draft `{ document }` — refused (422) if it does not validate |
| `POST /factory/screens/:key/publish` | draft → next version, table created / changed to match; `{ confirmDrop }` to allow dropping columns, `{ confirmConvert }` to allow converting them |
| `POST /factory/entities` | a new form `{ key, label? }` — the key (`farming_department`) names the screens and the table and is fixed once published; the label is what people see: its list and edit screens as drafts, with a starter Name field. Refused (409) if the screens or the table already exist |
| `DELETE /factory/screens/:key` | remove a form. The design always goes; its table is dropped only when it is **empty** and no other screen reads it, otherwise it is kept and the answer says how many rows kept it. Refused while another form's dropdown points at the table, or while another form shows it inside itself (a subform), naming that form. Group `factory:design` (migration 0004) |
| `GET /factory/functions` | the app's registered functions a screen's events (and a flow's `decide`) can pick: `[{ name, event, description }]`, never code. Group `factory:design` (migration 0005) |
| `GET /factory/tables` | tables a dropdown can point at: **masters first**, by the name people know them as ("Departments"), then every other table a published screen reads |
| `GET /factory/options/:table` | `[{ id, name }]` for a dropdown |
| `GET /factory/records/:key` | a screen's records (a list screen reads its edit screen's fields). `?belongsTo=departmentId&belongsToId=<id>` returns only the rows whose column equals that id — a sub-table on a form. No id means **no rows**, never every row |
| `GET /factory/records/:key/:id` | one record — what Edit opens |
| `POST /factory/records/:key/save` | `{ id?, values }` → create or update; 422 with `fields` if a rule or a hook's `reject` fails |
| `POST /factory/records/:key/delete` | `{ id }` → `isActive = false` |
| `POST /factory/files/:key/:field` | one file (multipart, field `file`) for that screen's file field → `{ path, name, size }`; `path` is what the column stores |
| `GET /factory/files/<path>` | that file back, under the name it was uploaded with |

**What a request can reach:** table and column names come only from a published screen, and are checked against the table's real columns before any query. A request names a screen — never a table or a column. Values go through `@xeplr/schema-handler`'s `applySchema` with the screen's own rules, so the server accepts exactly what the form does.

### Sub-tables, codes and masters

- **A sub-table is one equality.** `belongsTo` names a column of the listed table; it is checked against the table's real columns, and the rows returned are those whose value equals `belongsToId` — the parent record's `id`. No general filter reaches the server: a query language nobody designed is a way to ask about anything.
- **Codes are minted on the server, on the first save.** A field the screen marks as a generated code (`CMP-7K3QF9`, with its own prefix) is filled in here, once — a browser cannot be trusted to mint one, and a code that changed on edit could not be quoted. A **counted** identifier is the database's own identity column and is never written from here, on create or update.
- **Masters** are forms marked `master` in the builder (Departments, statuses). They come first in `GET /factory/tables`, named, so a dropdown points at them by choice.

## In the browser

```js
import { createFactoryApi, FactoryScreen, FactoryBuilder } from '@xeplr/ui-factory'
import { authFetch } from '@xeplr/ui-account'

const api = createFactoryApi({ fetch: authFetch })

<FactoryScreen document={employeeList} {...api.screenProps} />
<FactoryBuilder document={draft.document} lockedNames={draft.lockedNames} {...api.builderProps} />
```

## Tests

```sh
npm test
```

Runs against a real Postgres (the usual `PG*` variables): a throwaway database, the routes over HTTP, tables created and changed by publishing, records in real tables. Skipped — and reported as skipped — when no Postgres is reachable.

## License

MIT
