import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildSitePrincipalCountsCte } from "../app/lib/site-principal-counts";

test("site principal counts CTE preserves guest and domain-aware external semantics", () => {
  const sql = buildSitePrincipalCountsCte({ paramIndex: 3, sourceAlias: "p" });

  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE p\.is_guest\)::int AS guest_users/);
  assert.match(sql, /WHERE NOT p\.is_guest/);
  assert.match(sql, /COALESCE\(array_length\(\$3::text\[], 1\), 0\) > 0/);
  assert.match(sql, /p\.email_domain IS NOT NULL/);
  assert.match(sql, /NOT \(p\.email_domain LIKE ANY\(\$3::text\[]\)\)/);
});

test("site principal identities migration defines MV, indexes, dependencies, and queue seed", () => {
  const migrationPath = path.join(process.cwd(), "..", "db", "migrations", "20260407_0015_site_principal_identities.sql");
  const sql = readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_site_principal_identities AS/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_site_principal_identities_uidx/);
  assert.match(sql, /ON mv_msgraph_site_principal_identities \(site_key, email\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS mv_msgraph_site_principal_identities_lookup_idx/);
  assert.match(sql, /INSERT INTO mv_dependencies \(mv_name, table_name\) VALUES/);
  assert.match(sql, /'mv_msgraph_site_principal_identities', 'msgraph_drive_item_permission_grants'/);
  assert.match(sql, /INSERT INTO mv_refresh_queue \(mv_name, dirty_since, attempts, last_attempt_at\)/);
});
