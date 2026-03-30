import { test } from "node:test";
import assert from "node:assert/strict";

import { getSortDirection } from "../app/lib/params";

test("getSortDirection preserves explicit descending direction", () => {
  assert.equal(getSortDirection({ dir: "desc" }, "asc"), "desc");
});

test("getSortDirection falls back when direction is missing or invalid", () => {
  assert.equal(getSortDirection(undefined, "asc"), "asc");
  assert.equal(getSortDirection({ dir: "invalid" }, "desc"), "desc");
});
