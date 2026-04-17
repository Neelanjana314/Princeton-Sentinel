type AuthSecretGlobals = typeof globalThis & {
  __princetonSentinelBootAuthSecret?: string;
  __princetonSentinelBootAuthSecretOverride?: string | null;
};

const authSecretGlobals = globalThis as AuthSecretGlobals;

function generateBootScopedAuthSecret() {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function getBootScopedAuthSecret() {
  if (typeof authSecretGlobals.__princetonSentinelBootAuthSecretOverride === "string") {
    return authSecretGlobals.__princetonSentinelBootAuthSecretOverride;
  }

  if (!authSecretGlobals.__princetonSentinelBootAuthSecret) {
    authSecretGlobals.__princetonSentinelBootAuthSecret = generateBootScopedAuthSecret();
  }

  return authSecretGlobals.__princetonSentinelBootAuthSecret;
}

export function setBootScopedAuthSecretForTests(secret: string | null) {
  if (secret !== null && !secret.trim()) {
    throw new Error("Boot-scoped auth secret override must be non-empty");
  }

  authSecretGlobals.__princetonSentinelBootAuthSecretOverride = secret;
}

export function resetBootScopedAuthSecretForTests() {
  delete authSecretGlobals.__princetonSentinelBootAuthSecret;
  delete authSecretGlobals.__princetonSentinelBootAuthSecretOverride;
}
