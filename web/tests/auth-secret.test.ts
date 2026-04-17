import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getBootScopedAuthSecret,
  resetBootScopedAuthSecretForTests,
  setBootScopedAuthSecretForTests,
} from "../app/lib/auth-secret";

test("boot-scoped auth secret is generated once per boot", () => {
  resetBootScopedAuthSecretForTests();

  try {
    const first = getBootScopedAuthSecret();
    const second = getBootScopedAuthSecret();

    assert.equal(typeof first, "string");
    assert.notEqual(first, "");
    assert.equal(first, second);
  } finally {
    resetBootScopedAuthSecretForTests();
  }
});

test("boot-scoped auth secret override is used for tests", () => {
  resetBootScopedAuthSecretForTests();

  try {
    setBootScopedAuthSecretForTests("test-auth-secret");

    assert.equal(getBootScopedAuthSecret(), "test-auth-secret");
  } finally {
    resetBootScopedAuthSecretForTests();
  }
});

test("reset clears any test override and generated secret", () => {
  resetBootScopedAuthSecretForTests();

  try {
    setBootScopedAuthSecretForTests("test-auth-secret");
    assert.equal(getBootScopedAuthSecret(), "test-auth-secret");

    resetBootScopedAuthSecretForTests();

    const regenerated = getBootScopedAuthSecret();
    assert.notEqual(regenerated, "test-auth-secret");
    assert.notEqual(regenerated, "");
  } finally {
    resetBootScopedAuthSecretForTests();
  }
});
