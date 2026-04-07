import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

test("legacy copilot route files are removed", () => {
  assert.equal(existsSync(path.join(process.cwd(), "app/dashboard/copilot/page.tsx")), false);
  assert.equal(existsSync(path.join(process.cwd(), "app/api/copilot/route.ts")), false);
});

test("app shell no longer treats dashboard/copilot as the agents route", () => {
  const source = readFileSync(path.join(process.cwd(), "components/app-shell.tsx"), "utf8");

  assert.equal(source.includes("/dashboard/copilot"), false);
});
