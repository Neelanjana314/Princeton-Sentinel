import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("agent quarantine actions require a modal reason before posting", () => {
  const source = readFileSync(
    path.join(process.cwd(), "app/dashboard/agents/agent-access-control/agent-access-control-client.tsx"),
    "utf8"
  );

  assert.match(source, /title: `Confirm \$\{actionLabel\}`/);
  assert.match(source, /reason: ""/);
  assert.match(source, /body: JSON\.stringify\(\{ botId: agent\.botId, botName: agent\.botName, reason: trimmedReason \}\)/);
});

test("block card does not render an inline reason input", () => {
  const source = readFileSync(
    path.join(process.cwd(), "app/dashboard/agents/agent-access-control/agent-access-control-client.tsx"),
    "utf8"
  );

  assert.doesNotMatch(source, /const \[blockReason, setBlockReason\] = React\.useState\(""\);/);
  assert.doesNotMatch(source, /value=\{blockReason\}/);
  assert.match(source, /const formReady = selectedUser && selectedAgent && !submitting;/);
  assert.match(source, /title: "Confirm Block",[\s\S]*reason: "",/);
});
