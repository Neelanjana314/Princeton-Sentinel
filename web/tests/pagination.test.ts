import { test } from "node:test";
import assert from "node:assert/strict";

import { buildHref, buildPaginationModel, getPaginationTokens } from "../lib/pagination";

function summarizeTokens(page: number, totalPages: number, mode: "desktop" | "compact") {
  return getPaginationTokens(page, totalPages, mode).map((token) => (token.type === "page" ? token.page : "…"));
}

test("desktop pagination shows bounded tokens with ellipses in the middle range", () => {
  assert.deepEqual(summarizeTokens(10, 20, "desktop"), [1, "…", 8, 9, 10, 11, 12, "…", 20]);
});

test("desktop pagination renders all page tokens when total pages stay under the threshold", () => {
  assert.deepEqual(summarizeTokens(3, 7, "desktop"), [1, 2, 3, 4, 5, 6, 7]);
});

test("compact pagination only keeps the current page and immediate neighbors", () => {
  assert.deepEqual(summarizeTokens(10, 20, "compact"), [9, 10, 11]);
  assert.deepEqual(summarizeTokens(1, 20, "compact"), [1, 2]);
});

test("buildHref drops empty values and preserves provided params", () => {
  assert.equal(
    buildHref("/dashboard/users", { q: "alice", page: 4, pageSize: 25, sort: "email", dir: "asc", empty: "" }),
    "/dashboard/users?q=alice&page=4&pageSize=25&sort=email&dir=asc"
  );
});

test("pagination model exposes summary text and bounded desktop links", () => {
  const model = buildPaginationModel({
    pathname: "/dashboard/users",
    page: 10,
    pageSize: 10,
    totalItems: 200,
    extraParams: { q: "alice", sort: "email", dir: "asc" },
  });

  assert.equal(model.summary, "Page 10 of 20 • 200 items");
  assert.equal(model.prevHref, "/dashboard/users?q=alice&sort=email&dir=asc&page=9&pageSize=10");
  assert.equal(model.nextHref, "/dashboard/users?q=alice&sort=email&dir=asc&page=11&pageSize=10");
  assert.equal(model.showCompactJump, true);
  assert.equal(model.jumpOptions.length, 20);
  assert.equal(model.jumpOptions[0], 1);
  assert.equal(model.jumpOptions[19], 20);
  assert.deepEqual(
    model.desktopTokens.map((token) => (token.type === "page" ? token.page : "…")),
    [1, "…", 8, 9, 10, 11, 12, "…", 20]
  );
});

test("pagination model preserves custom pagination params for sharing breakdown links", () => {
  const model = buildPaginationModel({
    pathname: "/dashboard/sharing",
    page: 2,
    pageSize: 10,
    totalItems: 100,
    extraParams: { q: "project", externalThreshold: 10, page: 4, pageSize: 50, sort: "links", dir: "desc" },
    pageParam: "lbPage",
    pageSizeParam: "lbPageSize",
  });

  assert.equal(model.prevHref, "/dashboard/sharing?q=project&externalThreshold=10&page=4&pageSize=50&sort=links&dir=desc&lbPage=1&lbPageSize=10");
  assert.equal(model.nextHref, "/dashboard/sharing?q=project&externalThreshold=10&page=4&pageSize=50&sort=links&dir=desc&lbPage=3&lbPageSize=10");
  assert.equal(model.showCompactJump, true);
  assert.deepEqual(
    model.compactTokens.map((token) => (token.type === "page" ? token.page : "…")),
    [1, 2, 3]
  );
});
