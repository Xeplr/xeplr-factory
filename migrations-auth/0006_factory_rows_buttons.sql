-- 0006_factory_rows_buttons.sql
--
-- The routes that run the app's functions a screen's controls name:
--
--   GET  /factory/rows/:key, /factory/rows/:key/details   'List factory rows'     factory:view
--        a list's rows worked out by a function, and a cell's hover box
--   POST /factory/buttons/:key/:button                     'Press factory button'  factory:write
--        a button's press on one record
--
-- Granted like the rest of their groups: reading rows to everyone who reads
-- records (Super Admin, CompanyAdmin, Creator, Viewer), pressing a button to
-- everyone who writes them (Super Admin, CompanyAdmin, Creator). What a
-- button may then do is the function's to check — it is given the caller.
--
-- Idempotent.

INSERT INTO "apis" (id, name, "apiGroup", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), v.name, v."group", true, '*', now(), now()
FROM (VALUES
  ('List factory rows', 'factory:view'),
  ('Press factory button', 'factory:write')
) AS v(name, "group")
WHERE NOT EXISTS (SELECT 1 FROM "apis" a WHERE a."apiGroup" = v."group" AND a.name = v.name);

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name IN ('Super Admin', 'CompanyAdmin', 'Creator', 'Viewer')
  AND a.name = 'List factory rows' AND a."apiGroup" = 'factory:view'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name IN ('Super Admin', 'CompanyAdmin', 'Creator')
  AND a.name = 'Press factory button' AND a."apiGroup" = 'factory:write'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);
