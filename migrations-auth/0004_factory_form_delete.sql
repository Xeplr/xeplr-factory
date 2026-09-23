-- 0004_factory_form_delete.sql
--
-- DELETE /factory/screens/:key — a form removed from the app.
--
-- A DESIGN permission, beside "Create factory form", because that is what it
-- is: the design goes, and with it the form's place in every list. It can
-- also drop the form's TABLE — but only when that table is empty and nothing
-- else describes it, so this right can never destroy records (see
-- records.removeScreen).
--
-- Super Admin and CompanyAdmin, like the rest of factory:design: whoever may
-- create a form and change its table may also remove one.
--
-- Idempotent.

INSERT INTO "apis" (id, name, "apiGroup", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), 'Delete factory form', 'factory:design', true, '*', now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "apis" a WHERE a."apiGroup" = 'factory:design' AND a.name = 'Delete factory form');

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name IN ('Super Admin', 'CompanyAdmin')
  AND a.name = 'Delete factory form'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);
