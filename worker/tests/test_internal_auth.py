import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.api import create_app


class WorkerInternalAuthTests(unittest.TestCase):
    def setUp(self):
        self.original_token = os.environ.get("WORKER_INTERNAL_API_TOKEN")
        os.environ["WORKER_INTERNAL_API_TOKEN"] = "worker-secret-token"
        app = create_app()
        self.client = app.test_client()

    def tearDown(self):
        if self.original_token is None:
            os.environ.pop("WORKER_INTERNAL_API_TOKEN", None)
        else:
            os.environ["WORKER_INTERNAL_API_TOKEN"] = self.original_token

    def test_worker_endpoints_require_internal_token(self):
        cases = [
            ("GET", "/health", None),
            ("GET", "/jobs/status", None),
            ("POST", "/jobs/run-now", {"job_id": "00000000-0000-0000-0000-000000000001"}),
            ("POST", "/jobs/pause", {"job_id": "00000000-0000-0000-0000-000000000001"}),
            ("POST", "/jobs/resume", {"job_id": "00000000-0000-0000-0000-000000000001"}),
        ]
        for method, path, payload in cases:
            with self.subTest(method=method, path=path):
                response = self.client.open(path=path, method=method, json=payload)
                self.assertEqual(response.status_code, 401)

    @patch("app.api.db.fetch_all", return_value=[])
    def test_jobs_status_accepts_valid_internal_token(self, _fetch_all):
        response = self.client.get("/jobs/status", headers={"X-Worker-Internal-Token": "worker-secret-token"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"jobs": []})

    @patch("app.api.get_current_license", side_effect=RuntimeError("license_db_down"))
    @patch("app.api.db.fetch_one", side_effect=RuntimeError("db_down"))
    def test_health_returns_degraded_response_when_license_lookup_fails(self, _fetch_one, _get_current_license):
        response = self.client.get("/health", headers={"X-Worker-Internal-Token": "worker-secret-token"})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertFalse(payload["ok"])
        self.assertFalse(payload["db"])
        self.assertEqual(payload["license"]["status"], "invalid")
        self.assertEqual(payload["license"]["mode"], "read_only")
        self.assertEqual(payload["license"]["verification_status"], "invalid")
        self.assertEqual(payload["license"]["verification_error"], "license_db_down")


if __name__ == "__main__":
    unittest.main()
