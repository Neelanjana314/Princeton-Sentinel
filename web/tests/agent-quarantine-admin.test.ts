import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("admin tabs include agent quarantine", () => {
  const source = readFileSync(path.join(process.cwd(), "app/admin/AdminTabs.tsx"), "utf8");
  assert.match(source, /Agent Quarantine/);
  assert.match(source, /\/admin\/agent-quarantine/);
});

test("agent quarantine admin page is wrapped with request timing", () => {
  const source = readFileSync(path.join(process.cwd(), "app/admin/agent-quarantine/page.tsx"), "utf8");
  assert.match(source, /withPageRequestTiming/);
  assert.match(source, /export default withPageRequestTiming\("\/admin\/agent-quarantine", AgentQuarantinePage\)/);
});

test("agent quarantine admin page shows a reason column", () => {
  const source = readFileSync(path.join(process.cwd(), "app/admin/agent-quarantine/page.tsx"), "utf8");

  assert.match(source, />Reason</);
  assert.match(source, /row\.reason/);
});

test("agent quarantine admin page does not show a details column", () => {
  const source = readFileSync(path.join(process.cwd(), "app/admin/agent-quarantine/page.tsx"), "utf8");

  assert.doesNotMatch(source, />Details</);
});

test("agent quarantine admin page keeps the table inside a horizontal scroll container", () => {
  const source = readFileSync(path.join(process.cwd(), "app/admin/agent-quarantine/page.tsx"), "utf8");

  assert.match(source, /max-w-full overflow-x-auto/);
  assert.match(source, /min-w-\[1236px\]/);
});
