import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("user menu includes a local testing section and toggle labels", () => {
  const source = readFileSync(path.join(process.cwd(), "components/user-menu.tsx"), "utf8");

  assert.match(source, /showLocalTesting \?/);
  assert.match(source, /Testing/);
  assert.match(source, /href="\/testing"/);
  assert.doesNotMatch(source, /Disable Emulated License/);
  assert.doesNotMatch(source, /Enable Emulated License/);
});
