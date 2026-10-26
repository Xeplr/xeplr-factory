-- 0005_factory_functions.sql
--
-- GET /factory/functions — the app's registered functions a screen's events
-- (and a flow's "let a function decide") can pick. Names and descriptions,
-- never code. A DESIGN permission, like saving a draft: it is what the
-- designer chooses from. Super Admin and CompanyAdmin, like the rest of
-- factory:design.
--
-- Idempotent.

INSERT INTO "apis" (id, name, "apiGroup", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), 'List factory functions', 'factory:design', true, '*', now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "apis" a WHERE a."apiGroup" = 'factory:design' AND a.name = 'List factory functions');

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name IN ('Super Admin', 'CompanyAdmin')
  AND a.name = 'List factory functions'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);
