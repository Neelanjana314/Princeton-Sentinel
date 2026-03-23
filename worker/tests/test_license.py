import base64
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.api import create_app
from app.license import (
    LICENSE_SCHEMA_VERSION,
    LICENSE_SIGNATURE_DELIMITER,
    LicenseFeatureError,
    canonicalize_license_payload,
    clear_license_cache,
    get_current_license,
    summarize_license_artifact,
)
from app import scheduler


def build_payload(**overrides):
    payload = {
        "schema_version": LICENSE_SCHEMA_VERSION,
        "license_id": "license-123",
        "license_type": "enterprise",
        "tenant_id": "tenant-a",
        "issued_at": "2026-03-23T12:00:00.000Z",
        "expires_at": "2026-12-31T23:59:59.000Z",
        "features": {
            "dashboard_read": True,
            "live_graph_read": True,
            "admin_view": True,
            "license_manage": True,
            "permission_revoke": True,
            "job_control": True,
            "graph_ingest": True,
            "copilot_telemetry": True,
            "agents_dashboard": True,
        },
    }
    payload.update(overrides)
    return payload


def sign_artifact(private_key, payload):
    canonical_payload = canonicalize_license_payload(payload)
    signature = private_key.sign(canonical_payload.encode("utf-8"), padding.PKCS1v15(), hashes.SHA256())
    return f"{canonical_payload}{LICENSE_SIGNATURE_DELIMITER}{base64.b64encode(signature).decode('ascii')}\n"


class WorkerLicenseTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public_key = self.private_key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        self.public_key_path = Path(self.temp_dir.name) / "public.pem"
        self.public_key_path.write_bytes(public_key)

        self.original_public_key_path = os.environ.get("LICENSE_PUBLIC_KEY_PATH")
        self.original_tenant_id = os.environ.get("ENTRA_TENANT_ID")
        self.original_worker_token = os.environ.get("WORKER_INTERNAL_API_TOKEN")

        os.environ["LICENSE_PUBLIC_KEY_PATH"] = str(self.public_key_path)
        os.environ["ENTRA_TENANT_ID"] = "tenant-a"
        os.environ["WORKER_INTERNAL_API_TOKEN"] = "worker-secret-token"
        clear_license_cache()

        self.client = create_app().test_client()

    def tearDown(self):
        self.temp_dir.cleanup()
        if self.original_public_key_path is None:
            os.environ.pop("LICENSE_PUBLIC_KEY_PATH", None)
        else:
            os.environ["LICENSE_PUBLIC_KEY_PATH"] = self.original_public_key_path
        if self.original_tenant_id is None:
            os.environ.pop("ENTRA_TENANT_ID", None)
        else:
            os.environ["ENTRA_TENANT_ID"] = self.original_tenant_id
        if self.original_worker_token is None:
            os.environ.pop("WORKER_INTERNAL_API_TOKEN", None)
        else:
            os.environ["WORKER_INTERNAL_API_TOKEN"] = self.original_worker_token
        clear_license_cache()

    def test_summarize_license_artifact_rejects_tenant_mismatch(self):
        artifact = sign_artifact(self.private_key, build_payload(tenant_id="tenant-b"))
        summary = summarize_license_artifact(artifact)
        self.assertEqual(summary["status"], "invalid")
        self.assertEqual(summary["verification_error"], "license_tenant_id_mismatch")
        self.assertFalse(summary["features"]["graph_ingest"])

    def test_summarize_license_artifact_accepts_web_style_millisecond_timestamps(self):
        payload_text = json.dumps(
            {
                "expires_at": "2026-12-31T23:59:59.000Z",
                "features": {
                    "admin_view": True,
                    "agents_dashboard": True,
                    "copilot_telemetry": True,
                    "dashboard_read": True,
                    "graph_ingest": True,
                    "job_control": True,
                    "license_manage": True,
                    "live_graph_read": True,
                    "permission_revoke": True,
                },
                "issued_at": "2026-03-23T12:00:00.000Z",
                "license_id": "license-123",
                "license_type": "enterprise",
                "schema_version": LICENSE_SCHEMA_VERSION,
                "tenant_id": "tenant-a",
            },
            separators=(",", ":"),
        )
        signature = self.private_key.sign(payload_text.encode("utf-8"), padding.PKCS1v15(), hashes.SHA256())
        artifact = f"{payload_text}{LICENSE_SIGNATURE_DELIMITER}{base64.b64encode(signature).decode('ascii')}\n"

        summary = summarize_license_artifact(artifact)

        self.assertEqual(summary["status"], "active")
        self.assertEqual(summary["verification_status"], "verified")
        self.assertTrue(summary["features"]["job_control"])

    @patch("app.license.db.fetch_one")
    def test_get_current_license_returns_missing_summary_without_unboundlocalerror(self, mock_fetch_one):
        mock_fetch_one.return_value = None

        summary = get_current_license()

        self.assertEqual(summary["status"], "missing")
        self.assertEqual(summary["verification_status"], "missing")
        self.assertEqual(summary["verification_error"], "license_missing")

    @patch("app.api.db.fetch_one", return_value={"job_id": "job-1", "job_type": "graph_ingest"})
    @patch("app.api.require_license_feature")
    def test_run_now_endpoint_returns_403_when_license_blocks_job_control(self, mock_require_license_feature, _mock_fetch_one):
        summary = {"status": "invalid", "features": {"job_control": False}}
        mock_require_license_feature.side_effect = LicenseFeatureError("job_control", summary)

        response = self.client.post(
            "/jobs/run-now",
            json={"job_id": "job-1"},
            headers={"X-Worker-Internal-Token": "worker-secret-token"},
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["error"], "license_feature_job_control_disabled")

    @patch("app.scheduler.db.get_conn")
    @patch("app.scheduler.log_audit_event")
    @patch("app.scheduler.emit")
    @patch("app.scheduler.require_license_feature")
    def test_run_job_once_skips_blocked_job_types_before_db_work(self, mock_require_license_feature, _mock_emit, mock_log_audit_event, mock_get_conn):
        mock_require_license_feature.side_effect = LicenseFeatureError("graph_ingest", {"status": "invalid"})

        scheduler.run_job_once({"job_id": "job-1", "job_type": "graph_ingest"})

        mock_get_conn.assert_not_called()
        mock_log_audit_event.assert_called_once()
        self.assertEqual(mock_log_audit_event.call_args.kwargs["action"], "job_run_blocked_license")


if __name__ == "__main__":
    unittest.main()
