import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.graph_client import GraphError
from app.jobs import graph_ingest


class FakeCursor:
    def __init__(self, responses=None):
        self.responses = responses or {}
        self.executed = []
        self._fetchall = []
        self.rowcount = 0

    def execute(self, sql, params=None):
        normalized = " ".join(sql.split())
        lower = normalized.lower()
        self.executed.append((normalized, params))

        if lower.startswith("select id, mail, user_principal_name from msgraph_users"):
            self._fetchall = list(self.responses.get("user_maps", []))
            self.rowcount = len(self._fetchall)
        elif lower.startswith("select id, hostname, web_url, raw_json from msgraph_sites"):
            self._fetchall = list(self.responses.get("sites", []))
            self.rowcount = len(self._fetchall)
        elif lower.startswith("select id from msgraph_groups"):
            self._fetchall = list(self.responses.get("groups", []))
            self.rowcount = len(self._fetchall)
        elif lower.startswith("select id from msgraph_users where deleted_at is null"):
            self._fetchall = list(self.responses.get("users", []))
            self.rowcount = len(self._fetchall)
        elif lower.startswith("select id from msgraph_drives where deleted_at is null and is_available = true"):
            self._fetchall = list(self.responses.get("available_drives", []))
            self.rowcount = len(self._fetchall)
        elif "from msgraph_drive_items i join msgraph_drives d on d.id = i.drive_id" in lower:
            candidate_batches = self.responses.get("permission_candidates", [])
            if candidate_batches:
                self._fetchall = list(candidate_batches.pop(0))
            else:
                self._fetchall = []
            self.rowcount = len(self._fetchall)
        elif lower.startswith("select drive_id, id, permissions_last_error_details from msgraph_drive_items"):
            self._fetchall = list(self.responses.get("permission_error_details", []))
            self.rowcount = len(self._fetchall)
        else:
            self._fetchall = []
            self.rowcount = 1 if lower.startswith("update ") else 0

    def fetchall(self):
        return list(self._fetchall)


class FakeConnection:
    def __init__(self, responses=None):
        self.cursor_obj = FakeCursor(responses=responses)
        self.commit_count = 0
        self.rollback_count = 0
        self.closed = False

    def cursor(self):
        return self.cursor_obj

    def commit(self):
        self.commit_count += 1

    def rollback(self):
        self.rollback_count += 1

    def close(self):
        self.closed = True


class GraphAvailabilityTests(unittest.TestCase):
    @patch("app.jobs.graph_ingest.log_job_run_log")
    @patch("app.jobs.graph_ingest.emit")
    @patch("app.jobs.graph_ingest.db.get_conn")
    @patch("app.jobs.graph_ingest._execute_values_dedup_merge_drives")
    def test_site_404_marks_site_and_cached_drives_unavailable(
        self,
        mock_merge_drives,
        mock_get_conn,
        _mock_emit,
        _mock_log_job_run_log,
    ):
        fake_conn = FakeConnection(
            responses={
                "user_maps": [],
                "sites": [("site-1", "contoso.sharepoint.com", "https://contoso.sharepoint.com/sites/site-1", {})],
                "groups": [],
                "users": [],
            }
        )
        mock_get_conn.return_value = fake_conn
        mock_merge_drives.return_value = (0, 0)

        client = unittest.mock.Mock()
        client.iter_paged.side_effect = GraphError(
            404,
            "Graph error 404: site not found",
            "https://graph.microsoft.com/v1.0/sites/site-1/drives",
            '{"error":{"code":"itemNotFound","message":"Requested site could not be found"}}',
        )

        graph_ingest._ingest_drives(client, run_id="run-1", flush_every=100)

        executed_sql = [sql for sql, _params in fake_conn.cursor_obj.executed]
        self.assertTrue(any("UPDATE msgraph_sites SET is_available = FALSE" in sql for sql in executed_sql))
        self.assertTrue(any("UPDATE msgraph_drives SET is_available = FALSE" in sql for sql in executed_sql))
        self.assertTrue(fake_conn.closed)

    @patch("app.jobs.graph_ingest.log_job_run_log")
    @patch("app.jobs.graph_ingest.emit")
    @patch("app.jobs.graph_ingest.db.get_conn")
    @patch("app.jobs.graph_ingest._execute_values_dedup_merge_drives")
    def test_terminal_listing_error_discards_partially_yielded_drive_upserts(
        self,
        mock_merge_drives,
        mock_get_conn,
        _mock_emit,
        _mock_log_job_run_log,
    ):
        fake_conn = FakeConnection(
            responses={
                "user_maps": [],
                "sites": [("site-1", "contoso.sharepoint.com", "https://contoso.sharepoint.com/sites/site-1", {})],
                "groups": [],
                "users": [],
            }
        )
        mock_get_conn.return_value = fake_conn
        mock_merge_drives.return_value = (0, 0)

        def iter_paged(url):
            def gen():
                yield {
                    "id": "drive-1",
                    "name": "Documents",
                    "driveType": "documentLibrary",
                    "webUrl": "https://contoso.sharepoint.com/sites/site-1/shared documents",
                    "quota": {},
                }
                raise GraphError(
                    404,
                    "Graph error 404: site not found",
                    url,
                    '{"error":{"code":"itemNotFound","message":"Requested site could not be found"}}',
                )

            return gen()

        client = unittest.mock.Mock()
        client.iter_paged.side_effect = iter_paged

        graph_ingest._ingest_drives(client, run_id="run-1b", flush_every=100)

        mock_merge_drives.assert_not_called()
        executed_sql = [sql for sql, _params in fake_conn.cursor_obj.executed]
        self.assertTrue(any("UPDATE msgraph_sites SET is_available = FALSE" in sql for sql in executed_sql))
        self.assertTrue(any("UPDATE msgraph_drives SET is_available = FALSE" in sql for sql in executed_sql))

    @patch("app.jobs.graph_ingest.log_job_run_log")
    @patch("app.jobs.graph_ingest.emit")
    @patch("app.jobs.graph_ingest.db.get_conn")
    @patch("app.jobs.graph_ingest._execute_values_dedup_merge_drives")
    def test_user_mysite_404_marks_cached_personal_drives_unavailable_only(
        self,
        mock_merge_drives,
        mock_get_conn,
        _mock_emit,
        _mock_log_job_run_log,
    ):
        fake_conn = FakeConnection(
            responses={
                "user_maps": [],
                "sites": [],
                "groups": [],
                "users": [("user-1",)],
            }
        )
        mock_get_conn.return_value = fake_conn
        mock_merge_drives.return_value = (0, 0)

        client = unittest.mock.Mock()

        def iter_paged(url):
            if "/users/user-1/drives" in url:
                raise GraphError(
                    404,
                    "Graph error 404: User's mysite not found.",
                    url,
                    '{"error":{"code":"ResourceNotFound","message":"User\'s mysite not found."}}',
                )
            return []

        client.iter_paged.side_effect = iter_paged

        graph_ingest._ingest_drives(client, run_id="run-2", flush_every=100)

        executed_sql = [sql for sql, _params in fake_conn.cursor_obj.executed]
        self.assertTrue(any("UPDATE msgraph_drives SET is_available = FALSE" in sql for sql in executed_sql))
        self.assertFalse(any("UPDATE msgraph_users SET is_available = FALSE" in sql for sql in executed_sql))

    @patch("app.jobs.graph_ingest.log_job_run_log")
    @patch("app.jobs.graph_ingest.emit")
    @patch("app.jobs.graph_ingest.db.get_conn")
    @patch("app.jobs.graph_ingest._execute_values_dedup_merge_drives")
    def test_successful_site_listing_marks_site_available(
        self,
        mock_merge_drives,
        mock_get_conn,
        _mock_emit,
        _mock_log_job_run_log,
    ):
        fake_conn = FakeConnection(
            responses={
                "user_maps": [],
                "sites": [("site-1", "contoso.sharepoint.com", "https://contoso.sharepoint.com/sites/site-1", {})],
                "groups": [],
                "users": [],
            }
        )
        mock_get_conn.return_value = fake_conn
        mock_merge_drives.return_value = (1, 0)

        client = unittest.mock.Mock()
        client.iter_paged.return_value = [
            {
                "id": "drive-1",
                "name": "Documents",
                "driveType": "documentLibrary",
                "webUrl": "https://contoso.sharepoint.com/sites/site-1/shared documents",
                "quota": {},
            }
        ]

        graph_ingest._ingest_drives(client, run_id="run-3", flush_every=100)

        executed_sql = [sql for sql, _params in fake_conn.cursor_obj.executed]
        self.assertTrue(any("UPDATE msgraph_sites SET is_available = TRUE" in sql for sql in executed_sql))

    @patch("app.jobs.graph_ingest.log_job_run_log")
    @patch("app.jobs.graph_ingest.emit")
    @patch("app.jobs.graph_ingest.db.get_conn")
    def test_drive_items_only_select_available_drives(self, mock_get_conn, _mock_emit, _mock_log_job_run_log):
        fake_conn = FakeConnection(responses={"available_drives": [], "user_maps": []})
        mock_get_conn.return_value = fake_conn

        graph_ingest._ingest_drive_items(unittest.mock.Mock(), run_id="run-4", flush_every=100)

        executed_sql = [sql for sql, _params in fake_conn.cursor_obj.executed]
        self.assertTrue(any("SELECT id FROM msgraph_drives WHERE deleted_at IS NULL AND is_available = TRUE" in sql for sql in executed_sql))

    @patch("app.jobs.graph_ingest.GRAPH_MAX_CONCURRENCY", 1)
    @patch("app.jobs.graph_ingest.log_job_run_log")
    @patch("app.jobs.graph_ingest.emit")
    @patch("app.jobs.graph_ingest.db.execute_values")
    @patch("app.jobs.graph_ingest.db.get_conn")
    @patch("app.jobs.graph_ingest._execute_db_mutation_with_retry")
    @patch("app.jobs.graph_ingest._fetch_permissions")
    def test_permission_not_found_stays_item_level_and_does_not_mark_drive_unavailable(
        self,
        mock_fetch_permissions,
        mock_db_retry,
        mock_get_conn,
        _mock_execute_values,
        _mock_emit,
        _mock_log_job_run_log,
    ):
        fake_conn = FakeConnection(
            responses={
                "permission_candidates": [[("drive-1", "item-1")], []],
                "permission_error_details": [],
            }
        )
        mock_get_conn.return_value = fake_conn
        mock_fetch_permissions.side_effect = GraphError(
            404,
            "Graph error 404: item not found",
            "https://graph.microsoft.com/v1.0/drives/drive-1/items/item-1/permissions",
            '{"error":{"code":"itemNotFound","message":"Item not found"}}',
        )

        def run_mutation(conn, **kwargs):
            kwargs["mutation_fn"]()
            return True, 0, None, None

        mock_db_retry.side_effect = run_mutation

        graph_ingest._scan_permissions(unittest.mock.Mock(), {}, run_id="run-5")

        executed_sql = [sql for sql, _params in fake_conn.cursor_obj.executed]
        self.assertTrue(
            any("JOIN msgraph_drives d ON d.id = i.drive_id" in sql and "d.is_available = TRUE" in sql for sql in executed_sql)
        )
        self.assertFalse(any("UPDATE msgraph_drives SET is_available = FALSE" in sql for sql in executed_sql))


if __name__ == "__main__":
    unittest.main()
