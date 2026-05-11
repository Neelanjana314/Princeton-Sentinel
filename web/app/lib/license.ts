import { createHash, createVerify } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";

import { getLocalTestingState } from "./local-testing-state";
import { isLocalDockerDeployment } from "./runtime";

export const LICENSE_SCHEMA_VERSION = 1;
export const LICENSE_SIGNATURE_DELIMITER = "\n---SIGNATURE---\n";

export const LICENSE_FEATURE_DEFAULTS = {
  dashboard_read: true,
  live_graph_read: true,
  admin_view: true,
  license_manage: true,
  permission_revoke: false,
  job_control: false,
  graph_ingest: false,
  copilot_telemetry: false,
  agents_dashboard: true,
  copilot_usage_sync: false,
  copilot_dashboard: true,
} as const;

export type LicenseFeatureKey = keyof typeof LICENSE_FEATURE_DEFAULTS;
export type LicenseFeatures = Record<LicenseFeatureKey, boolean>;

export type LicensePayload = {
  schema_version: number;
  license_id: string;
  license_type: string;
  tenant_id: string;
  issued_at: string;
  expires_at: string | null;
  features: LicenseFeatures;
};

export type LicenseStatus = "active" | "expired" | "invalid" | "missing";
export type LicenseMode = "full" | "read_only";
export type LicenseVerificationStatus = "verified" | "invalid" | "missing";

export type EffectiveLicenseSummary = {
  status: LicenseStatus;
  mode: LicenseMode;
  verificationStatus: LicenseVerificationStatus;
  verificationError: string | null;
  artifactId: string | null;
  sha256: string | null;
  uploadedAt: string | null;
  uploadedBy: {
    oid: string | null;
    upn: string | null;
    name: string | null;
  };
  payload: LicensePayload | null;
  features: LicenseFeatures;
};

type LicenseArtifactRow = {
  artifact_id: string;
  raw_license_text: string;
  sha256: string;
  uploaded_by_oid: string | null;
  uploaded_by_upn: string | null;
  uploaded_by_name: string | null;
  uploaded_at: string | Date | null;
  verification_status: string;
  verification_error: string | null;
};

type ActiveLicenseMetaRow = {
  artifact_id: string | null;
  updated_at: string | Date | null;
  sha256: string | null;
};

type UploadedArtifactActor = {
  oid?: string | null;
  upn?: string | null;
  name?: string | null;
};

type LicenseInspection = {
  verificationStatus: LicenseVerificationStatus;
  verificationError: string | null;
  payload: LicensePayload | null;
  sha256: string;
};

type SummaryMetadata = {
  artifactId: string | null;
  uploadedAt: string | Date | null;
  uploadedBy: {
    oid: string | null;
    upn: string | null;
    name: string | null;
  };
  sha256: string;
};

type SummaryOverride = EffectiveLicenseSummary | (() => Promise<EffectiveLicenseSummary>);
type LicenseQueryFn = <T = any>(text: string, params?: any[]) => Promise<T[]>;

export class LicenseFeatureError extends Error {
  featureKey: LicenseFeatureKey;
  summary: EffectiveLicenseSummary;

  constructor(featureKey: LicenseFeatureKey, summary: EffectiveLicenseSummary) {
    super(`license_feature_${featureKey}_disabled`);
    this.featureKey = featureKey;
    this.summary = summary;
  }
}

let summaryOverride: SummaryOverride | null = null;
let publicKeyOverride: string | null = null;
let licenseQueryOverride: LicenseQueryFn | null = null;
let cachedSummary:
  | {
      cacheKey: string;
      expiresAtMs: number;
      summary: EffectiveLicenseSummary;
    }
  | null = null;
let cachedPublicKey:
  | {
      path: string;
      value: string;
    }
  | null = null;

async function runLicenseQuery<T = any>(text: string, params?: any[]): Promise<T[]> {
  if (licenseQueryOverride) {
    return licenseQueryOverride<T>(text, params);
  }

  const db = await import("./db");
  return db.query<T>(text, params);
}

async function runLicenseTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const db = await import("./db");
  return db.withTransaction(fn);
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function normalizeTimestamp(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return parsed.toISOString();
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortJsonValue(entry)]));
  }
  return value;
}

export function canonicalizeLicensePayload(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function getLicenseCacheTtlMs() {
  const raw = Number(process.env.LICENSE_CACHE_TTL_SECONDS || "300");
  if (!Number.isFinite(raw) || raw <= 0) {
    return 300_000;
  }
  return Math.floor(raw * 1000);
}

function getDefaultLicenseFeatures(): LicenseFeatures {
  return { ...LICENSE_FEATURE_DEFAULTS };
}

function getDisabledLicenseFeatures(): LicenseFeatures {
  return Object.fromEntries(
    (Object.keys(LICENSE_FEATURE_DEFAULTS) as LicenseFeatureKey[]).map((key) => [key, false])
  ) as LicenseFeatures;
}

function getFullyEnabledLicenseFeatures(): LicenseFeatures {
  return Object.fromEntries(
    (Object.keys(LICENSE_FEATURE_DEFAULTS) as LicenseFeatureKey[]).map((key) => [key, true])
  ) as LicenseFeatures;
}

function getReadOnlyFallbackSummary(error: string | null, overrides?: Partial<EffectiveLicenseSummary>): EffectiveLicenseSummary {
  return {
    status: overrides?.status ?? "invalid",
    mode: "read_only",
    verificationStatus: overrides?.verificationStatus ?? (overrides?.status === "missing" ? "missing" : "invalid"),
    verificationError: error,
    artifactId: overrides?.artifactId ?? null,
    sha256: overrides?.sha256 ?? null,
    uploadedAt: overrides?.uploadedAt ?? null,
    uploadedBy: overrides?.uploadedBy ?? { oid: null, upn: null, name: null },
    payload: overrides?.payload ?? null,
    features: overrides?.features ?? getDefaultLicenseFeatures(),
  };
}

function getLocalDockerLicenseSummary(): EffectiveLicenseSummary {
  const tenantId = asNonEmptyString(process.env.ENTRA_TENANT_ID) || "local-docker";
  const features = getFullyEnabledLicenseFeatures();

  return {
    status: "active",
    mode: "full",
    verificationStatus: "verified",
    verificationError: null,
    artifactId: null,
    sha256: null,
    uploadedAt: null,
    uploadedBy: { oid: null, upn: null, name: null },
    payload: {
      schema_version: LICENSE_SCHEMA_VERSION,
      license_id: "local-docker-emulated-license",
      license_type: "local_docker",
      tenant_id: tenantId,
      issued_at: "1970-01-01T00:00:00.000Z",
      expires_at: null,
      features,
    },
    features,
  };
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function parseIsoTimestamp(value: unknown, fieldName: string, allowNull = false): string | null {
  if (value === null && allowNull) {
    return null;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName}_required`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName}_invalid`);
  }
  return parsed.toISOString();
}

function deriveLicenseFeatures(value: unknown): LicenseFeatures {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("license_features_invalid");
  }
  const merged = getDisabledLicenseFeatures();
  for (const key of Object.keys(LICENSE_FEATURE_DEFAULTS) as LicenseFeatureKey[]) {
    const raw = (value as Record<string, unknown>)[key];
    if (raw === undefined) {
      continue;
    }
    if (typeof raw !== "boolean") {
      throw new Error(`license_feature_${key}_invalid`);
    }
    merged[key] = raw;
  }
  return merged;
}

function parseLicensePayloadObject(value: unknown): LicensePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("license_payload_invalid");
  }

  const payload = value as Record<string, unknown>;
  const schemaVersion = payload.schema_version;
  if (schemaVersion !== LICENSE_SCHEMA_VERSION) {
    throw new Error("license_schema_version_invalid");
  }

  const licenseId = asNonEmptyString(payload.license_id);
  if (!licenseId) {
    throw new Error("license_id_required");
  }
  const licenseType = asNonEmptyString(payload.license_type);
  if (!licenseType) {
    throw new Error("license_type_required");
  }
  const tenantId = asNonEmptyString(payload.tenant_id);
  if (!tenantId) {
    throw new Error("license_tenant_id_required");
  }

  return {
    schema_version: LICENSE_SCHEMA_VERSION,
    license_id: licenseId,
    license_type: licenseType,
    tenant_id: tenantId,
    issued_at: parseIsoTimestamp(payload.issued_at, "license_issued_at")!,
    expires_at: parseIsoTimestamp(payload.expires_at, "license_expires_at", true),
    features: deriveLicenseFeatures(payload.features),
  };
}

async function loadLicensePublicKey(): Promise<string> {
  if (publicKeyOverride !== null) {
    return publicKeyOverride;
  }

  const publicKeyPath = asNonEmptyString(process.env.LICENSE_PUBLIC_KEY_PATH);
  if (!publicKeyPath) {
    throw new Error("license_public_key_path_not_configured");
  }

  if (cachedPublicKey?.path === publicKeyPath) {
    return cachedPublicKey.value;
  }

  const publicKey = await readFile(publicKeyPath, "utf-8");
  cachedPublicKey = { path: publicKeyPath, value: publicKey };
  return publicKey;
}

export async function inspectLicenseArtifact(rawLicenseText: string): Promise<LicenseInspection> {
  const sha256 = createHash("sha256").update(rawLicenseText, "utf8").digest("hex");
  const normalized = normalizeNewlines(rawLicenseText);

  try {
    const delimiterIndex = normalized.indexOf(LICENSE_SIGNATURE_DELIMITER);
    if (delimiterIndex < 0) {
      throw new Error("license_signature_delimiter_missing");
    }
    if (normalized.indexOf(LICENSE_SIGNATURE_DELIMITER, delimiterIndex + LICENSE_SIGNATURE_DELIMITER.length) >= 0) {
      throw new Error("license_signature_delimiter_duplicated");
    }

    const payloadText = normalized.slice(0, delimiterIndex);
    const signatureText = normalized.slice(delimiterIndex + LICENSE_SIGNATURE_DELIMITER.length).trim();
    if (!signatureText) {
      throw new Error("license_signature_missing");
    }
    if (/\s/.test(signatureText)) {
      throw new Error("license_signature_invalid");
    }

    const rawPayload = JSON.parse(payloadText);
    const parsedPayload = parseLicensePayloadObject(rawPayload);
    const canonicalPayload = canonicalizeLicensePayload(rawPayload);
    if (payloadText !== canonicalPayload) {
      throw new Error("license_payload_not_canonical");
    }

    const publicKey = await loadLicensePublicKey();
    const verifier = createVerify("RSA-SHA256");
    verifier.update(canonicalPayload, "utf8");
    verifier.end();

    const validSignature = verifier.verify(publicKey, Buffer.from(signatureText, "base64"));
    if (!validSignature) {
      throw new Error("license_signature_invalid");
    }

    return {
      verificationStatus: "verified",
      verificationError: null,
      payload: parsedPayload,
      sha256,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "license_verification_failed";
    return {
      verificationStatus: "invalid",
      verificationError: message,
      payload: null,
      sha256,
    };
  }
}

function summarizeInspection(inspection: LicenseInspection, metadata: SummaryMetadata): EffectiveLicenseSummary {
  if (inspection.verificationStatus !== "verified" || !inspection.payload) {
    return getReadOnlyFallbackSummary(inspection.verificationError, {
      artifactId: metadata.artifactId,
      sha256: metadata.sha256,
      uploadedAt: normalizeTimestamp(metadata.uploadedAt),
      uploadedBy: metadata.uploadedBy,
    });
  }

  const tenantId = asNonEmptyString(process.env.ENTRA_TENANT_ID);
  if (!tenantId) {
    return getReadOnlyFallbackSummary("entra_tenant_id_not_configured", {
      artifactId: metadata.artifactId,
      sha256: metadata.sha256,
      uploadedAt: normalizeTimestamp(metadata.uploadedAt),
      uploadedBy: metadata.uploadedBy,
      payload: inspection.payload,
    });
  }

  if (inspection.payload.tenant_id !== tenantId) {
    return getReadOnlyFallbackSummary("license_tenant_id_mismatch", {
      artifactId: metadata.artifactId,
      sha256: metadata.sha256,
      uploadedAt: normalizeTimestamp(metadata.uploadedAt),
      uploadedBy: metadata.uploadedBy,
      payload: inspection.payload,
    });
  }

  const expired = inspection.payload.expires_at !== null && new Date(inspection.payload.expires_at).getTime() < Date.now();

  return {
    status: expired ? "expired" : "active",
    mode: expired ? "read_only" : "full",
    verificationStatus: "verified",
    verificationError: expired ? "license_expired" : null,
    artifactId: metadata.artifactId,
    sha256: metadata.sha256,
    uploadedAt: normalizeTimestamp(metadata.uploadedAt),
    uploadedBy: metadata.uploadedBy,
    payload: inspection.payload,
    features: expired ? getDefaultLicenseFeatures() : inspection.payload.features,
  };
}

export async function summarizeLicenseArtifactText(params: {
  rawLicenseText: string;
  artifactId?: string | null;
  uploadedAt?: string | Date | null;
  uploadedBy?: {
    oid?: string | null;
    upn?: string | null;
    name?: string | null;
  } | null;
}): Promise<EffectiveLicenseSummary> {
  const inspection = await inspectLicenseArtifact(params.rawLicenseText);
  return summarizeInspection(inspection, {
    artifactId: params.artifactId ?? null,
    uploadedAt: params.uploadedAt ?? null,
    uploadedBy: {
      oid: params.uploadedBy?.oid ?? null,
      upn: params.uploadedBy?.upn ?? null,
      name: params.uploadedBy?.name ?? null,
    },
    sha256: inspection.sha256,
  });
}

function summarizeArtifactRow(row: LicenseArtifactRow): Promise<EffectiveLicenseSummary> {
  return inspectLicenseArtifact(row.raw_license_text).then((inspection) =>
    summarizeInspection(inspection, {
      artifactId: row.artifact_id,
      sha256: inspection.sha256,
      uploadedAt: row.uploaded_at,
      uploadedBy: {
        oid: row.uploaded_by_oid,
        upn: row.uploaded_by_upn,
        name: row.uploaded_by_name,
      },
    })
  );
}

async function getActiveLicenseMeta(): Promise<ActiveLicenseMetaRow | null> {
  const rows = await runLicenseQuery<ActiveLicenseMetaRow>(
    `
    SELECT ala.artifact_id, ala.updated_at, la.sha256
    FROM active_license_artifact ala
    LEFT JOIN license_artifacts la ON la.artifact_id = ala.artifact_id
    WHERE ala.slot = 'default'
    LIMIT 1
    `
  );
  return rows[0] ?? null;
}

async function getActiveArtifactRow(artifactId: string): Promise<LicenseArtifactRow | null> {
  const rows = await runLicenseQuery<LicenseArtifactRow>(
    `
    SELECT artifact_id,
           raw_license_text,
           sha256,
           uploaded_by_oid,
           uploaded_by_upn,
           uploaded_by_name,
           uploaded_at,
           verification_status,
           verification_error
    FROM license_artifacts
    WHERE artifact_id = $1
    LIMIT 1
    `,
    [artifactId]
  );
  return rows[0] ?? null;
}

export function clearLicenseCache() {
  cachedSummary = null;
}

export function setLicenseSummaryForTests(override: SummaryOverride | null) {
  summaryOverride = override;
  clearLicenseCache();
}

export function setLicenseQueryForTests(queryFn: LicenseQueryFn | null) {
  licenseQueryOverride = queryFn;
  clearLicenseCache();
}

export function setLicensePublicKeyForTests(value: string | null) {
  publicKeyOverride = value;
  cachedPublicKey = null;
  clearLicenseCache();
}

export async function getCurrentLicenseSummary(): Promise<EffectiveLicenseSummary> {
  if (summaryOverride) {
    return typeof summaryOverride === "function" ? summaryOverride() : summaryOverride;
  }

  const localTestingState = isLocalDockerDeployment() ? await getLocalTestingState() : null;
  const meta = localTestingState ? null : await getActiveLicenseMeta();
  const cacheKey = localTestingState
    ? `local:${localTestingState.emulateLicenseEnabled ? "enabled" : "disabled"}:${localTestingState.updatedAt || "none"}`
    : `${meta?.artifact_id || "missing"}:${meta?.sha256 || "none"}:${normalizeTimestamp(meta?.updated_at) || "none"}`;
  const ttlMs = getLicenseCacheTtlMs();

  if (cachedSummary && cachedSummary.cacheKey === cacheKey && cachedSummary.expiresAtMs > Date.now()) {
    return cachedSummary.summary;
  }

  let summary: EffectiveLicenseSummary;

  if (localTestingState) {
    summary = localTestingState.emulateLicenseEnabled
      ? getLocalDockerLicenseSummary()
      : getReadOnlyFallbackSummary("license_missing", { status: "missing", verificationStatus: "missing" });
  } else if (!meta?.artifact_id) {
    summary = getReadOnlyFallbackSummary("license_missing", { status: "missing", verificationStatus: "missing" });
  } else {
    const row = await getActiveArtifactRow(meta.artifact_id);
    if (!row) {
      summary = getReadOnlyFallbackSummary("active_license_artifact_missing_row", {
        artifactId: meta.artifact_id,
        sha256: meta.sha256,
      });
    } else {
      summary = await summarizeArtifactRow(row);
    }
  }

  cachedSummary = {
    cacheKey,
    expiresAtMs: Date.now() + ttlMs,
    summary,
  };

  return summary;
}

export async function isLicenseFeatureEnabled(featureKey: LicenseFeatureKey): Promise<boolean> {
  const summary = await getCurrentLicenseSummary();
  return Boolean(summary.features[featureKey]);
}

export async function requireLicenseFeature(featureKey: LicenseFeatureKey): Promise<EffectiveLicenseSummary> {
  const summary = await getCurrentLicenseSummary();
  if (summary.features[featureKey]) {
    return summary;
  }
  throw new LicenseFeatureError(featureKey, summary);
}

export async function insertLicenseArtifact(params: {
  rawLicenseText: string;
  actor: UploadedArtifactActor | null;
}): Promise<{
  artifactId: string;
  inspection: LicenseInspection;
}> {
  const inspection = await inspectLicenseArtifact(params.rawLicenseText);
  const actor = params.actor;
  let artifactId = "";

  await runLicenseTransaction(async (client: PoolClient) => {
    const inserted = await client.query<{ artifact_id: string }>(
      `
      INSERT INTO license_artifacts (
        raw_license_text,
        sha256,
        uploaded_by_oid,
        uploaded_by_upn,
        uploaded_by_name,
        verification_status,
        verification_error
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING artifact_id
      `,
      [
        params.rawLicenseText,
        inspection.sha256,
        actor?.oid || null,
        actor?.upn || null,
        actor?.name || null,
        inspection.verificationStatus,
        inspection.verificationError,
      ]
    );
    artifactId = inserted.rows[0]?.artifact_id || "";
  });

  clearLicenseCache();

  return { artifactId, inspection };
}

export async function activateLicenseArtifact(artifactId: string): Promise<void> {
  await runLicenseTransaction(async (client: PoolClient) => {
    await client.query(
      `
      INSERT INTO active_license_artifact (slot, artifact_id, updated_at)
      VALUES ('default', $1, now())
      ON CONFLICT (slot)
      DO UPDATE SET artifact_id = EXCLUDED.artifact_id, updated_at = now()
      `,
      [artifactId]
    );
  });

  clearLicenseCache();
}

export async function clearActiveLicenseArtifact(): Promise<void> {
  await runLicenseTransaction(async (client: PoolClient) => {
    await client.query(
      `
      DELETE FROM active_license_artifact
      WHERE slot = 'default'
      `
    );
  });

  clearLicenseCache();
}
