import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("testing page contains a future-friendly license emulation section", () => {
  const source = readFileSync(path.join(process.cwd(), "app/testing/page.tsx"), "utf8");

  assert.match(source, /title="Testing"/);
  assert.match(source, /License Emulation/);
  assert.match(source, /future testing controls/);
  assert.match(source, /action="\/api\/local-testing\/license"/);
});
