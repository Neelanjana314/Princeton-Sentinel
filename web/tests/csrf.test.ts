import { test } from "node:test";
import assert from "node:assert/strict";

import { resetBootScopedAuthSecretForTests, setBootScopedAuthSecretForTests } from "../app/lib/auth-secret";
import {
  createCsrfToken,
  CSRF_HEADER_NAME,
  getCsrfCookieName,
  isValidCsrfToken,
  validateCsrfRequest,
} from "../app/lib/csrf";

function withTestSecrets(run: () => void) {
  delete process.env.CSRF_SECRET;
  resetBootScopedAuthSecretForTests();
  setBootScopedAuthSecretForTests("test-auth-secret");

  try {
    run();
  } finally {
    delete process.env.CSRF_SECRET;
    resetBootScopedAuthSecretForTests();
  }
}

test("csrf token round-trip produces a signed token", () => {
  withTestSecrets(() => {
    const token = createCsrfToken();

    assert.equal(isValidCsrfToken(token), true);
  });
});

test("csrf validation accepts a matching signed cookie and header token", () => {
  withTestSecrets(() => {
    const token = createCsrfToken();
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: {
        cookie: `${getCsrfCookieName()}=${token}`,
        [CSRF_HEADER_NAME]: token,
      },
    });

    const result = validateCsrfRequest(req);

    assert.deepEqual(result, { ok: true, token });
  });
});

test("csrf validation rejects requests without a submitted token", () => {
  withTestSecrets(() => {
    const token = createCsrfToken();
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: {
        cookie: `${getCsrfCookieName()}=${token}`,
      },
    });

    const result = validateCsrfRequest(req);

    assert.deepEqual(result, { ok: false, error: "missing_csrf_token" });
  });
});

test("csrf validation rejects mismatched tokens", () => {
  withTestSecrets(() => {
    const cookieToken = createCsrfToken();
    const headerToken = createCsrfToken();
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: {
        cookie: `${getCsrfCookieName()}=${cookieToken}`,
        [CSRF_HEADER_NAME]: headerToken,
      },
    });

    const result = validateCsrfRequest(req);

    assert.deepEqual(result, { ok: false, error: "invalid_csrf_token" });
  });
});
