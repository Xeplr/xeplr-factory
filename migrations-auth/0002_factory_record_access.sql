-- 0002_factory_record_access.sql
--
-- GET /factory/records/:key/:id — one record, what Edit opens — added after
-- 0001. Same group as the list, granted to the same roles. Idempotent.

INSERT INTO "apis" (id, name, "apiGroup", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), 'Get factory record', 'factory:view', true, '*', now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "apis" a WHERE a."apiGroup" = 'factory:view' AND a.name = 'Get factory record');

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name IN ('Super Admin', 'CompanyAdmin', 'Creator', 'Viewer')
  AND a.name = 'Get factory record'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);
