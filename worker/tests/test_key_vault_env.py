import unittest
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import key_vault_env


MANIFEST = {
    "services": {
        "worker": {
            "required": ["DATABASE_URL", "ENTRA_CLIENT_SECRET"],
            "optional": ["OPTIONAL_VALUE"],
        }
    }
}


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class FakeRequests:
    def __init__(self, responses):
        self.responses = responses
        self.urls = []

    def get(self, url, **kwargs):
        self.urls.append((url, kwargs))
        for marker, response in self.responses:
            if marker in url:
                return response
        return FakeResponse(404, {})


class KeyVaultEnvTests(unittest.TestCase):
    def test_key_vault_env_names_use_hyphen_normalized_secret_names(self):
        self.assertEqual(key_vault_env.env_key_to_secret_name("DATABASE_URL"), "DATABASE-URL")
        self.assertEqual(key_vault_env.env_key_to_secret_name("ENTRA_CLIENT_SECRET"), "ENTRA-CLIENT-SECRET")

    def test_hydration_is_noop_without_vault_url(self):
        env = {}

        result = key_vault_env.hydrate_env_from_key_vault("worker", env=env, manifest=MANIFEST)

        self.assertFalse(result["vault_configured"])
        self.assertEqual(env, {})

    def test_hydration_preserves_existing_environment_values(self):
        env = {"AZ_KEY_VAULT_URL": "https://vault.example", "DATABASE_URL": "postgres://env"}
        requests = FakeRequests(
            [
                ("ENTRA-CLIENT-SECRET", FakeResponse(200, {"value": "client-secret"})),
                ("OPTIONAL-VALUE", FakeResponse(404, {})),
            ]
        )

        key_vault_env.hydrate_env_from_key_vault(
            "worker",
            env=env,
            manifest=MANIFEST,
            token_provider=lambda: "token",
            requests_module=requests,
        )

        self.assertEqual(env["DATABASE_URL"], "postgres://env")
        self.assertEqual(env["ENTRA_CLIENT_SECRET"], "client-secret")
        requested_urls = [url for url, _kwargs in requests.urls]
        self.assertFalse(any("DATABASE-URL" in url for url in requested_urls))

    def test_hydration_treats_blank_environment_values_as_missing(self):
        env = {"AZ_KEY_VAULT_URL": "https://vault.example", "DATABASE_URL": "   "}
        requests = FakeRequests(
            [
                ("DATABASE-URL", FakeResponse(200, {"value": "postgres://vault"})),
                ("ENTRA-CLIENT-SECRET", FakeResponse(200, {"value": "client-secret"})),
                ("OPTIONAL-VALUE", FakeResponse(404, {})),
            ]
        )

        key_vault_env.hydrate_env_from_key_vault(
            "worker",
            env=env,
            manifest=MANIFEST,
            token_provider=lambda: "token",
            requests_module=requests,
        )

        self.assertEqual(env["DATABASE_URL"], "postgres://vault")

    def test_hydration_ignores_missing_optional_secrets(self):
        env = {"AZ_KEY_VAULT_URL": "https://vault.example"}
        requests = FakeRequests(
            [
                ("DATABASE-URL", FakeResponse(200, {"value": "postgres://vault"})),
                ("ENTRA-CLIENT-SECRET", FakeResponse(200, {"value": "client-secret"})),
                ("OPTIONAL-VALUE", FakeResponse(404, {})),
            ]
        )

        key_vault_env.hydrate_env_from_key_vault(
            "worker",
            env=env,
            manifest=MANIFEST,
            token_provider=lambda: "token",
            requests_module=requests,
        )

        self.assertNotIn("OPTIONAL_VALUE", env)

    def test_hydration_treats_unset_tombstone_values_as_absent(self):
        env = {"AZ_KEY_VAULT_URL": "https://vault.example"}
        requests = FakeRequests(
            [
                ("DATABASE-URL", FakeResponse(200, {"value": "postgres://vault"})),
                ("ENTRA-CLIENT-SECRET", FakeResponse(200, {"value": "client-secret"})),
                ("OPTIONAL-VALUE", FakeResponse(200, {"value": key_vault_env.KEY_VAULT_UNSET_VALUE})),
            ]
        )

        key_vault_env.hydrate_env_from_key_vault(
            "worker",
            env=env,
            manifest=MANIFEST,
            token_provider=lambda: "token",
            requests_module=requests,
        )

        self.assertNotIn("OPTIONAL_VALUE", env)

    def test_hydration_reports_missing_required_names_without_secret_values(self):
        env = {"AZ_KEY_VAULT_URL": "https://vault.example"}

        with self.assertRaisesRegex(RuntimeError, "DATABASE_URL, ENTRA_CLIENT_SECRET"):
            key_vault_env.hydrate_env_from_key_vault(
                "worker",
                env=env,
                manifest=MANIFEST,
                token_provider=lambda: "token",
                requests_module=FakeRequests([]),
            )


if __name__ == "__main__":
    unittest.main()
