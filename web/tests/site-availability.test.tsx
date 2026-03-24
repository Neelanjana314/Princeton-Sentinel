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

const { SiteAvailabilityNotice } = require("../app/sites/[driveId]/site-availability-notice") as typeof import("../app/sites/[driveId]/site-availability-notice");
const { describeAvailabilityReason } = require("../app/lib/site-availability") as typeof import("../app/lib/site-availability");

test("site availability notice renders cached-only messaging for unavailable drives", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SiteAvailabilityNotice, {
      isAvailable: false,
      lastAvailableAt: "2026-03-23T20:40:10.000Z",
      availabilityReason: "blocked_site",
    })
  );

  assert.match(markup, /Cached-only view/);
  assert.match(markup, /Unavailable in Graph/);
  assert.match(markup, /Last available:/);
  assert.match(markup, /Access to this site has been blocked/);
});

test("availability reasons are humanized for the UI", () => {
  assert.equal(describeAvailabilityReason("graph_not_found"), "Graph could not find this resource");
  assert.equal(describeAvailabilityReason("resource_not_found"), "Graph reported the resource was not found");
});
