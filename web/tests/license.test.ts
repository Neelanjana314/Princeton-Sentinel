import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateKeyPairSync, createSign } from "node:crypto";

import {
  LICENSE_SCHEMA_VERSION,
  LICENSE_SIGNATURE_DELIMITER,
  canonicalizeLicensePayload,
  inspectLicenseArtifact,
  setLicensePublicKeyForTests,
  summarizeLicenseArtifactText,
} from "../app/lib/license";

const execFileAsync = promisify(execFile);

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: LICENSE_SCHEMA_VERSION,
    license_id: "license-123",
    license_type: "enterprise",
    tenant_id: "tenant-a",
    issued_at: "2026-03-23T12:00:00.000Z",
    expires_at: "2026-12-31T23:59:59.000Z",
    features: {
      dashboard_read: true,
      live_graph_read: true,
      admin_view: true,
      license_manage: true,
      permission_revoke: true,
      job_control: true,
      graph_ingest: true,
      copilot_telemetry: true,
      agents_dashboard: true,
    },
    ...overrides,
  };
}

function signArtifact(privateKeyPem: string, payload: Record<string, unknown>) {
  const canonicalPayload = canonicalizeLicensePayload(payload);
  const signer = createSign("RSA-SHA256");
  signer.update(canonicalPayload, "utf8");
  signer.end();
  const signature = signer.sign(privateKeyPem).toString("base64");
  return `${canonicalPayload}${LICENSE_SIGNATURE_DELIMITER}${signature}\n`;
}

test("inspectLicenseArtifact verifies a valid canonical artifact", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  setLicensePublicKeyForTests(publicKey);
  process.env.ENTRA_TENANT_ID = "tenant-a";

  const artifact = signArtifact(privateKey, makePayload());
  const inspection = await inspectLicenseArtifact(artifact);
  const summary = await summarizeLicenseArtifactText({ rawLicenseText: artifact });

  assert.equal(inspection.verificationStatus, "verified");
  assert.equal(summary.status, "active");
  assert.equal(summary.features.graph_ingest, true);

  setLicensePublicKeyForTests(null);
});

test("tampering with the raw artifact invalidates the signature", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  setLicensePublicKeyForTests(publicKey);
  process.env.ENTRA_TENANT_ID = "tenant-a";

  const artifact = signArtifact(privateKey, makePayload());
  const tampered = artifact.replace('"graph_ingest":true', '"graph_ingest":false');
  const inspection = await inspectLicenseArtifact(tampered);
  const summary = await summarizeLicenseArtifactText({ rawLicenseText: tampered });

  assert.equal(inspection.verificationStatus, "invalid");
  assert.equal(summary.status, "invalid");
  assert.equal(summary.features.graph_ingest, false);

  setLicensePublicKeyForTests(null);
});

test("tenant mismatch forces read-only invalid status even with a valid signature", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  setLicensePublicKeyForTests(publicKey);
  process.env.ENTRA_TENANT_ID = "tenant-b";

  const artifact = signArtifact(privateKey, makePayload({ tenant_id: "tenant-a" }));
  const summary = await summarizeLicenseArtifactText({ rawLicenseText: artifact });

  assert.equal(summary.status, "invalid");
  assert.equal(summary.mode, "read_only");
  assert.equal(summary.verificationError, "license_tenant_id_mismatch");

  setLicensePublicKeyForTests(null);
});

test("expired licenses become read-only", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  setLicensePublicKeyForTests(publicKey);
  process.env.ENTRA_TENANT_ID = "tenant-a";

  const artifact = signArtifact(
    privateKey,
    makePayload({
      expires_at: "2020-01-01T00:00:00.000Z",
      features: {
        dashboard_read: true,
        live_graph_read: true,
        admin_view: true,
        license_manage: true,
        permission_revoke: true,
        job_control: true,
        graph_ingest: true,
        copilot_telemetry: true,
        agents_dashboard: true,
      },
    })
  );
  const summary = await summarizeLicenseArtifactText({ rawLicenseText: artifact });

  assert.equal(summary.status, "expired");
  assert.equal(summary.features.graph_ingest, false);
  assert.equal(summary.features.job_control, false);

  setLicensePublicKeyForTests(null);
});

test("summary derives enforcement from the raw artifact, not display metadata", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  setLicensePublicKeyForTests(publicKey);
  process.env.ENTRA_TENANT_ID = "tenant-a";

  const artifact = signArtifact(privateKey, makePayload());
  const first = await summarizeLicenseArtifactText({
    rawLicenseText: artifact,
    artifactId: "artifact-1",
    uploadedBy: { name: "First" },
  });
  const second = await summarizeLicenseArtifactText({
    rawLicenseText: artifact,
    artifactId: "artifact-2",
    uploadedBy: { name: "Second" },
  });

  assert.equal(first.status, second.status);
  assert.deepEqual(first.features, second.features);

  setLicensePublicKeyForTests(null);
});

test("generator script output verifies end to end", async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "ps-license-"));
  const keyDir = path.join(tmpRoot, "keys");
  const outPath = path.join(tmpRoot, "generated.license");
  const privateKeyPath = path.join(keyDir, "private.pem");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  await mkdir(keyDir, { recursive: true });
  await writeFile(privateKeyPath, privateKey, "utf8");

  await execFileAsync("node", [
    path.resolve(process.cwd(), "..", "scripts/generate-license.mjs"),
    "--private-key",
    privateKeyPath,
    "--output",
    outPath,
    "--license-type",
    "enterprise",
    "--tenant-id",
    "tenant-a",
    "--expires-at",
    "2026-12-31T23:59:59Z",
    "--features",
    "graph_ingest=true,job_control=true,permission_revoke=true,agents_dashboard=true,copilot_telemetry=true",
  ]);

  setLicensePublicKeyForTests(publicKey);
  process.env.ENTRA_TENANT_ID = "tenant-a";

  const generated = await readFile(outPath, "utf8");
  const summary = await summarizeLicenseArtifactText({ rawLicenseText: generated });

  assert.equal(summary.status, "active");
  assert.equal(summary.features.job_control, true);
  assert.equal(summary.features.permission_revoke, true);

  setLicensePublicKeyForTests(null);
  await rm(tmpRoot, { recursive: true, force: true });
});
