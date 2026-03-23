import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getDefaultFeatureFlags,
  getFeatureDisabledApiResponse,
  getFeatureFlagVersion,
  getFeatureFlags,
  getFeatureFlagsPayload,
  isFeatureEnabled,
  matchesFeaturePath,
  mergeFeatureFlags,
  setFeatureFlagsQueryForTests,
} from "../app/lib/feature-flags";
import { LICENSE_FEATURE_DEFAULTS, setLicenseSummaryForTests } from "../app/lib/license";

type MockQueryResult = any[];

function setMockQuery(responses: MockQueryResult[]) {
  let index = 0;

  setLicenseSummaryForTests({
    status: "active",
    mode: "full",
    verificationStatus: "verified",
    verificationError: null,
    artifactId: "artifact-1",
    sha256: "hash",
    uploadedAt: "2026-03-23T12:00:00.000Z",
    uploadedBy: { oid: null, upn: null, name: null },
    payload: null,
    features: { ...LICENSE_FEATURE_DEFAULTS, agents_dashboard: true },
  });

  setFeatureFlagsQueryForTests(async () => {
    const response = responses[index];
    index += 1;
    if (!response) {
      throw new Error("Unexpected query");
    }
    return response;
  });
}

function clearMockQuery() {
  setFeatureFlagsQueryForTests(null);
  setLicenseSummaryForTests(null);
}

test("mergeFeatureFlags applies defaults when rows are missing", () => {
  const flags = mergeFeatureFlags([]);

  assert.deepEqual(flags, getDefaultFeatureFlags());
  assert.equal(isFeatureEnabled("agents_dashboard", flags), true);
});

test("getFeatureFlags ignores unknown feature rows", async () => {
  setMockQuery([
    [
      { feature_key: "agents_dashboard", enabled: false },
      { feature_key: "unknown_feature", enabled: true },
    ],
  ]);

  const flags = await getFeatureFlags();
  assert.equal(flags.agents_dashboard, false);

  clearMockQuery();
});

test("getFeatureFlagVersion normalizes timestamps to ISO strings", async () => {
  const updatedAt = new Date("2026-03-20T15:04:05.123Z");
  setMockQuery([[{ last_updated_at: updatedAt }]]);

  const version = await getFeatureFlagVersion();
  assert.equal(version, "2026-03-20T15:04:05.123Z");

  clearMockQuery();
});

test("getFeatureFlagsPayload returns both flags and version", async () => {
  setMockQuery([
    [{ feature_key: "agents_dashboard", enabled: false }],
    [{ last_updated_at: new Date("2026-03-20T16:00:00.000Z") }],
  ]);

  const payload = await getFeatureFlagsPayload();
  assert.deepEqual(payload, {
    flags: { agents_dashboard: false },
    version: "2026-03-20T16:00:00.000Z",
  });

  clearMockQuery();
});

test("getFeatureDisabledApiResponse returns 404 when a feature is disabled", async () => {
  setMockQuery([[{ feature_key: "agents_dashboard", enabled: false }]]);

  const response = await getFeatureDisabledApiResponse("agents_dashboard");
  assert.ok(response);
  assert.equal(response?.status, 404);
  assert.deepEqual(await response?.json(), { error: "not_found" });

  clearMockQuery();
});

test("matchesFeaturePath recognizes all agents feature routes", () => {
  assert.equal(matchesFeaturePath("agents_dashboard", "/dashboard/agents"), true);
  assert.equal(matchesFeaturePath("agents_dashboard", "/dashboard/copilot"), true);
  assert.equal(matchesFeaturePath("agents_dashboard", "/api/agents"), true);
  assert.equal(matchesFeaturePath("agents_dashboard", "/api/copilot"), true);
  assert.equal(matchesFeaturePath("agents_dashboard", "/dashboard/sites"), false);
});

test("getFeatureFlags disables agents dashboard when the license disables it", async () => {
  setMockQuery([[{ feature_key: "agents_dashboard", enabled: true }]]);
  setLicenseSummaryForTests({
    status: "active",
    mode: "full",
    verificationStatus: "verified",
    verificationError: null,
    artifactId: "artifact-2",
    sha256: "hash-2",
    uploadedAt: "2026-03-23T12:00:00.000Z",
    uploadedBy: { oid: null, upn: null, name: null },
    payload: null,
    features: { ...LICENSE_FEATURE_DEFAULTS, agents_dashboard: false },
  });

  const flags = await getFeatureFlags();
  assert.equal(flags.agents_dashboard, false);

  clearMockQuery();
});
