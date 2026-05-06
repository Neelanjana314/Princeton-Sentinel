import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Module = require("node:module");
const testGlobals = globalThis as typeof globalThis & {
  __psTmpAliasRegistered?: boolean;
};

if (!testGlobals.__psTmpAliasRegistered) {
  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function patchedResolveFilename(request: string, parent: unknown, isMain: boolean, options: unknown) {
    if (request.startsWith("@/")) {
      const mapped = path.join(process.cwd(), ".tmp-tests", request.slice(2));
      return originalResolveFilename.call(this, mapped, parent, isMain, options);
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
  testGlobals.__psTmpAliasRegistered = true;
}

const {
  AppliedFilterTags,
  ResetFiltersButton,
  formatSearchFilterValue,
} = require("../components/filter-bar") as typeof import("../components/filter-bar");

test("applied filter tags render all supplied filter labels and values", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AppliedFilterTags, {
      tags: [
        { label: "Search", value: "finance" },
        { label: "Page size", value: 50 },
      ],
    })
  );

  assert.match(markup, /Applied filters/);
  assert.match(markup, /Search: finance/);
  assert.match(markup, /Page size: 50/);
});

test("empty search filter values render explicitly as all", () => {
  assert.equal(formatSearchFilterValue(""), "All");
  assert.equal(formatSearchFilterValue("   "), "All");
  assert.equal(formatSearchFilterValue(null), "All");
});

test("applied filter tags expose accessible label text", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AppliedFilterTags, {
      tags: [{ label: "Search", value: formatSearchFilterValue("") }],
    })
  );

  assert.match(markup, /aria-label="Applied filters"/);
  assert.match(markup, /aria-label="Search: All"/);
  assert.match(markup, /Search: All/);
});

test("reset filters button links to the default dashboard route", () => {
  const markup = renderToStaticMarkup(React.createElement(ResetFiltersButton, { href: "/dashboard/activity" }));

  assert.match(markup, /href="\/dashboard\/activity"/);
  assert.match(markup, />Reset<\/a>/);
});
