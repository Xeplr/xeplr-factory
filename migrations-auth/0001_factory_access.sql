-- 0001_factory_access.sql
--
-- Every route @xeplr/factory adds, in the access catalog, and who may use it.
-- Run by the host into its auth database (list this directory in
-- XEPLR_AUTH_MIGRATIONS). Idempotent: safe to re-run.
--
--   factory:view    read screens and records, dropdown options
--   factory:write   save and delete records
--   factory:design  save drafts, publish screens

INSERT INTO "roles" (id, name, "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, true, '*', now(), now()
FROM (VALUES ('Super Admin'), ('CompanyAdmin'), ('Creator'), ('Viewer')) AS v(name)
WHERE NOT EXISTS (SELECT 1 FROM "roles" r WHERE r.name = v.name);

INSERT INTO "apis" (id, name, "apiGroup", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, "group", true, '*', now(), now()
FROM (VALUES
  ('List factory screens', 'factory:view'),
  ('Get factory screen', 'factory:view'),
  ('List factory tables', 'factory:view'),
  ('List factory options', 'factory:view'),
  ('List factory records', 'factory:view'),
  ('Save factory record', 'factory:write'),
  ('Delete factory record', 'factory:write'),
  ('Save factory screen draft', 'factory:design'),
  ('Publish factory screen', 'factory:design')
) AS v(name, "group")
WHERE NOT EXISTS (SELECT 1 FROM "apis" a WHERE a."apiGroup" = v."group" AND a.name = v.name);

-- Super Admin and CompanyAdmin: everything.
INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name IN ('Super Admin', 'CompanyAdmin')
  AND a."apiGroup" LIKE 'factory:%'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);

-- Creator: use the screens (read and write records), not redesign them.
INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'Creator'
  AND a."apiGroup" IN ('factory:view', 'factory:write')
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);

-- Viewer: read only.
INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'Viewer'
  AND a."apiGroup" = 'factory:view'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);
