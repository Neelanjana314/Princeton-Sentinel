import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.jobs import copilot_telemetry


class CopilotTelemetryTests(unittest.TestCase):
    @patch("app.jobs.copilot_telemetry.emit")
    @patch("app.jobs.copilot_telemetry.log_job_run_log")
    @patch("app.jobs.copilot_telemetry.enqueue_impacted_mvs_for_tables")
    @patch("app.jobs.copilot_telemetry._upsert_response_times")
    @patch("app.jobs.copilot_telemetry._fetch_response_times", return_value=[])
    @patch("app.jobs.copilot_telemetry._upsert_tools")
    @patch("app.jobs.copilot_telemetry._fetch_tool_performance", return_value=[])
    @patch("app.jobs.copilot_telemetry._upsert_topics")
    @patch("app.jobs.copilot_telemetry._fetch_topic_performance", return_value=[])
    @patch("app.jobs.copilot_telemetry._insert_errors")
    @patch("app.jobs.copilot_telemetry._fetch_errors", return_value=[])
    @patch("app.jobs.copilot_telemetry._insert_events")
    @patch("app.jobs.copilot_telemetry._fetch_events", return_value=[])
    @patch("app.jobs.copilot_telemetry._upsert_sessions")
    @patch("app.jobs.copilot_telemetry._fetch_sessions")
    @patch("app.jobs.copilot_telemetry.db.fetch_one", return_value={"config": {"lookback_hours": 24}})
    @patch.object(copilot_telemetry, "APPINSIGHTS_APP_ID", "app-id")
    @patch.object(copilot_telemetry, "APPINSIGHTS_API_KEY", "api-key")
    def test_run_enqueues_impacted_mvs_after_session_upsert(
        self,
        _mock_fetch_one,
        mock_fetch_sessions,
        mock_upsert_sessions,
        _mock_fetch_events,
        _mock_insert_events,
        _mock_fetch_errors,
        _mock_insert_errors,
        _mock_fetch_topics,
        _mock_upsert_topics,
        _mock_fetch_tools,
        _mock_upsert_tools,
        _mock_fetch_response_times,
        _mock_upsert_response_times,
        mock_enqueue_impacted_mvs,
        mock_log_job_run_log,
        _mock_emit,
    ):
        sessions = [{"conversationId": "session-1", "started_at": "2026-03-13T00:00:00Z", "ended_at": "2026-03-13T00:05:00Z"}]
        mock_fetch_sessions.return_value = sessions
        mock_enqueue_impacted_mvs.return_value = {
            "tables": ["copilot_sessions"],
            "queued": 1,
            "queued_mvs": ["mv_copilot_summary"],
        }

        copilot_telemetry.run_copilot_telemetry(run_id="run-1", job_id="job-1")

        mock_upsert_sessions.assert_called_once_with(sessions)
        mock_enqueue_impacted_mvs.assert_called_once_with(["copilot_sessions"])
        self.assertEqual(mock_log_job_run_log.call_args.kwargs["context"]["mv_refresh_queue"]["queued_mvs"], ["mv_copilot_summary"])

    @patch("app.jobs.copilot_telemetry.emit")
    @patch("app.jobs.copilot_telemetry.log_job_run_log")
    @patch("app.jobs.copilot_telemetry.enqueue_impacted_mvs_for_tables")
    @patch("app.jobs.copilot_telemetry._upsert_response_times")
    @patch("app.jobs.copilot_telemetry._fetch_response_times", return_value=[])
    @patch("app.jobs.copilot_telemetry._upsert_tools")
    @patch("app.jobs.copilot_telemetry._fetch_tool_performance", return_value=[])
    @patch("app.jobs.copilot_telemetry._upsert_topics")
    @patch("app.jobs.copilot_telemetry._fetch_topic_performance", return_value=[])
    @patch("app.jobs.copilot_telemetry._insert_errors")
    @patch("app.jobs.copilot_telemetry._fetch_errors", return_value=[])
    @patch("app.jobs.copilot_telemetry._insert_events")
    @patch("app.jobs.copilot_telemetry._fetch_events", return_value=[])
    @patch("app.jobs.copilot_telemetry._upsert_sessions")
    @patch("app.jobs.copilot_telemetry._fetch_sessions", return_value=[])
    @patch("app.jobs.copilot_telemetry.db.fetch_one", return_value={"config": {"lookback_hours": 24}})
    @patch.object(copilot_telemetry, "APPINSIGHTS_APP_ID", "app-id")
    @patch.object(copilot_telemetry, "APPINSIGHTS_API_KEY", "api-key")
    def test_run_skips_mv_queue_when_no_sessions_were_ingested(
        self,
        _mock_fetch_one,
        _mock_fetch_sessions,
        mock_upsert_sessions,
        _mock_fetch_events,
        _mock_insert_events,
        _mock_fetch_errors,
        _mock_insert_errors,
        _mock_fetch_topics,
        _mock_upsert_topics,
        _mock_fetch_tools,
        _mock_upsert_tools,
        _mock_fetch_response_times,
        _mock_upsert_response_times,
        mock_enqueue_impacted_mvs,
        mock_log_job_run_log,
        _mock_emit,
    ):
        copilot_telemetry.run_copilot_telemetry(run_id="run-2", job_id="job-2")

        mock_upsert_sessions.assert_not_called()
        mock_enqueue_impacted_mvs.assert_not_called()
        self.assertEqual(mock_log_job_run_log.call_args.kwargs["context"]["mv_refresh_queue"]["queued"], 0)

if __name__ == "__main__":
    unittest.main()
