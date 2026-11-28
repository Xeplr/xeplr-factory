# @xeplr/factory — map

Server side of `@xeplr/ui-factory`: versioned screen documents (`factory_screens`), and records saved
to the entity's REAL table (one column per field), validated with the screen's own rules. Used by
apps made with `@xeplr/cli` (and their phone apps). Not a form renderer — the screen model itself
lives in `@xeplr/ui-factory/model` and is loaded from there.

## Where things are
- `index.js` — `init({knex | database, connection, models, filesDir, hooks})` builds the stores; `router()`, `stores()`, `publishScreens(docs)` (boot-time publish of shipped screens, as every tenant `'*'`, forms ordered by `orderForPublish()`), `registerModel()`, `table()`, `FactoryModel`, `migrationsDir`, `authMigrationsDir`, `API_NAMES`, `formApiName`
- `lib/router.js` — `createFactoryRouter(stores, {auth, access})`: every `/factory/*` route (list at top of file), `API_NAMES` (catalog names), `formApiName()` (per-form `'Save factory record: <key>'`), `requireApi()`, `sendError()`, `receive()` (multer, optional peer)
- `lib/screens.js` — `createScreensStore(knex)`: `published`, `draft`, `list`, `allPublished`, `saveDraft`, `publishDraft`, `forgetScreen`, `publishedOnTableAllTenants`
- `lib/records.js` — `createRecordsStore()`: `resolve(screenKey)` (screen → table/columns), `get`, `list`, `save`, `remove` (soft), `publish()` (draft → version AND create/alter the table; `confirmDrop`/`confirmConvert`), `removeScreen`, `options`, `describeTable`, `tablesForPicker`, codes via `freeCode()`
- `lib/functions.js` — `createFunctionsStore()`: app functions a screen names — `rows`, `details`, `feed`, `recordDetails`, `suggest`, `buttonOptions`, `press` (function + params come from the published screen only)
- `lib/hooks.js` — events by name (`beforeLoad/beforeSave/afterSave/beforeDelete/onError`) registered via `@xeplr/actions`; `eventsFor()`, `resolve()`, `reject()`, `refuseHookFiles()` (1.x hook files refused)
- `lib/files.js` — `createFilesStore()`: file fields and button files under `filesDir`; `store`, `download`, `inside()` path check, `safeName`/`safeSegment`
- `lib/entities.js` — `createEntitiesStore()`: `create(spec)` makes a new form's list + edit screens as drafts
- `lib/factoryModel.js` — `FactoryModel` (per-field `set`/`get`), `createModels()`; `lib/table.js` — `scopedTable()` behind `factory.table()`
- `lib/tenancy.js` — raw-knex tenancy: `scope()` (mtIdN = current or `'*'`, `isActive`), `stampTenant()`, `stampAudit()`
- `lib/model.js` — `load()`: `import('@xeplr/ui-factory/model')` once (ESM from CJS)
- `migrations/` (factory_screens), `migrations-auth/` (apis rows for every route), `bin/migrate.js`

## Flow
- Save a record: `POST /factory/records/:key/save` → `auth.write(saveRecord, PER_FORM)` → `records.save()` → `resolve(key)` (published screen → table, real columns) → `beforeSave` event → `applySchema` (schema-handler) → `stampTenant`/`stampAudit` → insert/update → `afterSave`.
- Publish: `POST /factory/screens/:key/publish` → `records.publish()` → model validation → ALTER/CREATE table → `screens.publishDraft()`.
- Button: `POST /factory/buttons/:key/:button` → `functions.press()` → record read in caller's company → the registered function.

## To change X, edit Y
- A new route → `lib/router.js` (+ `API_NAMES`) + `migrations-auth/000N_*.sql` (group + role mappings) in the same change
- How a record is validated/written → `lib/records.js` → `save()`
- Column types / table changes on publish → `lib/records.js` → `publish()`, `checkTable()`
- What a screen document may contain → `@xeplr/ui-factory` model, not here
- A new function kind (`event`) for controls → `lib/functions.js`
- Event names / order → `lib/hooks.js` → `BY_OPERATION`, `EVENT_KEYS`
- Tenancy on entity tables → `lib/tenancy.js`
- Upload limits / folders → `lib/files.js`
- Getter/setter shaping → `lib/factoryModel.js`

## Rules and traps
- Table and column names come only from a PUBLISHED screen, checked against real columns, never from the request (`records.js`, `functions.js`).
- Entity tables are raw knex: tenancy is applied by hand in `lib/tenancy.js` — any new query must go through `scope()`/`stampTenant()` or `factory.table()`.
- Delete is soft (`isActive = false`).
- `API_NAMES` strings must match `migrations-auth` rows exactly; change both together.
- `init()` needs `knex` or a DB name; it does not run migrations itself — the host applies `migrationsDir`.
- `publishScreens()` keeps an already-published screen (it never overwrites the app's edits).
- `multer` is an optional peer: file routes need it installed.

## Test
- `npm test` (`node --test test/*.test.js`). Needs a Postgres reachable via standard libpq env (`PGHOST=localhost PGPORT=5432 PGUSER=vikasbhandari`); creates throwaway DBs; skipped (reported) without one.
- `factory.test.js` routes/publish/records; `functions.test.js` rows/buttons; `events.test.js` events; `files.test.js` uploads (sets `XEPLR_DATA_DIR`); `table.test.js` `factory.table()`; `stepper.test.js` stepper screens (every step's fields saved); `tagsChecklist.test.js` tag fields, button checklists, caller access in function context; `boot.test.js` `publishScreens` + routes guarded by the access catalog (tenancy on).
