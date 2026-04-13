import { test } from "node:test";
import assert from "node:assert/strict";

const { buildContentSecurityPolicy } = require("../app/lib/security-headers") as typeof import("../app/lib/security-headers");

test("buildContentSecurityPolicy includes nonce-based script and style directives in production", () => {
  const policy = buildContentSecurityPolicy({
    nonce: "test-nonce",
    isDevelopment: false,
  });

  assert.match(policy, /script-src 'self' 'nonce-test-nonce' 'strict-dynamic'/);
  assert.doesNotMatch(policy, /'unsafe-eval'/);
  assert.match(policy, /style-src 'self' 'nonce-test-nonce'/);
  assert.doesNotMatch(policy, /'unsafe-inline'/);
});

test("buildContentSecurityPolicy restores development fallbacks for Next tooling", () => {
  const policy = buildContentSecurityPolicy({
    nonce: "test-nonce",
    isDevelopment: true,
  });

  assert.match(policy, /script-src 'self' 'nonce-test-nonce' 'strict-dynamic' 'unsafe-eval'/);
  assert.match(policy, /style-src 'self' 'nonce-test-nonce' 'unsafe-inline'/);
});
