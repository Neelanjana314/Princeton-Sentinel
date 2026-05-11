import unittest
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import key_vault_env, runtime_config


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

    def test_live_runtime_config_fetches_key_vault_on_every_azure_read(self):
        original_env = dict(key_vault_env.os.environ)
        try:
            key_vault_env.os.environ.clear()
            key_vault_env.os.environ.update({"AZ_KEY_VAULT_URL": "https://vault.example"})
            runtime_config.reset_runtime_config_for_tests()
            runtime_config.set_runtime_config_token_provider_for_tests(lambda: "token")
            requests = FakeRequests(
                [
                    ("ADMIN-GROUP-ID", FakeResponse(200, {"value": "group-a"})),
                ]
            )
            runtime_config.set_runtime_config_requests_for_tests(requests)

            self.assertEqual(runtime_config.get_runtime_env("ADMIN_GROUP_ID"), "group-a")
            self.assertEqual(runtime_config.get_runtime_env("ADMIN_GROUP_ID"), "group-a")
            requested_urls = [url for url, _kwargs in requests.urls]
            self.assertEqual(sum("ADMIN-GROUP-ID" in url for url in requested_urls), 2)
        finally:
            key_vault_env.os.environ.clear()
            key_vault_env.os.environ.update(original_env)
            runtime_config.reset_runtime_config_for_tests()

    def test_live_runtime_config_uses_local_env_for_local_docker(self):
        original_env = dict(key_vault_env.os.environ)
        try:
            key_vault_env.os.environ.clear()
            key_vault_env.os.environ.update(
                {
                    "AZ_KEY_VAULT_URL": "https://vault.example",
                    "LOCAL_DOCKER_DEPLOYMENT": "true",
                    "ADMIN_GROUP_ID": "from-env",
                }
            )
            runtime_config.reset_runtime_config_for_tests()
            requests = FakeRequests([("ADMIN-GROUP-ID", FakeResponse(200, {"value": "from-vault"}))])
            runtime_config.set_runtime_config_requests_for_tests(requests)

            self.assertEqual(runtime_config.get_runtime_env("ADMIN_GROUP_ID"), "from-env")
            self.assertEqual(requests.urls, [])
        finally:
            key_vault_env.os.environ.clear()
            key_vault_env.os.environ.update(original_env)
            runtime_config.reset_runtime_config_for_tests()

    def test_live_runtime_config_uses_existing_env_when_key_vault_secret_missing(self):
        original_env = dict(key_vault_env.os.environ)
        try:
            key_vault_env.os.environ.clear()
            key_vault_env.os.environ.update(
                {
                    "AZ_KEY_VAULT_URL": "https://vault.example",
                    "WORKER_HEARTBEAT_URL": "https://web.example/api/internal/worker-heartbeat",
                }
            )
            runtime_config.reset_runtime_config_for_tests()
            runtime_config.set_runtime_config_token_provider_for_tests(lambda: "token")
            runtime_config.set_runtime_config_requests_for_tests(FakeRequests([("WORKER-HEARTBEAT-URL", FakeResponse(404, {}))]))

            self.assertEqual(
                runtime_config.get_runtime_env("WORKER_HEARTBEAT_URL", "http://web:3000/api/internal/worker-heartbeat"),
                "https://web.example/api/internal/worker-heartbeat",
            )
            self.assertEqual(
                key_vault_env.os.environ["WORKER_HEARTBEAT_URL"],
                "https://web.example/api/internal/worker-heartbeat",
            )
        finally:
            key_vault_env.os.environ.clear()
            key_vault_env.os.environ.update(original_env)
            runtime_config.reset_runtime_config_for_tests()

    def test_live_runtime_config_uses_last_known_good_after_failure(self):
        original_env = dict(key_vault_env.os.environ)
        try:
            key_vault_env.os.environ.clear()
            key_vault_env.os.environ.update({"AZ_KEY_VAULT_URL": "https://vault.example"})
            runtime_config.reset_runtime_config_for_tests()
            runtime_config.set_runtime_config_token_provider_for_tests(lambda: "token")
            requests = FakeRequests([("DATABASE-URL", FakeResponse(200, {"value": "postgres://vault"}))])
            runtime_config.set_runtime_config_requests_for_tests(requests)

            self.assertEqual(runtime_config.get_runtime_env("DATABASE_URL"), "postgres://vault")
            runtime_config.set_runtime_config_requests_for_tests(FakeRequests([("DATABASE-URL", FakeResponse(500, {}))]))
            self.assertEqual(runtime_config.get_runtime_env("DATABASE_URL"), "postgres://vault")
        finally:
            key_vault_env.os.environ.clear()
            key_vault_env.os.environ.update(original_env)
            runtime_config.reset_runtime_config_for_tests()

    def test_live_runtime_config_required_value_fails_without_stale_value(self):
        original_env = dict(key_vault_env.os.environ)
        try:
            key_vault_env.os.environ.clear()
            key_vault_env.os.environ.update({"AZ_KEY_VAULT_URL": "https://vault.example"})
            runtime_config.reset_runtime_config_for_tests()
            runtime_config.set_runtime_config_token_provider_for_tests(lambda: "token")
            runtime_config.set_runtime_config_requests_for_tests(FakeRequests([("DATABASE-URL", FakeResponse(500, {}))]))

            with self.assertRaisesRegex(RuntimeError, "status 500"):
                runtime_config.require_runtime_env("DATABASE_URL")
        finally:
            key_vault_env.os.environ.clear()
            key_vault_env.os.environ.update(original_env)
            runtime_config.reset_runtime_config_for_tests()


if __name__ == "__main__":
    unittest.main()
