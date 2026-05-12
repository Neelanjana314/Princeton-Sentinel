import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.graph_client import GraphError
from app.jobs.graph_ingest import (
    _build_permission_error_state,
    _classify_permission_sync_error,
    _is_blocked_site_graph_error,
    _print_drive_listing_failure,
)


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

    @patch("builtins.print")
    def test_print_drive_listing_failure_does_not_log_context_values(self, mock_print):
        error = GraphError(
            423,
            "Graph error 423: blocked",
            "https://graph.microsoft.com/v1.0/groups/group-1/drives?$top=200",
            '{"error":{"code":"notAllowed","message":"Access to this site has been blocked.","secret":"plain-text-secret"}}',
        )

        _print_drive_listing_failure(
            target_kind="group",
            target_id="group-1",
            graph_error=error,
            extra={"group_name": "Blocked Site Group"},
        )

        mock_print.assert_called_once()
        printed = mock_print.call_args.args[0]
        self.assertEqual("[graph_ingest] drive listing failure", printed)
        self.assertNotIn("group-1", printed)
        self.assertNotIn("Blocked Site Group", printed)
        self.assertNotIn("plain-text-secret", printed)
        self.assertNotIn("request_url", printed)
        self.assertNotIn("response_text", printed)

    def test_blocked_site_graph_error_is_detected(self):
        error = GraphError(
            423,
            "Graph error 423: blocked",
            "https://graph.microsoft.com/v1.0/users/user-1/drives?$top=200",
            (
                '{"error":{"code":"notAllowed","message":"Access to this site has been blocked. '
                'Please contact the administrator to resolve this problem.",'
                '"innerError":{"code":"resourceLocked"}}}'
            ),
        )

        self.assertTrue(_is_blocked_site_graph_error(error))

    def test_other_423_graph_error_is_not_treated_as_blocked_site(self):
        error = GraphError(
            423,
            "Graph error 423: other",
            "https://graph.microsoft.com/v1.0/users/user-1/drives?$top=200",
            '{"error":{"code":"locked","message":"Different error","innerError":{"code":"other"}}}',
        )

        self.assertFalse(_is_blocked_site_graph_error(error))


if __name__ == "__main__":
    unittest.main()
