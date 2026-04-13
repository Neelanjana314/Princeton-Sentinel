import { test } from "node:test";
import assert from "node:assert/strict";

const nextConfig = require("../../next.config.js");

test("next config keeps security headers out of framework config", () => {
  assert.equal(nextConfig.headers, undefined);
});

test("next config disables the x-powered-by framework header", () => {
  assert.equal(nextConfig.poweredByHeader, false);
});
