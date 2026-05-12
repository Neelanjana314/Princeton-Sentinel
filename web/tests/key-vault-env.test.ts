import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const keyVaultEnv = require(path.join(process.cwd(), "runtime/key-vault-env.cjs")) as any;

const manifest = {
  services: {
    web: {
      required: ["DATABASE_URL", "ENTRA_CLIENT_SECRET"],
      optional: ["OPTIONAL_VALUE"],
    },
  },
};

function jsonResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test("key vault env names use hyphen-normalized secret names", () => {
  assert.equal(keyVaultEnv.envKeyToSecretName("DATABASE_URL"), "DATABASE-URL");
  assert.equal(keyVaultEnv.envKeyToSecretName("ENTRA_CLIENT_SECRET"), "ENTRA-CLIENT-SECRET");
});

test("key vault hydration is a no-op without vault url", async () => {
  const env: Record<string, string> = {};
  const result = await keyVaultEnv.hydrateEnvFromKeyVault({ service: "web", env, manifest });

  assert.equal(result.vaultConfigured, false);
  assert.deepEqual(env, {});
});

test("key vault hydration is a no-op when runtime is disabled", async () => {
  const env: Record<string, string> = {
    AZ_KEY_VAULT_URL: "https://vault.example",
    PRINCETON_SENTINEL_DISABLE_KEY_VAULT_RUNTIME: "true",
  };
  let called = false;
  const result = await keyVaultEnv.hydrateEnvFromKeyVault({
    service: "web",
    env,
    manifest,
    tokenProvider: async () => "token",
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, { value: "from-vault" });
    },
  });

  assert.equal(result.vaultConfigured, false);
  assert.equal(called, false);
  assert.equal(env.DATABASE_URL, undefined);
});

test("key vault hydration preserves existing environment values", async () => {
  const env: Record<string, string> = {
    AZ_KEY_VAULT_URL: "https://vault.example",
    DATABASE_URL: "postgres://env",
  };
  const requested: string[] = [];
  const fetchImpl = async (url: URL | string) => {
    requested.push(String(url));
    return jsonResponse(200, { value: "from-vault" });
  };

  await keyVaultEnv.hydrateEnvFromKeyVault({
    service: "web",
    env,
    manifest,
    tokenProvider: async () => "token",
    fetchImpl,
  });

  assert.equal(env.DATABASE_URL, "postgres://env");
  assert.equal(env.ENTRA_CLIENT_SECRET, "from-vault");
  assert.equal(requested.some((url) => url.includes("DATABASE-URL")), false);
  assert.equal(requested.some((url) => url.includes("ENTRA-CLIENT-SECRET")), true);
});

test("key vault hydration treats blank environment values as missing", async () => {
  const env: Record<string, string> = {
    AZ_KEY_VAULT_URL: "https://vault.example",
    DATABASE_URL: "   ",
  };
  const fetchImpl = async (url: URL | string) => {
    const text = String(url);
    if (text.includes("DATABASE-URL")) {
      return jsonResponse(200, { value: "postgres://vault" });
    }
    return jsonResponse(200, { value: "client-secret" });
  };

  await keyVaultEnv.hydrateEnvFromKeyVault({
    service: "web",
    env,
    manifest,
    tokenProvider: async () => "token",
    fetchImpl,
  });

  assert.equal(env.DATABASE_URL, "postgres://vault");
});

test("key vault hydration ignores missing optional secrets", async () => {
  const env: Record<string, string> = { AZ_KEY_VAULT_URL: "https://vault.example" };
  const fetchImpl = async (url: URL | string) => {
    const text = String(url);
    if (text.includes("OPTIONAL-VALUE")) {
      return jsonResponse(404, {});
    }
    return jsonResponse(200, { value: text.includes("DATABASE-URL") ? "postgres://vault" : "client-secret" });
  };

  await keyVaultEnv.hydrateEnvFromKeyVault({
    service: "web",
    env,
    manifest,
    tokenProvider: async () => "token",
    fetchImpl,
  });

  assert.equal(env.OPTIONAL_VALUE, undefined);
});

test("key vault hydration treats unset tombstone values as absent", async () => {
  const env: Record<string, string> = { AZ_KEY_VAULT_URL: "https://vault.example" };
  const fetchImpl = async (url: URL | string) => {
    const text = String(url);
    if (text.includes("OPTIONAL-VALUE")) {
      return jsonResponse(200, { value: keyVaultEnv.KEY_VAULT_UNSET_VALUE });
    }
    return jsonResponse(200, { value: text.includes("DATABASE-URL") ? "postgres://vault" : "client-secret" });
  };

  await keyVaultEnv.hydrateEnvFromKeyVault({
    service: "web",
    env,
    manifest,
    tokenProvider: async () => "token",
    fetchImpl,
  });

  assert.equal(env.OPTIONAL_VALUE, undefined);
});

test("key vault hydration reports missing required names without secret values", async () => {
  const env: Record<string, string> = { AZ_KEY_VAULT_URL: "https://vault.example" };
  const fetchImpl = async () => jsonResponse(404, {});

  await assert.rejects(
    keyVaultEnv.hydrateEnvFromKeyVault({
      service: "web",
      env,
      manifest,
      tokenProvider: async () => "token",
      fetchImpl,
    }),
    /DATABASE_URL, ENTRA_CLIENT_SECRET/,
  );
});
