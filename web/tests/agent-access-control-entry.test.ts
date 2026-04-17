import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("agent access control entry exposes explicit action affordances", () => {
  const source = readFileSync(path.join(process.cwd(), "components/agent-access-control.tsx"), "utf8");

  assert.match(source, /aria-label="Open Agent Access Control"/);
  assert.match(source, /Admin Control/);
  assert.match(source, /Open controls/);
  assert.match(source, /View details &gt;/);
  assert.match(source, /focus-visible:ring-2/);
});
