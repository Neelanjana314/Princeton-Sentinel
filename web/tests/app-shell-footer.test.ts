import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("app shell includes the dashboard footer contact information", () => {
  const source = readFileSync(path.join(process.cwd(), "components/app-shell.tsx"), "utf8");

  assert.match(source, /Copyright 2026\./);
  assert.match(source, /All Rights Reserved\./);
  assert.match(source, /Princeton Sentinel powered by Princeton IT Services/);
  assert.match(source, /className="text-center">Princeton Sentinel powered by Princeton IT Services/);
  assert.match(source, /Address: 500 Alexander Park, #201, Princeton, NJ 08540/);
  assert.match(source, /Support Email: support\.sentinel@princetonits\.com/);
  assert.match(source, /Phone Number: \+1 732-TECH-365/);
});
