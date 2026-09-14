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
| Creating and changing those tables | your app's migrations, drafted from the form by `xeplr-factory migration` |
| Forms, lists, the designer | `@xeplr/ui-factory` in the browser, talking to these routes |

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

Usually done by Claude from a request like *"a form for employees with name, department and start date"*:

```sh
# 1. two screens and their pages
npx xeplr-factory screens employee.entity.json -o src/screens/employee

# 2. the table, as an ordinary migration in the app
npx xeplr-factory migration src/screens/employee/employee-edit.screen.json -o migrations
#    → migrations/0067_factory_employees_create.sql   (review it; it is yours)

# 3. apply it with the app's normal migrate:up
```

Then save the screens as drafts and **Publish** them (from the designer, or `PUT …/draft` + `POST …/publish`).

**Publishing checks the table.** If the screen has a field with no column — the migration has not run — publish is refused with `409` and the exact SQL that would fix it:

```json
{ "message": "Table \"employees\" has no column for: employeeCode — run the migration that adds them",
  "dataArray": [{ "migration": "ALTER TABLE \"employees\" ADD COLUMN IF NOT EXISTS \"employeeCode\" varchar(12);" }] }
```

## Changing a form later

Draft the change, then `xeplr-factory migration employee-edit.screen.json --from <the published version> -o migrations`:

| change | migration |
|---|---|
| new field | `ADD COLUMN` |
| wider (varchar 80 → 120, varchar → text, integer → numeric) | `ALTER COLUMN … TYPE` |
| narrower, or a different kind of value | **refused** — write it by hand |
| field removed | column **kept**, noted in the migration; dropping data is your decision |
| field renamed | field names that are already columns are **locked** in the designer (`lockedNames`) |

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

## Routes

All under `/factory`; responses are xeplr's `{ code, message, error, dataArray }`.

| route | does |
|---|---|
| `GET /factory/screens` | every screen: latest published version, draft waiting? |
| `GET /factory/screens/:key` | latest published (`?draft=true` for the draft), with `lockedNames` |
| `PUT /factory/screens/:key/draft` | save the draft `{ document }` — refused (422) if it does not validate |
| `POST /factory/screens/:key/publish` | draft → next version; 409 with `migration` if the table is not ready |
| `GET /factory/tables` | tables published screens use |
| `GET /factory/options/:table` | `[{ id, name }]` for a dropdown |
| `GET /factory/records/:key` | a screen's records (a list screen reads its edit screen's fields) |
| `POST /factory/records/:key/save` | `{ id?, values }` → create or update; 422 with `fields` if a rule fails |
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

Runs against a real Postgres (the usual `PG*` variables): a throwaway database, the routes over HTTP, migrations applied, records in real tables. Skipped — and reported as skipped — when no Postgres is reachable.

## License

MIT
