import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import AdminVersionBadge from "../app/admin/AdminVersionBadge";
import { getAppVersion } from "../app/lib/version";

const { bumpVersion } = require(path.join(process.cwd(), "scripts/compute-app-version.cjs")) as {
  bumpVersion: (currentVersion: string, releaseType?: string, commitTitle?: string) => string;
};

test("getAppVersion returns APP_VERSION when provided", () => {
  const originalAppVersion = process.env.APP_VERSION;

  process.env.APP_VERSION = "9.8.7";

  assert.equal(getAppVersion(), "9.8.7");

  if (originalAppVersion === undefined) {
    delete process.env.APP_VERSION;
  } else {
    process.env.APP_VERSION = originalAppVersion;
  }
});

test("getAppVersion falls back to package.json version", () => {
  const originalAppVersion = process.env.APP_VERSION;
  delete process.env.APP_VERSION;

  assert.equal(getAppVersion(), "2.0.0");

  if (originalAppVersion !== undefined) {
    process.env.APP_VERSION = originalAppVersion;
  }
});

test("version bumping defaults to patch for normal changes", () => {
  assert.equal(bumpVersion("2.0.0", "auto", "Fix admin header spacing"), "2.0.1");
});

test("version bumping promotes feat commits to minor", () => {
  assert.equal(bumpVersion("2.0.1", "auto", "feat: add revoke log filters"), "2.1.0");
});

test("version bumping supports manual major releases", () => {
  assert.equal(bumpVersion("2.1.7", "major", "feat: ignored"), "3.0.0");
});

test("admin version badge renders the current version label", () => {
  const markup = renderToStaticMarkup(<AdminVersionBadge version="2.0.0" />);

  assert.match(markup, /Version 2\.0\.0/);
});
