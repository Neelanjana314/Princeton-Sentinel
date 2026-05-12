const KEY_VAULT_SCOPE = "https://vault.azure.net";
const KEY_VAULT_UNSET_VALUE = "__PRINCETON_SENTINEL_UNSET__";

let proxyTokenCache: { token: string; expiresAtMs: number } | null = null;
const proxyLastKnownGood = new Map<string, string>();
let proxyFetchOverride: typeof fetch | null = null;
let proxyTokenProviderOverride: (() => Promise<string>) | null = null;

function isTruthy(value: string | undefined) {
  return Boolean(value && ["1", "true", "t", "yes", "y", "on"].includes(value.trim().toLowerCase()));
}

function isPresent(value: string | undefined) {
  return Boolean(value?.trim());
}

export function isProxyKeyVaultEnabled() {
  return (
    Boolean(process.env.AZ_KEY_VAULT_URL?.trim()) &&
    !isTruthy(process.env.LOCAL_DOCKER_DEPLOYMENT) &&
    !isTruthy(process.env.PRINCETON_SENTINEL_DISABLE_KEY_VAULT_RUNTIME)
  );
}

function runtimeFetch() {
  return proxyFetchOverride || fetch;
}

function parseProxyTokenExpiresAt(payload: Record<string, any>) {
  const expiresOn = payload.expires_on ?? payload.expiresOn;
  if (typeof expiresOn === "number") return expiresOn > 10_000_000_000 ? expiresOn : expiresOn * 1000;
  if (typeof expiresOn === "string" && /^\d+$/.test(expiresOn)) {
    const parsed = Number(expiresOn);
    return parsed > 10_000_000_000 ? parsed : parsed * 1000;
  }
  const expiresIn = payload.expires_in ?? payload.expiresIn;
  if (typeof expiresIn === "number") return Date.now() + expiresIn * 1000;
  if (typeof expiresIn === "string" && /^\d+$/.test(expiresIn)) return Date.now() + Number(expiresIn) * 1000;
  return Date.now() + 55 * 60 * 1000;
}

async function acquireProxyManagedIdentityToken() {
  if (proxyTokenProviderOverride) return proxyTokenProviderOverride();
  if (proxyTokenCache && Date.now() < proxyTokenCache.expiresAtMs - 60_000) {
    return proxyTokenCache.token;
  }
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const identityHeader = process.env.IDENTITY_HEADER;
  const clientId = process.env.MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  let response: Response;
  if (endpoint && identityHeader) {
    const url = new URL(endpoint);
    url.searchParams.set("api-version", "2019-08-01");
    url.searchParams.set("resource", KEY_VAULT_SCOPE);
    if (clientId) url.searchParams.set("client_id", clientId);
    response = await runtimeFetch()(url, { headers: { "X-IDENTITY-HEADER": identityHeader, Metadata: "true" } });
  } else {
    const url = new URL("http://169.254.169.254/metadata/identity/oauth2/token");
    url.searchParams.set("api-version", "2018-02-01");
    url.searchParams.set("resource", KEY_VAULT_SCOPE);
    if (clientId) url.searchParams.set("client_id", clientId);
    response = await runtimeFetch()(url, { headers: { Metadata: "true" } });
  }
  if (!response.ok) throw new Error(`managed_identity_token_failed_${response.status}`);
  const payload = await response.json().catch(() => ({}));
  if (!payload.access_token) throw new Error("managed_identity_token_missing_access_token");
  proxyTokenCache = { token: payload.access_token, expiresAtMs: parseProxyTokenExpiresAt(payload) };
  return proxyTokenCache.token;
}

function fallbackProxyRuntimeEnv(name: string, existing: string | undefined) {
  if (isPresent(existing)) {
    proxyLastKnownGood.set(name, existing as string);
    return existing;
  }
  proxyLastKnownGood.delete(name);
  return undefined;
}

export async function getProxyRuntimeEnv(name: string) {
  const existing = process.env[name];
  if (!isProxyKeyVaultEnabled()) {
    return existing;
  }
  try {
    const vaultUrl = String(process.env.AZ_KEY_VAULT_URL || "").trim().replace(/\/+$/, "");
    const secretName = name.replaceAll("_", "-");
    const token = await acquireProxyManagedIdentityToken();
    const response = await runtimeFetch()(`${vaultUrl}/secrets/${encodeURIComponent(secretName)}?api-version=7.4`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404) {
      return fallbackProxyRuntimeEnv(name, existing);
    }
    if (!response.ok) throw new Error(`key_vault_secret_lookup_failed_${name}_${response.status}`);
    const payload = await response.json().catch(() => ({}));
    const value = typeof payload.value === "string" ? payload.value : "";
    if (!value.trim() || value === KEY_VAULT_UNSET_VALUE) {
      return fallbackProxyRuntimeEnv(name, existing);
    }
    proxyLastKnownGood.set(name, value);
    return value;
  } catch (error) {
    const stale = proxyLastKnownGood.get(name) || (existing?.trim() ? existing : undefined);
    if (stale) {
      console.warn(`Key Vault runtime config lookup failed for ${name}; using last-known-good value`);
      return stale;
    }
    throw error;
  }
}

export function setProxyRuntimeEnvFetchForTests(fetchImpl: typeof fetch | null) {
  proxyFetchOverride = fetchImpl;
  proxyTokenCache = null;
}

export function setProxyRuntimeEnvTokenProviderForTests(provider: (() => Promise<string>) | null) {
  proxyTokenProviderOverride = provider;
  proxyTokenCache = null;
}

export function resetProxyRuntimeEnvForTests() {
  proxyTokenCache = null;
  proxyLastKnownGood.clear();
  proxyFetchOverride = null;
  proxyTokenProviderOverride = null;
}
