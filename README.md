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
| Anything an entity needs beyond save / get / delete | its [hooks](#hooks) file |

## Install

```sh
npm i @xeplr/factory @xeplr/ui-factory
```

Node 22.12 or later. Peer: `express`.

```js
var factory = require('@xeplr/factory')

await factory.init({ knex: appKnex })               // the app database — the entity tables live here
// or: await factory.init({ database: 'myapp', connection: process.env.APP_CONNECTION })

app.use(factory.router({ auth: auth.mtMembershipGate }))
// or per area: factory.router({ auth: { view, write, design } })
```

Mount it after `mtMiddleware()`: every query is scoped to the request's tenant (`mtId1…`), exactly like `BaseModel`.

Once:

```sh
DB_FACTORY=myapp xeplr-factory-migrate up        # creates factory_screens
```

and add `node_modules/@xeplr/factory/migrations-auth` to `XEPLR_AUTH_MIGRATIONS` for the route permissions (`factory:view`, `factory:write`, `factory:design`).

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
| narrower, or a different kind of value | **refused** (409), nothing runs |
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
| checkbox | `boolean NOT NULL DEFAULT false` |
| dropdown from a table | `varchar(25) REFERENCES "<table>"("id")` — a real foreign key |
| dropdown with fixed options | `varchar(50)` |

Plus every xeplr table's `id`, `isActive`, `mtId1–4`, `recordCreated/Modified Date/By`. A table used by a dropdown needs an `id` and a `name` column.

## Hooks

The generic routes save, read and delete a screen's records. When an entity needs more — a code worked out on save, an email after, a list only managers see — give its screen **hooks**: three operations, four hooks each.

```js
// src/screens/employee/employee.hooks.js — `xeplr-factory screens` writes an empty one
module.exports = {
  save: {
    before: async function(ctx) {
      if (ctx.values.endDate < ctx.values.startDate) ctx.reject('Ends before it starts', { field: 'endDate' })
      return Object.assign({}, ctx.values, { employeeCode: ctx.values.employeeCode.toUpperCase() })
    },
    after: async function(ctx) { if (ctx.isNew) await mail.welcome(ctx.result) },
    error: async function(ctx, err) { log.warn('employee not saved', err) }
  },
  get: {
    before: function(ctx) { if (!ctx.user.isManager) ctx.query.where('employees.departmentId', ctx.user.departmentId) }
  },
  delete: {
    before: function(ctx) { if (ctx.previous.isFounder) ctx.reject('Founders cannot be deleted') }
  }
}
```

```js
await factory.init({ knex: appKnex, hooks: { employee_edit: require('./screens/employee/employee.hooks') } })
// or later: factory.registerHooks('employee_edit', require('./screens/employee/employee.hooks'))
```

Hooks are registered by screen id. A **list screen uses the hooks of the screen it edits in**, so one file covers the entity. A misspelt operation or hook (`beforeSave`, `onSaved`) fails at startup rather than silently never running.

| operation | covers | the generic work |
|---|---|---|
| `save` | create and update | the screen's rules, then insert / update in a transaction, then read the row back |
| `get` | the list, and one record (`ctx.id` set, `GET /factory/records/:key/:id`) | a select scoped to the tenant and to active rows |
| `delete` | delete | `isActive = false` |

Each operation runs, without an override:

1. **`before(ctx)`** — first. On **save**, return an object to replace `ctx.values`; the screen's rules then check the result, so a hook can fix up what the person typed. On **get**, narrow `ctx.query` (a knex builder) or return a new one. Anywhere, `ctx.reject(message, { field })` stops with a 422 whose message the form shows **on that field**.
2. **the generic work** above.
3. **`after(ctx)`** — once it succeeded; `ctx.id` and `ctx.result` are set. Return a value to replace the response. If `after` throws, the operation has **still happened** — the error is logged, `error` is told, and the plain result is returned.
4. **`error(ctx, err)`** — when anything above failed. For telling someone; the original error is still the response.

**`override(ctx)`** is the whole operation instead. When a screen has one, **nothing generic runs** for that operation — no rules, no `before`, no query, no `after`, no `error`. What it returns is the response; what it throws (with `status`) is the error.

`ctx` holds:

| field | |
|---|---|
| `op`, `screenKey`, `screen`, `table` | what is running, and the published screen |
| `user`, `tenant` | `req.user` and the request's `mtId1…` |
| `knex` | the app database — for your own queries |
| `input` | what the UI sent, read-only |
| `id` | the record; `null` for a new record or a list |
| `isNew` | save: creating |
| `values` | save: the values being saved — replace them by returning an object from `before` |
| `previous` | save (update) and delete: the row as it was |
| `many`, `query` | get: a list or one record; the select `before` may narrow |
| `result` | after: the saved row, the rows, or `{ id }` |
| `reject(message, { field })` | stop with a message on a field |

**Columns a hook may set.** `save.before` may add columns the form does not have (`fullName` worked out from two fields) — they must be real columns of the table and not standard ones (`id`, `mtId1`, audit columns). Keys the **UI** sends that are not fields of the screen are always dropped, so a request cannot write a column the form does not show.

## Routes

All under `/factory`; responses are xeplr's `{ code, message, error, dataArray }`.

| route | does |
|---|---|
| `GET /factory/screens` | every screen: latest published version, draft waiting? |
| `GET /factory/screens/:key` | latest published (`?draft=true` for the draft), with `lockedNames` |
| `PUT /factory/screens/:key/draft` | save the draft `{ document }` — refused (422) if it does not validate |
| `POST /factory/screens/:key/publish` | draft → next version, table created / changed to match; `{ confirmDrop }` to allow dropping columns |
| `GET /factory/tables` | tables published screens use |
| `GET /factory/options/:table` | `[{ id, name }]` for a dropdown |
| `GET /factory/records/:key` | a screen's records (a list screen reads its edit screen's fields) |
| `GET /factory/records/:key/:id` | one record — what Edit opens |
| `POST /factory/records/:key/save` | `{ id?, values }` → create or update; 422 with `fields` if a rule or a hook's `reject` fails |
| `POST /factory/records/:key/delete` | `{ id }` → `isActive = false` |

**What a request can reach:** table and column names come only from a published screen, and are checked against the table's real columns before any query. A request names a screen — never a table or a column. Values go through `@xeplr/schema-handler`'s `applySchema` with the screen's own rules, so the server accepts exactly what the form does.

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
