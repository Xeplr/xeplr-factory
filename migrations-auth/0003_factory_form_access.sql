-- 0003_factory_form_access.sql
--
-- POST /factory/entities — a new form made in the app, from its name. A design
-- permission (it leads to a new table), granted like the rest of factory:design.
-- Idempotent.

INSERT INTO "apis" (id, name, "apiGroup", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), 'Create factory form', 'factory:design', true, '*', now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "apis" a WHERE a."apiGroup" = 'factory:design' AND a.name = 'Create factory form');

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name IN ('Super Admin', 'CompanyAdmin')
  AND a.name = 'Create factory form'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);
