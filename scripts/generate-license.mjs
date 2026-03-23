#!/usr/bin/env node

import { randomUUID, createPrivateKey, createSign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const LICENSE_SCHEMA_VERSION = 1;
const LICENSE_SIGNATURE_DELIMITER = "\n---SIGNATURE---\n";
const FEATURE_DEFAULTS = {
  dashboard_read: true,
  live_graph_read: true,
  admin_view: true,
  license_manage: true,
  permission_revoke: false,
  job_control: false,
  graph_ingest: false,
  copilot_telemetry: false,
  agents_dashboard: true,
};
const PRESETS = {
  trial: {
    job_control: true,
    graph_ingest: true,
    agents_dashboard: true,
  },
  standard: {
    job_control: true,
    graph_ingest: true,
    permission_revoke: true,
    agents_dashboard: true,
  },
  enterprise: {
    job_control: true,
    graph_ingest: true,
    permission_revoke: true,
    copilot_telemetry: true,
    agents_dashboard: true,
  },
};

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function usage() {
  console.error(`Usage:
  node scripts/generate-license.mjs --license-type TYPE --tenant-id TENANT --expires-at ISO8601 [options]

Required:
  --license-type TYPE
  --tenant-id TENANT
  --expires-at ISO8601 | --no-expiry

Options:
  --private-key PATH     Default: .local/license-keys/private.pem
  --output PATH          Default: .local/licenses/<license-id>.license
  --license-id UUID      Default: random UUID
  --issued-at ISO8601    Default: now
  --preset NAME          One of: ${Object.keys(PRESETS).join(", ")}
  --feature key=true     Repeatable
  --features a=true,b=false
`);
}

function parseArgs(argv) {
  const result = { featureEntries: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (key === "no-expiry") {
      result.noExpiry = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    index += 1;
    if (key === "feature") {
      result.featureEntries.push(next);
      continue;
    }
    result[key] = next;
  }
  return result;
}

function parseBooleanEntry(value) {
  const [rawKey, rawBool] = value.split("=");
  const key = rawKey?.trim();
  const boolText = rawBool?.trim();
  if (!key || !boolText || !(key in FEATURE_DEFAULTS)) {
    throw new Error(`Invalid feature entry: ${value}`);
  }
  if (boolText !== "true" && boolText !== "false") {
    throw new Error(`Feature value must be true/false: ${value}`);
  }
  return [key, boolText === "true"];
}

function buildFeatures(args) {
  const features = { ...FEATURE_DEFAULTS };
  if (args.preset) {
    const preset = PRESETS[args.preset];
    if (!preset) {
      throw new Error(`Unknown preset: ${args.preset}`);
    }
    Object.assign(features, preset);
  }
  for (const entry of args.featureEntries) {
    const [key, enabled] = parseBooleanEntry(entry);
    features[key] = enabled;
  }
  if (args.features) {
    for (const part of String(args.features).split(",")) {
      if (!part.trim()) continue;
      const [key, enabled] = parseBooleanEntry(part.trim());
      features[key] = enabled;
    }
  }
  return features;
}

function parseIso(value, fieldName) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName} must be a valid ISO-8601 timestamp`);
  }
  return parsed.toISOString();
}

function defaultOutputPath(licenseId) {
  return path.resolve(".local/licenses", `${licenseId}.license`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const privateKeyPath = path.resolve(args["private-key"] || ".local/license-keys/private.pem");
  const licenseType = String(args["license-type"] || "").trim();
  const tenantId = String(args["tenant-id"] || "").trim();
  const expiresAt = args.noExpiry ? null : parseIso(args["expires-at"], "expires-at");
  const issuedAt = args["issued-at"] ? parseIso(args["issued-at"], "issued-at") : new Date().toISOString();
  const licenseId = String(args["license-id"] || randomUUID());

  if (!licenseType) {
    throw new Error("license-type is required");
  }
  if (!tenantId) {
    throw new Error("tenant-id is required");
  }
  if (!args.noExpiry && !args["expires-at"]) {
    throw new Error("Either --expires-at or --no-expiry is required");
  }

  const payload = {
    schema_version: LICENSE_SCHEMA_VERSION,
    license_id: licenseId,
    license_type: licenseType,
    tenant_id: tenantId,
    issued_at: issuedAt,
    expires_at: expiresAt,
    features: buildFeatures(args),
  };

  const canonicalPayload = canonicalJson(payload);
  const privateKeyPem = await readFile(privateKeyPath, "utf8");
  const signer = createSign("RSA-SHA256");
  signer.update(canonicalPayload, "utf8");
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKeyPem)).toString("base64");

  const outputPath = path.resolve(args.output || defaultOutputPath(licenseId));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${canonicalPayload}${LICENSE_SIGNATURE_DELIMITER}${signature}\n`, "utf8");

  console.log(outputPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
