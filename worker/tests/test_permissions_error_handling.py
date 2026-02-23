import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.graph_client import GraphError
from app.jobs.graph_ingest import _build_permission_error_state, _classify_permission_sync_error


class PermissionErrorHandlingTests(unittest.TestCase):
    def test_classify_graph_not_found_error(self):
        error = GraphError(
            404,
            "ResourceNotFound",
            "https://graph.microsoft.com/v1.0/drives/d/items/i/permissions",
            '{"error":{"code":"itemNotFound","message":"The resource could not be found."}}',
        )

        info = _classify_permission_sync_error(error)

        self.assertEqual(info["category"], "graph_not_found")
        self.assertEqual(info["status_code"], 404)
        self.assertEqual(info["graph_code"], "itemNotFound")
        self.assertEqual(info["message"], "The resource could not be found.")

    def test_build_permission_error_state_increments_consecutive_failures(self):
        now = datetime.now(timezone.utc)
        classification = {
            "category": "graph_forbidden",
            "status_code": 403,
            "graph_code": "accessDenied",
            "message": "Access denied",
            "request_url": "https://graph.microsoft.com/v1.0/example",
            "response_excerpt": "forbidden",
            "error_type": "GraphError",
        }
        previous = {
            "last_failure_signature": "graph_forbidden|403|accessDenied",
            "consecutive_failures": 2,
        }

        state = _build_permission_error_state(
            classification=classification,
            run_id="run-1",
            phase="primary",
            attempt_in_run=1,
            failed_at=now,
            previous_details=previous,
        )

        self.assertIn("graph_forbidden", state["summary"])
        self.assertEqual(state["details"]["consecutive_failures"], 3)
        self.assertEqual(state["details"]["last_failure_signature"], "graph_forbidden|403|accessDenied")

    def test_build_permission_error_state_resets_on_signature_change(self):
        now = datetime.now(timezone.utc)
        classification = {
            "category": "graph_not_found",
            "status_code": 404,
            "graph_code": "itemNotFound",
            "message": "Missing",
            "request_url": None,
            "response_excerpt": None,
            "error_type": "GraphError",
        }
        previous = {
            "last_failure_signature": "graph_forbidden|403|accessDenied",
            "consecutive_failures": 5,
        }

        state = _build_permission_error_state(
            classification=classification,
            run_id="run-2",
            phase="final_retry",
            attempt_in_run=2,
            failed_at=now,
            previous_details=previous,
        )

        self.assertEqual(state["details"]["consecutive_failures"], 1)
        self.assertEqual(state["details"]["last_failure_signature"], "graph_not_found|404|itemNotFound")
        self.assertEqual(state["details"]["phase"], "final_retry")
        self.assertEqual(state["details"]["attempt_in_run"], 2)


if __name__ == "__main__":
    unittest.main()
