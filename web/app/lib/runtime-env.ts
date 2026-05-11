import fs from "node:fs";
import path from "node:path";

const KEY_VAULT_SCOPE = "https://vault.azure.net";
const KEY_VAULT_UNSET_VALUE = "__PRINCETON_SENTINEL_UNSET__";

type RuntimeManifest = {
  services?: Record<string, { required?: string[]; optional?: string[] }>;
};

type RuntimeKey = {
  name: string;
  required: boolean;
};

type TokenCache = {
  token: string;
  expiresAtMs: number;
};

let manifestCache: RuntimeManifest | null = null;
let keyCache: Map<string, RuntimeKey> | null = null;
let tokenCache: TokenCache | null = null;
let fetchOverride: typeof fetch | null = null;
let tokenProviderOverride: (() => Promise<string>) | null = null;

const lastKnownGood = new Map<string, string>();

function isTruthy(value: string | undefined) {
  if (!value) return false;
  return ["1", "true", "t", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

function isPresent(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function normalizeVaultUrl(value: string | undefined | null) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function manifestCandidates() {
  return [
    path.join(process.cwd(), "runtime-env-manifest.json"),
    path.join(process.cwd(), "..", "runtime-env-manifest.json"),
  ];
}

function loadManifest(): RuntimeManifest {
  if (manifestCache) return manifestCache;
  const candidate = manifestCandidates().find((filePath) => fs.existsSync(filePath));
  if (!candidate) {
    throw new Error("runtime-env-manifest.json was not found");
  }
  manifestCache = JSON.parse(fs.readFileSync(candidate, "utf8")) as RuntimeManifest;
  return manifestCache;
}

function getRuntimeKeys() {
  if (keyCache) return keyCache;
  const keys = new Map<string, RuntimeKey>();
  const manifest = loadManifest();
  for (const service of Object.values(manifest.services || {})) {
    const required = new Set(service.required || []);
    for (const name of [...(service.required || []), ...(service.optional || [])]) {
      const existing = keys.get(name);
      keys.set(name, { name, required: Boolean(existing?.required || required.has(name)) });
    }
  }
  keyCache = keys;
  return keys;
}

function envKeyToSecretName(key: string) {
  return key.replaceAll("_", "-");
}

function runtimeFetch() {
  return fetchOverride || fetch;
}

function parseExpiresAtMs(payload: Record<string, unknown>) {
  const now = Date.now();
  const expiresOn = payload.expires_on ?? payload.expiresOn;
  if (typeof expiresOn === "number") {
    return expiresOn > 10_000_000_000 ? expiresOn : expiresOn * 1000;
  }
  if (typeof expiresOn === "string" && expiresOn.trim()) {
    if (/^\d+$/.test(expiresOn.trim())) {
      const parsed = Number(expiresOn);
      return parsed > 10_000_000_000 ? parsed : parsed * 1000;
    }
    const parsed = Date.parse(expiresOn);
    if (Number.isFinite(parsed)) return parsed;
  }
  const expiresIn = payload.expires_in ?? payload.expiresIn;
  if (typeof expiresIn === "number") return now + expiresIn * 1000;
  if (typeof expiresIn === "string" && /^\d+$/.test(expiresIn)) return now + Number(expiresIn) * 1000;
  return now + 55 * 60 * 1000;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function acquireManagedIdentityToken(): Promise<string> {
  if (tokenProviderOverride) return tokenProviderOverride();

  const now = Date.now();
  if (tokenCache && now < tokenCache.expiresAtMs - 60_000) {
    return tokenCache.token;
  }

  const endpoint = process.env.IDENTITY_ENDPOINT;
  const identityHeader = process.env.IDENTITY_HEADER;
  const clientId = process.env.MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const fetchImpl = runtimeFetch();
  let response: Response;

  if (endpoint && identityHeader) {
    const url = new URL(endpoint);
    url.searchParams.set("api-version", "2019-08-01");
    url.searchParams.set("resource", KEY_VAULT_SCOPE);
    if (clientId) url.searchParams.set("client_id", clientId);
    response = await fetchImpl(url, {
      headers: {
        "X-IDENTITY-HEADER": identityHeader,
        Metadata: "true",
      },
    });
  } else {
    const url = new URL("http://169.254.169.254/metadata/identity/oauth2/token");
    url.searchParams.set("api-version", "2018-02-01");
    url.searchParams.set("resource", KEY_VAULT_SCOPE);
    if (clientId) url.searchParams.set("client_id", clientId);
    response = await fetchImpl(url, { headers: { Metadata: "true" } });
  }

  if (!response.ok) {
    throw new Error(`managed_identity_token_failed_${response.status}`);
  }
  const payload = await readJson(response);
  const token = typeof payload.access_token === "string" ? payload.access_token : "";
  if (!token) {
    throw new Error("managed_identity_token_missing_access_token");
  }
  tokenCache = { token, expiresAtMs: parseExpiresAtMs(payload) };
  return token;
}

async function fetchSecretFromKeyVault(vaultUrl: string, name: string): Promise<{ found: boolean; value?: string }> {
  const token = await acquireManagedIdentityToken();
  const url = `${vaultUrl}/secrets/${encodeURIComponent(envKeyToSecretName(name))}?api-version=7.4`;
  const response = await runtimeFetch()(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) {
    return { found: false };
  }
  if (!response.ok) {
    throw new Error(`key_vault_secret_lookup_failed_${name}_${response.status}`);
  }
  const payload = await readJson(response);
  if (!Object.prototype.hasOwnProperty.call(payload, "value")) {
    throw new Error(`key_vault_secret_lookup_missing_value_${name}`);
  }
  return { found: true, value: String(payload.value) };
}

export function isAzureKeyVaultRuntimeEnabled() {
  return Boolean(normalizeVaultUrl(process.env.AZ_KEY_VAULT_URL)) && !isTruthy(process.env.LOCAL_DOCKER_DEPLOYMENT);
}

export function isRuntimeManifestKey(name: string) {
  return getRuntimeKeys().has(name);
}

export async function getRuntimeEnv(name: string): Promise<string | undefined> {
  const existing = process.env[name];
  if (!isAzureKeyVaultRuntimeEnabled() || !isRuntimeManifestKey(name)) {
    return existing;
  }

  const vaultUrl = normalizeVaultUrl(process.env.AZ_KEY_VAULT_URL);
  try {
    const secret = await fetchSecretFromKeyVault(vaultUrl, name);
    if (!secret.found || secret.value === KEY_VAULT_UNSET_VALUE || !isPresent(secret.value)) {
      if (isPresent(existing)) {
        lastKnownGood.set(name, existing);
        return existing;
      }
      process.env[name] = "";
      lastKnownGood.delete(name);
      return undefined;
    }
    process.env[name] = secret.value;
    lastKnownGood.set(name, secret.value);
    return secret.value;
  } catch (error) {
    const stale = lastKnownGood.get(name) || (isPresent(existing) ? existing : undefined);
    if (stale) {
      lastKnownGood.set(name, stale);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Key Vault runtime config lookup failed for ${name}; using last-known-good value: ${message}`);
      return stale;
    }
    throw error;
  }
}

export async function requireRuntimeEnv(name: string): Promise<string> {
  const value = await getRuntimeEnv(name);
  if (!isPresent(value)) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export async function getRuntimeEnvSnapshot(names: string[]): Promise<Record<string, string | undefined>> {
  const entries = await Promise.all(names.map(async (name) => [name, await getRuntimeEnv(name)] as const));
  return Object.fromEntries(entries);
}

export function getPositiveIntRuntimeEnvValue(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export async function getPositiveIntRuntimeEnv(name: string, fallback: number): Promise<number> {
  return getPositiveIntRuntimeEnvValue(await getRuntimeEnv(name), fallback);
}

export function setRuntimeEnvFetchForTests(fetchImpl: typeof fetch | null) {
  fetchOverride = fetchImpl;
  tokenCache = null;
}

export function setRuntimeEnvTokenProviderForTests(provider: (() => Promise<string>) | null) {
  tokenProviderOverride = provider;
  tokenCache = null;
}

export function resetRuntimeEnvForTests() {
  manifestCache = null;
  keyCache = null;
  tokenCache = null;
  fetchOverride = null;
  tokenProviderOverride = null;
  lastKnownGood.clear();
}

export { KEY_VAULT_UNSET_VALUE };
