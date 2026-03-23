import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

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

const { getAdminJobControlState } = require("../app/admin/job-control") as typeof import("../app/admin/job-control");
const { deriveJobStatus } = require("../app/admin/job-status") as typeof import("../app/admin/job-status");
const { LICENSE_FEATURE_DEFAULTS, setLicenseSummaryForTests } = require("../app/lib/license") as typeof import("../app/lib/license");
type EffectiveLicenseSummary = import("../app/lib/license").EffectiveLicenseSummary;

function makeSummary(overrides: Partial<EffectiveLicenseSummary> = {}): EffectiveLicenseSummary {
  return {
    status: "active",
    mode: "full",
    verificationStatus: "verified",
    verificationError: null,
    artifactId: "artifact-1",
    sha256: "hash",
    uploadedAt: "2026-03-23T12:00:00.000Z",
    uploadedBy: { oid: null, upn: null, name: null },
    payload: null,
    features: { ...LICENSE_FEATURE_DEFAULTS, job_control: true },
    ...overrides,
  };
}

function clearLicenseOverride() {
  setLicenseSummaryForTests(null);
}

test("admin job control helper stays enabled when job_control is available", async () => {
  setLicenseSummaryForTests(makeSummary());
  try {
    const state = await getAdminJobControlState();

    assert.equal(state.jobControlEnabled, true);
    assert.equal(state.reason, null);
  } finally {
    clearLicenseOverride();
  }
});

test("admin job control helper disables controls for expired licenses", async () => {
  setLicenseSummaryForTests(
    makeSummary({
      status: "expired",
      mode: "read_only",
      verificationError: "license_expired",
      features: { ...LICENSE_FEATURE_DEFAULTS, job_control: false },
    })
  );

  try {
    const state = await getAdminJobControlState();

    assert.equal(state.jobControlEnabled, false);
    assert.equal(state.reason, "license_expired");
  } finally {
    clearLicenseOverride();
  }
});

test("admin job control helper disables controls when no license is active", async () => {
  setLicenseSummaryForTests(
    makeSummary({
      status: "missing",
      mode: "read_only",
      verificationStatus: "missing",
      verificationError: "license_missing",
      features: { ...LICENSE_FEATURE_DEFAULTS, job_control: false },
    })
  );

  try {
    const state = await getAdminJobControlState();

    assert.equal(state.jobControlEnabled, false);
    assert.equal(state.reason, "license_missing");
  } finally {
    clearLicenseOverride();
  }
});

test("admin job control helper disables controls for invalid licenses", async () => {
  setLicenseSummaryForTests(
    makeSummary({
      status: "invalid",
      mode: "read_only",
      verificationStatus: "invalid",
      verificationError: "license_signature_invalid",
      features: { ...LICENSE_FEATURE_DEFAULTS, job_control: false },
    })
  );

  try {
    const state = await getAdminJobControlState();

    assert.equal(state.jobControlEnabled, false);
    assert.equal(state.reason, "license_signature_invalid");
  } finally {
    clearLicenseOverride();
  }
});

test("admin job control helper disables controls when the active license omits job control", async () => {
  setLicenseSummaryForTests(
    makeSummary({
      features: { ...LICENSE_FEATURE_DEFAULTS, job_control: false },
    })
  );

  try {
    const state = await getAdminJobControlState();

    assert.equal(state.jobControlEnabled, false);
    assert.equal(state.reason, "license_feature_job_control_disabled");
  } finally {
    clearLicenseOverride();
  }
});

test("read-only status maps a scheduled enabled job to paused", () => {
  const status = deriveJobStatus({
    scheduleId: "schedule-1",
    scheduleEnabled: true,
    latestRunStatus: "success",
    readOnly: true,
  });

  assert.equal(status, "paused");
});

test("read-only status maps a scheduled running job to paused", () => {
  const status = deriveJobStatus({
    scheduleId: "schedule-1",
    scheduleEnabled: true,
    latestRunStatus: "running",
    readOnly: true,
  });

  assert.equal(status, "paused");
});

test("read-only status keeps unscheduled jobs as no_schedule", () => {
  const status = deriveJobStatus({
    scheduleId: null,
    scheduleEnabled: null,
    latestRunStatus: "running",
    readOnly: true,
  });

  assert.equal(status, "no_schedule");
});
