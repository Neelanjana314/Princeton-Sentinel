import { test } from "node:test";
import assert from "node:assert/strict";

const proxyRuntimeEnv = require("../app/lib/proxy-runtime-env") as typeof import("../app/lib/proxy-runtime-env");

function jsonResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  } as Response;
}

function resetEnv() {
  delete process.env.AZ_KEY_VAULT_URL;
  delete process.env.LOCAL_DOCKER_DEPLOYMENT;
  delete process.env.PRINCETON_SENTINEL_DISABLE_KEY_VAULT_RUNTIME;
  delete process.env.ADMIN_GROUP_ID;
  proxyRuntimeEnv.resetProxyRuntimeEnvForTests();
}

test("proxy runtime env bypasses Key Vault when runtime is disabled", async () => {
  resetEnv();
  process.env.AZ_KEY_VAULT_URL = "https://vault.example";
  process.env.PRINCETON_SENTINEL_DISABLE_KEY_VAULT_RUNTIME = "true";
  process.env.ADMIN_GROUP_ID = "from-env";
  let called = false;
  proxyRuntimeEnv.setProxyRuntimeEnvFetchForTests((async () => {
    called = true;
    return jsonResponse(200, { value: "from-vault" });
  }) as typeof fetch);

  assert.equal(await proxyRuntimeEnv.getProxyRuntimeEnv("ADMIN_GROUP_ID"), "from-env");
  assert.equal(called, false);
  resetEnv();
});

test("proxy runtime env falls back to existing env when Key Vault secret is missing", async () => {
  resetEnv();
  process.env.AZ_KEY_VAULT_URL = "https://vault.example";
  process.env.ADMIN_GROUP_ID = "from-env";
  proxyRuntimeEnv.setProxyRuntimeEnvTokenProviderForTests(async () => "token");
  proxyRuntimeEnv.setProxyRuntimeEnvFetchForTests((async () => jsonResponse(404, {})) as typeof fetch);

  assert.equal(await proxyRuntimeEnv.getProxyRuntimeEnv("ADMIN_GROUP_ID"), "from-env");
  resetEnv();
});

test("proxy runtime env falls back to existing env for blank Key Vault values", async () => {
  resetEnv();
  process.env.AZ_KEY_VAULT_URL = "https://vault.example";
  process.env.ADMIN_GROUP_ID = "from-env";
  proxyRuntimeEnv.setProxyRuntimeEnvTokenProviderForTests(async () => "token");
  proxyRuntimeEnv.setProxyRuntimeEnvFetchForTests((async () => jsonResponse(200, { value: "   " })) as typeof fetch);

  assert.equal(await proxyRuntimeEnv.getProxyRuntimeEnv("ADMIN_GROUP_ID"), "from-env");
  resetEnv();
});
