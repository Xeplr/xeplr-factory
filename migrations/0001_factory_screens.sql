-- 0001_factory_screens.sql
--
-- THE SCREEN DESIGNS — layout, labels, validation, styles — one row per screen
-- per version.
--
-- ── why a document here, and real tables for records ────────────────────────
-- This table holds CONFIGURATION: what a screen looks like. Nobody reports on
-- it, and its shape is owned by @xeplr/ui-factory's validator, so it is kept as
-- the document the designer and Claude produce.
--
-- The records a screen saves are NEVER stored like this. Each entity has its own
-- table with one column per field ("employees"."firstName"), created and
-- changed by ordinary migrations (xeplr-factory migration). That is what makes
-- `select * from employees` and plain-SQL reporting work.
--
-- ── versions ────────────────────────────────────────────────────────────────
-- At most one DRAFT per screen — what the designer autosaves into — and any
-- number of PUBLISHED versions. Screens render the latest published version;
-- publishing turns the draft into the next one. Old versions are kept, so what
-- a screen looked like on a given day is answerable.
CREATE TABLE IF NOT EXISTS "factory_screens" (
  "id"          varchar(25) PRIMARY KEY,
  "screenKey"   varchar(100) NOT NULL,   -- the document's id, e.g. employee_edit
  "version"     integer NOT NULL,
  "status"      varchar(10) NOT NULL CHECK ("status" IN ('draft', 'published')),
  "name"        varchar(200),
  -- The table this screen's records live in — copied out of the document so
  -- "which screens use employees" is a query, not a scan.
  "source"      varchar(63),
  "document"    jsonb NOT NULL,
  "publishedAt" timestamp,
  "publishedBy" varchar(25),
  "isActive"    boolean DEFAULT true,
  "mtId1"       varchar(25),
  "mtId2"       varchar(25),
  "mtId3"       varchar(25),
  "mtId4"       varchar(25),
  "recordCreatedDate"  timestamp DEFAULT now(),
  "recordModifiedDate" timestamp DEFAULT now(),
  "recordCreatedBy"    varchar(25),
  "recordModifiedBy"   varchar(25)
);

CREATE INDEX IF NOT EXISTS "factory_screens_key_index"
  ON "factory_screens" ("screenKey", "status", "version");
CREATE INDEX IF NOT EXISTS "factory_screens_mt_index"
  ON "factory_screens" ("mtId1", "mtId2");
CREATE INDEX IF NOT EXISTS "factory_screens_source_index"
  ON "factory_screens" ("source");
