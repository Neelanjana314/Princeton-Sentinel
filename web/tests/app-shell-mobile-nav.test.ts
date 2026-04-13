import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("mobile app shell nav uses a hamburger menu instead of horizontal scrolling", () => {
  const source = readFileSync(path.join(process.cwd(), "components/app-shell.tsx"), "utf8");

  assert.match(source, /aria-controls="mobile-nav-menu"/);
  assert.match(source, /Toggle navigation menu/);
  assert.match(source, /className="relative lg:hidden" ref=\{mobileNavRef\}/);
  assert.doesNotMatch(source, /overflow-x-auto px-4 pb-2 lg:hidden/);
  assert.doesNotMatch(source, /grid-cols-2 gap-2 px-4 pb-2 sm:grid-cols-3 lg:hidden/);
});
