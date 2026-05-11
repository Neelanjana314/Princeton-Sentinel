const fs = require("node:fs");
const path = require("node:path");

const KEY_VAULT_SCOPE = "https://vault.azure.net";
const DEFAULT_MANIFEST_PATH = path.join(process.cwd(), "runtime-env-manifest.json");
const KEY_VAULT_UNSET_VALUE = "__PRINCETON_SENTINEL_UNSET__";

function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function isPresent(value) {
  return typeof value === "string" && value.trim() !== "";
}

function envKeyToSecretName(key) {
  return key.replaceAll("_", "-");
}

function normalizeVaultUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\/+$/, "");
}

function collectServiceKeys(manifest, service) {
  const serviceManifest = manifest && manifest.services && manifest.services[service];
  if (!serviceManifest) {
    throw new Error(`Missing runtime env manifest service: ${service}`);
  }
  const required = new Set(serviceManifest.required || []);
  const names = [...(serviceManifest.required || []), ...(serviceManifest.optional || [])];
  return [...new Set(names)].map((name) => ({ name, required: required.has(name) }));
}

async function getJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function acquireManagedIdentityToken({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const endpoint = env.IDENTITY_ENDPOINT;
  const identityHeader = env.IDENTITY_HEADER;
  const clientId = env.MANAGED_IDENTITY_CLIENT_ID || env.AZURE_CLIENT_ID;

  if (endpoint && identityHeader) {
    const url = new URL(endpoint);
    url.searchParams.set("api-version", "2019-08-01");
    url.searchParams.set("resource", KEY_VAULT_SCOPE);
    if (clientId) {
      url.searchParams.set("client_id", clientId);
    }
    const response = await fetchImpl(url, {
      headers: {
        "X-IDENTITY-HEADER": identityHeader,
        Metadata: "true",
      },
    });
    if (!response.ok) {
      throw new Error(`Managed identity token request failed: status ${response.status}`);
    }
    const payload = await getJson(response);
    if (!payload.access_token) {
      throw new Error("Managed identity token response did not include access_token");
    }
    return payload.access_token;
  }

  const url = new URL("http://169.254.169.254/metadata/identity/oauth2/token");
  url.searchParams.set("api-version", "2018-02-01");
  url.searchParams.set("resource", KEY_VAULT_SCOPE);
  if (clientId) {
    url.searchParams.set("client_id", clientId);
  }
  const response = await fetchImpl(url, { headers: { Metadata: "true" } });
  if (!response.ok) {
    throw new Error(`IMDS token request failed: status ${response.status}`);
  }
  const payload = await getJson(response);
  if (!payload.access_token) {
    throw new Error("IMDS token response did not include access_token");
  }
  return payload.access_token;
}

async function fetchSecret({ vaultUrl, token, key, fetchImpl = globalThis.fetch }) {
  const secretName = envKeyToSecretName(key);
  const url = `${vaultUrl}/secrets/${encodeURIComponent(secretName)}?api-version=7.4`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) {
    return { found: false };
  }
  if (!response.ok) {
    throw new Error(`Key Vault secret lookup failed for ${key}: status ${response.status}`);
  }
  const payload = await getJson(response);
  if (!Object.prototype.hasOwnProperty.call(payload, "value")) {
    throw new Error(`Key Vault secret lookup failed for ${key}: missing value`);
  }
  return { found: true, value: String(payload.value) };
}

async function hydrateEnvFromKeyVault({
  service,
  env = process.env,
  fetchImpl = globalThis.fetch,
  manifest,
  manifestPath,
  tokenProvider,
  vaultUrl = env.AZ_KEY_VAULT_URL,
} = {}) {
  if (!service) {
    throw new Error("service is required");
  }
  const normalizedVaultUrl = normalizeVaultUrl(vaultUrl);
  if (!normalizedVaultUrl) {
    return { vaultConfigured: false, hydrated: [], missing: [] };
  }

  const runtimeManifest = manifest || loadManifest(manifestPath);
  const keys = collectServiceKeys(runtimeManifest, service);
  const token = tokenProvider
    ? await tokenProvider()
    : await acquireManagedIdentityToken({ env, fetchImpl });
  const hydrated = [];

  for (const { name, required } of keys) {
    if (isPresent(env[name])) {
      continue;
    }
    const secret = await fetchSecret({
      vaultUrl: normalizedVaultUrl,
      token,
      key: name,
      fetchImpl,
    });
    if (!secret.found) {
      if (required) {
        continue;
      }
      continue;
    }
    if (secret.value === KEY_VAULT_UNSET_VALUE) {
      continue;
    }
    if (isPresent(secret.value)) {
      env[name] = secret.value;
      hydrated.push(name);
    }
  }

  const missing = keys.filter(({ name, required }) => required && !isPresent(env[name])).map(({ name }) => name);
  if (missing.length > 0) {
    throw new Error(`Missing required runtime configuration after Key Vault hydration: ${missing.join(", ")}`);
  }

  return { vaultConfigured: true, hydrated, missing };
}

module.exports = {
  acquireManagedIdentityToken,
  collectServiceKeys,
  envKeyToSecretName,
  hydrateEnvFromKeyVault,
  KEY_VAULT_UNSET_VALUE,
  loadManifest,
  normalizeVaultUrl,
};
