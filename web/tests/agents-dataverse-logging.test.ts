import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("agents dataverse API route is wrapped with request timing", () => {
  const source = readFileSync(path.join(process.cwd(), "app/api/agents/dataverse/route.ts"), "utf8");

  assert.match(source, /withApiRequestTiming/);
  assert.match(source, /export const GET = withApiRequestTiming\("\/api\/agents\/dataverse", getHandler\)/);
  assert.match(source, /export const POST = withApiRequestTiming\("\/api\/agents\/dataverse", postHandler\)/);
});

test("agents dataverse page is wrapped with page request timing", () => {
  const source = readFileSync(path.join(process.cwd(), "app/dashboard/agents/dataverse/page.tsx"), "utf8");

  assert.match(source, /withPageRequestTiming/);
  assert.match(source, /export default withPageRequestTiming\("\/dashboard\/agents\/dataverse", DataverseTablePage\)/);
});
