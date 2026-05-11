import { test } from "node:test";
import assert from "node:assert/strict";

const runtimeEnv = require("../app/lib/runtime-env") as typeof import("../app/lib/runtime-env");

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
  delete process.env.ADMIN_GROUP_ID;
  delete process.env.DATABASE_URL;
  delete process.env.WORKER_API_URL;
  runtimeEnv.resetRuntimeEnvForTests();
}

test("live runtime env fetches Key Vault on every Azure read", async () => {
  resetEnv();
  process.env.AZ_KEY_VAULT_URL = "https://vault.example";
  const requested: string[] = [];
  runtimeEnv.setRuntimeEnvTokenProviderForTests(async () => "token");
  runtimeEnv.setRuntimeEnvFetchForTests((async (url: URL | string) => {
    requested.push(String(url));
    return jsonResponse(200, { value: `group-${requested.length}` });
  }) as typeof fetch);

  assert.equal(await runtimeEnv.getRuntimeEnv("ADMIN_GROUP_ID"), "group-1");
  assert.equal(await runtimeEnv.getRuntimeEnv("ADMIN_GROUP_ID"), "group-2");
  assert.equal(requested.filter((url) => url.includes("ADMIN-GROUP-ID")).length, 2);
  resetEnv();
});

test("live runtime env bypasses Key Vault for local Docker", async () => {
  resetEnv();
  process.env.AZ_KEY_VAULT_URL = "https://vault.example";
  process.env.LOCAL_DOCKER_DEPLOYMENT = "true";
  process.env.ADMIN_GROUP_ID = "from-env";
  let called = false;
  runtimeEnv.setRuntimeEnvFetchForTests((async () => {
    called = true;
    return jsonResponse(200, { value: "from-vault" });
  }) as typeof fetch);

  assert.equal(await runtimeEnv.getRuntimeEnv("ADMIN_GROUP_ID"), "from-env");
  assert.equal(called, false);
  resetEnv();
});

test("live runtime env falls back to existing env when Key Vault secret is missing", async () => {
  resetEnv();
  process.env.AZ_KEY_VAULT_URL = "https://vault.example";
  process.env.WORKER_API_URL = "https://worker.example";
  runtimeEnv.setRuntimeEnvTokenProviderForTests(async () => "token");
  runtimeEnv.setRuntimeEnvFetchForTests((async () => jsonResponse(404, {})) as typeof fetch);

  assert.equal(await runtimeEnv.getRuntimeEnv("WORKER_API_URL"), "https://worker.example");
  assert.equal(process.env.WORKER_API_URL, "https://worker.example");
  resetEnv();
});

test("live runtime env uses last-known-good after Key Vault failure", async () => {
  resetEnv();
  process.env.AZ_KEY_VAULT_URL = "https://vault.example";
  let fail = false;
  runtimeEnv.setRuntimeEnvTokenProviderForTests(async () => "token");
  runtimeEnv.setRuntimeEnvFetchForTests((async () => {
    if (fail) throw new Error("vault_down");
    return jsonResponse(200, { value: "fresh-secret" });
  }) as typeof fetch);

  assert.equal(await runtimeEnv.getRuntimeEnv("DATABASE_URL"), "fresh-secret");
  fail = true;
  assert.equal(await runtimeEnv.getRuntimeEnv("DATABASE_URL"), "fresh-secret");
  resetEnv();
});

test("required runtime env fails when no live or stale value exists", async () => {
  resetEnv();
  process.env.AZ_KEY_VAULT_URL = "https://vault.example";
  runtimeEnv.setRuntimeEnvTokenProviderForTests(async () => "token");
  runtimeEnv.setRuntimeEnvFetchForTests((async () => {
    throw new Error("vault_down");
  }) as typeof fetch);

  await assert.rejects(runtimeEnv.requireRuntimeEnv("DATABASE_URL"), /vault_down/);
  resetEnv();
});
