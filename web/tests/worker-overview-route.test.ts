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

const { GET } = require("../app/api/worker/overview/route") as typeof import("../app/api/worker/overview/route");
const { setRequireAdminForTests } = require("../app/lib/auth") as typeof import("../app/lib/auth");
const {
  CACHE_CONTROL_HEADER,
  PRAGMA_HEADER,
} = require("../app/lib/security-headers") as typeof import("../app/lib/security-headers");
const { LICENSE_FEATURE_DEFAULTS, setLicenseSummaryForTests } = require("../app/lib/license") as typeof import("../app/lib/license");
const { setCallWorkerForTests } = require("../app/lib/worker-api") as typeof import("../app/lib/worker-api");

function clearOverrides() {
  setRequireAdminForTests(null);
  setCallWorkerForTests(null);
  setLicenseSummaryForTests(null);
}

test("worker overview route returns admin job control payload when job control is disabled", async () => {
  setRequireAdminForTests(async () => ({
    session: { user: { name: "Admin User" } },
    groups: ["admin-group"],
  }));
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
    features: { ...LICENSE_FEATURE_DEFAULTS, job_control: false },
  });
  setCallWorkerForTests(async (path) => {
    if (path === "/health") {
      return {
        res: new Response(JSON.stringify({ ok: true, db: true }), { status: 200 }),
        text: JSON.stringify({ ok: true, db: true }),
      };
    }
    if (path === "/jobs/status") {
      return {
        res: new Response(JSON.stringify({ jobs: [] }), { status: 200 }),
        text: JSON.stringify({ jobs: [] }),
      };
    }
    throw new Error(`Unexpected path: ${path}`);
  });

  try {
    const res = await GET();
    const payload = await res.json();

    assert.equal(res.status, 200);
    assert.equal(res.headers.get(CACHE_CONTROL_HEADER), "no-store, no-cache, must-revalidate");
    assert.equal(res.headers.get(PRAGMA_HEADER), "no-cache");
    assert.deepEqual(payload.adminJobControl, {
      jobControlEnabled: false,
      reason: "license_feature_job_control_disabled",
      message: "This license does not include job control. Admin job controls are read-only.",
    });
  } finally {
    clearOverrides();
  }
});
