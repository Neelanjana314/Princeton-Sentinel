"""
Copilot Studio Agent telemetry ingestion via Application Insights REST API.

Queries custom events + dependencies from App Insights using KQL and upserts
data into copilot_* tables.

Copilot Studio event names (from cloud_RoleName == "Microsoft Copilot Studio"):
  - BotMessageReceived / BotMessageSend
  - TopicStart / TopicEnd
  - OnErrorLog
  - Dependencies (tool/connector calls)

Key dimensions:
  - conversationId, channelId, designMode, cloud_RoleInstance (agent name)
  - user_Id (built-in App Insights user ID)
  - TopicName, ErrorMessage, ErrorCode
"""

import json
import time
from datetime import datetime, timezone, timedelta

import requests

from app import db
from app.jobs.mv_refresh import enqueue_impacted_mvs_for_tables
from app.runtime_config import get_runtime_env
from app.runtime_logger import emit
from app.utils import log_job_run_log

APPINSIGHTS_BASE = "https://api.applicationinsights.io/v1/apps"
APPINSIGHTS_APP_ID = ""
APPINSIGHTS_API_KEY = ""

DEFAULT_LOOKBACK_HOURS = 24


def _get_appinsights_credentials() -> tuple[str, str]:
    app_id = (get_runtime_env("APPINSIGHTS_APP_ID") or APPINSIGHTS_APP_ID).strip()
    api_key = (get_runtime_env("APPINSIGHTS_API_KEY") or APPINSIGHTS_API_KEY).strip()
    return app_id, api_key


def run_copilot_telemetry(*, run_id: str, job_id: str, actor=None):
    appinsights_app_id, appinsights_api_key = _get_appinsights_credentials()
    if not appinsights_app_id or not appinsights_api_key:
        emit("WARN", "COPILOT_TELEMETRY", "APPINSIGHTS_APP_ID or APPINSIGHTS_API_KEY not set, skipping")
        log_job_run_log(run_id=run_id, level="WARN", message="copilot_telemetry_skipped",
                        context={"reason": "APPINSIGHTS_APP_ID or APPINSIGHTS_API_KEY not set"})
        return

    # Read lookback from job config (allows one-time backfill via DB update)
    lookback_hours = DEFAULT_LOOKBACK_HOURS
    try:
        row = db.fetch_one(
            "SELECT config FROM jobs WHERE job_id = %s", (job_id,)
        )
        if row and row.get("config"):
            cfg = row["config"] if isinstance(row["config"], dict) else json.loads(row["config"])
            lookback_hours = int(cfg.get("lookback_hours", DEFAULT_LOOKBACK_HOURS))
    except Exception:
        pass  # fall back to default
    since = datetime.now(timezone.utc) - timedelta(hours=lookback_hours)
    since_iso = since.strftime("%Y-%m-%dT%H:%M:%SZ")

    job_start = time.monotonic()
    log_job_run_log(run_id=run_id, level="INFO", message="copilot_telemetry_started",
                    context={"job_id": job_id, "lookback_hours": lookback_hours, "since": since_iso})

    # --- Stage 1: Conversation sessions ---
    queued_mvs_summary = {"tables": [], "queued": 0, "queued_mvs": []}
    sessions = _fetch_sessions(since_iso)
    if sessions:
        _upsert_sessions(sessions)
        try:
            queued_mvs_summary = enqueue_impacted_mvs_for_tables(["copilot_sessions"])
            emit(
                "INFO",
                "COPILOT_TELEMETRY",
                f"Queued impacted MVs after session upsert: queued={queued_mvs_summary.get('queued', 0)} tables={queued_mvs_summary.get('tables', [])}",
            )
        except Exception as exc:
            emit("WARN", "COPILOT_TELEMETRY", f"Failed to queue impacted MVs after session upsert: error={exc}")

    # --- Stage 2: Raw events ---
    events = _fetch_events(since_iso)
    if events:
        _insert_events(events)

    # --- Stage 3: Errors ---
    errors = _fetch_errors(since_iso)
    if errors:
        _insert_errors(errors)

    # --- Stage 4: Topic performance ---
    topics = _fetch_topic_performance(since_iso)
    if topics:
        _upsert_topics(_aggregate_topics(topics))
        _upsert_topics_hourly(topics)

    # --- Stage 5: Tool/connector performance ---
    tools = _fetch_tool_performance(since_iso)
    if tools:
        _upsert_tools(_aggregate_tools(tools))
        _upsert_tools_hourly(tools)

    # --- Stage 6: Agent response time ---
    response_times = _fetch_response_times(since_iso)
    if response_times:
        _upsert_response_times(response_times)

    # --- Summary ---
    log_job_run_log(run_id=run_id, level="INFO", message="copilot_telemetry_completed", context={
        "job_id": job_id,
        "lookback_hours": lookback_hours,
        "duration_sec": round(time.monotonic() - job_start, 2),
        "sessions": len(sessions),
        "events": len(events),
        "errors": len(errors),
        "topics": len(topics),
        "tools": len(tools),
        "response_times": len(response_times),
        "mv_refresh_queue": queued_mvs_summary,
    })


# ---------------------------------------------------------------------------
# KQL queries — aligned with actual Copilot Studio App Insights schema
# ---------------------------------------------------------------------------

def _fetch_sessions(since_iso: str) -> list[dict]:
    query = f"""
    customEvents
    | where timestamp > datetime('{since_iso}')
    | where itemType == "customEvent" and cloud_RoleName == "Microsoft Copilot Studio"
    | where cloud_RoleInstance != "Agent"
    | extend
        conversationId = tostring(customDimensions.conversationId),
        channelId = tostring(customDimensions.channelId),
        isDesignMode = coalesce(tostring(customDimensions.DesignMode), tostring(customDimensions.designMode))
    | where isnotempty(conversationId)
    | extend fromName = tostring(customDimensions.fromName)
    | summarize
        started_at = min(timestamp),
        ended_at = max(timestamp),
        turn_count = countif(name == 'BotMessageReceived'),
        agent_name = take_any(cloud_RoleInstance),
        channel = take_any(channelId),
        is_design_mode = take_any(isDesignMode),
        user_id = take_any(user_Id),
        user_name = take_anyif(fromName, isnotempty(fromName)),
        event_count = count(),
        error_count = countif(name == 'OnErrorLog')
      by conversationId
    | project conversationId, agent_name, channel, started_at, ended_at,
              turn_count, is_design_mode, user_id, user_name, event_count, error_count
    """
    return _run_kql(query)


def _fetch_events(since_iso: str) -> list[dict]:
    query = f"""
    customEvents
    | where timestamp > datetime('{since_iso}')
    | where itemType == "customEvent" and cloud_RoleName == "Microsoft Copilot Studio"
    | where cloud_RoleInstance != "Agent"
    | where name in ('BotMessageReceived', 'BotMessageSend', 'TopicStart',
                     'TopicEnd', 'OnErrorLog')
    | extend conversationId = tostring(customDimensions.conversationId)
    | where isnotempty(conversationId)
    | project event_name = name, event_ts = timestamp,
              session_id = conversationId,
              properties = customDimensions
    | order by event_ts asc
    """
    return _run_kql(query)


def _fetch_errors(since_iso: str) -> list[dict]:
    query = f"""
    customEvents
    | where timestamp > datetime('{since_iso}')
    | where itemType == "customEvent" and cloud_RoleName == "Microsoft Copilot Studio"
    | where cloud_RoleInstance != "Agent"
    | where name == "OnErrorLog"
    | extend
        conversationId = tostring(customDimensions.conversationId),
        errorMessage = tostring(customDimensions.ErrorMessage),
        errorCode = tostring(customDimensions.ErrorCode),
        channelId = tostring(customDimensions.channelId),
        agent_name = cloud_RoleInstance
    | where isnotempty(conversationId)
    | project timestamp, conversationId, agent_name, channelId,
              errorCode, errorMessage
    | order by timestamp asc
    """
    return _run_kql(query)


def _fetch_topic_performance(since_iso: str) -> list[dict]:
    query = f"""
    let topicEvents = customEvents
    | where timestamp > datetime('{since_iso}')
    | where itemType == "customEvent" and cloud_RoleName == "Microsoft Copilot Studio"
    | where name in ("TopicStart", "TopicEnd")
    | where cloud_RoleInstance != "Agent"
    | extend
        conversationId = tostring(customDimensions.conversationId),
        topicName = tostring(customDimensions.TopicName)
    | where isnotempty(topicName) and isnotempty(conversationId);
    topicEvents
    | order by conversationId, timestamp asc
    | extend
        PrevEvent = iff(prev(conversationId) == conversationId, prev(name), ""),
        PrevTopicName = iff(prev(conversationId) == conversationId, prev(topicName), ""),
        PrevTimestamp = iff(prev(conversationId) == conversationId, prev(timestamp), datetime(null))
    | where name == "TopicEnd"
        and PrevEvent == "TopicStart"
        and PrevTopicName == topicName
        and isnotnull(PrevTimestamp)
    | extend TopicDuration = timestamp - PrevTimestamp
    | where TopicDuration >= 0s and TopicDuration <= 5m
    | summarize
        avg_duration_sec = round(avg(TopicDuration) / 1s, 2),
        median_duration_sec = round(percentile(TopicDuration, 50) / 1s, 2),
        max_duration_sec = round(max(TopicDuration) / 1s, 2),
        execution_count = count()
      by topicName, bot_id = cloud_RoleInstance,
         channel = tostring(customDimensions.channelId),
         is_test = iff(tolower(tostring(customDimensions.DesignMode)) == "true", true, false),
         time_bucket = bin(PrevTimestamp, 1h)
    | project topicName, bot_id, channel, is_test, time_bucket, avg_duration_sec,
              median_duration_sec, max_duration_sec, execution_count
    """
    return _run_kql(query)


def _fetch_response_times(since_iso: str) -> list[dict]:
    query = f"""
    let messageEvents = customEvents
    | where timestamp > datetime('{since_iso}')
    | where itemType == "customEvent" and cloud_RoleName == "Microsoft Copilot Studio"
    | where name in ("BotMessageReceived", "BotMessageSend")
    | where cloud_RoleInstance != "Agent"
    | extend
        conversationId = tostring(customDimensions.conversationId),
        messageType = tostring(customDimensions.type),
        messageText = tostring(customDimensions.text)
    | where isnotempty(conversationId)
    | where (name == "BotMessageReceived" and messageType in ("message", "event")) or
            (name == "BotMessageSend" and isnotempty(messageText));
    messageEvents
    | order by conversationId, timestamp asc
    | extend
        PrevEvent = iff(prev(conversationId) == conversationId, prev(name), ""),
        PrevTimestamp = iff(prev(conversationId) == conversationId, prev(timestamp), datetime(null))
    | where name == "BotMessageSend"
        and PrevEvent == "BotMessageReceived"
        and isnotnull(PrevTimestamp)
    | extend ResponseTimeSec = round(datetime_diff('millisecond', timestamp, PrevTimestamp) / 1000.0, 2)
    | where ResponseTimeSec > 0 and ResponseTimeSec <= 120
    | summarize
        avg_response_sec = round(avg(ResponseTimeSec), 2),
        p50_response_sec = round(percentile(ResponseTimeSec, 50), 2),
        p95_response_sec = round(percentile(ResponseTimeSec, 95), 2),
        p99_response_sec = round(percentile(ResponseTimeSec, 99), 2),
        total_responses = count()
      by time_bucket = bin(PrevTimestamp, 1h), bot_id = cloud_RoleInstance,
         channel = tostring(customDimensions.channelId),
         is_test = iff(tolower(tostring(customDimensions.DesignMode)) == "true", true, false)
    | order by time_bucket asc
    """
    return _run_kql(query)


def _fetch_tool_performance(since_iso: str) -> list[dict]:
    query = f"""
    dependencies
    | where timestamp > datetime('{since_iso}')
    | where itemType == "dependency" and cloud_RoleName == "Microsoft Copilot Studio"
    | where cloud_RoleInstance != "Agent"
    | extend conversationId = tostring(customDimensions.conversationId)
    | where isnotempty(conversationId)
    | where isnotempty(name)
    | summarize
        total_calls = count(),
        successful_calls = countif(success == true),
        failed_calls = countif(success == false),
        avg_duration_sec = round(avg(duration) / 1000.0, 2),
        p50_duration_sec = round(percentile(duration, 50) / 1000.0, 2),
        p95_duration_sec = round(percentile(duration, 95) / 1000.0, 2),
        unique_conversations = dcount(conversationId)
      by tool_name = name, tool_type = type, bot_id = cloud_RoleInstance,
         channel = tostring(customDimensions.channelId),
         is_test = iff(tolower(tostring(customDimensions.DesignMode)) == "true", true, false),
         time_bucket = bin(timestamp, 1h)
    | extend success_rate = round(successful_calls * 100.0 / total_calls, 2)
    | project tool_name, tool_type, bot_id, channel, is_test, time_bucket, total_calls,
              successful_calls, failed_calls, success_rate, avg_duration_sec,
              p50_duration_sec, p95_duration_sec, unique_conversations
    """
    return _run_kql(query)


# ---------------------------------------------------------------------------
# App Insights REST API
# ---------------------------------------------------------------------------

def _run_kql(kql: str) -> list[dict]:
    appinsights_app_id, appinsights_api_key = _get_appinsights_credentials()
    if not appinsights_app_id or not appinsights_api_key:
        raise RuntimeError("APPINSIGHTS_APP_ID or APPINSIGHTS_API_KEY not set")

    url = f"{APPINSIGHTS_BASE}/{appinsights_app_id}/query"
    headers = {"x-api-key": appinsights_api_key, "Content-Type": "application/json"}
    body = {"query": kql}

    try:
        resp = requests.post(url, json=body, headers=headers, timeout=60)
        resp.raise_for_status()
    except requests.RequestException as exc:
        emit("ERROR", "COPILOT_TELEMETRY", f"App Insights query failed: {exc}")
        raise

    data = resp.json()
    tables = data.get("tables", [])
    if not tables:
        return []

    columns = [col["name"] for col in tables[0].get("columns", [])]
    rows = tables[0].get("rows", [])
    return [dict(zip(columns, row)) for row in rows]


# ---------------------------------------------------------------------------
# DB upserts
# ---------------------------------------------------------------------------

def _upsert_sessions(sessions: list[dict]):
    conn = db.get_conn()
    try:
        cur = conn.cursor()
        values = []
        for s in sessions:
            is_test = str(s.get("is_design_mode", "")).lower() in ("true", "1")
            values.append((
                s.get("conversationId", ""),
                s.get("agent_name", ""),
                s.get("agent_name", ""),
                s.get("channel", ""),
                s.get("started_at"),
                s.get("ended_at"),
                _classify_outcome(int(s.get("turn_count", 0)), int(s.get("error_count", 0))),
                int(s.get("turn_count", 0)),
                s.get("user_id", ""),
                s.get("user_name") or None,
                is_test,
            ))
        db.execute_values(
            cur,
            """
            INSERT INTO copilot_sessions
                (session_id, bot_id, bot_name, channel, started_at, ended_at,
                 outcome, turn_count, user_id, user_name, is_test)
            VALUES %s
            ON CONFLICT (session_id) DO UPDATE SET
                bot_id     = EXCLUDED.bot_id,
                bot_name   = EXCLUDED.bot_name,
                channel    = EXCLUDED.channel,
                started_at = LEAST(copilot_sessions.started_at, EXCLUDED.started_at),
                ended_at   = GREATEST(copilot_sessions.ended_at, EXCLUDED.ended_at),
                outcome    = EXCLUDED.outcome,
                turn_count = GREATEST(copilot_sessions.turn_count, EXCLUDED.turn_count),
                user_id    = COALESCE(NULLIF(EXCLUDED.user_id, ''), copilot_sessions.user_id),
                user_name  = COALESCE(NULLIF(EXCLUDED.user_name, ''), copilot_sessions.user_name),
                is_test    = EXCLUDED.is_test,
                synced_at  = now()
            """,
            values,
        )
        conn.commit()
    finally:
        conn.close()


def _insert_events(events: list[dict]):
    conn = db.get_conn()
    try:
        cur = conn.cursor()
        values = []
        for e in events:
            props = e.get("properties")
            if isinstance(props, str):
                try:
                    props = json.loads(props)
                except (json.JSONDecodeError, TypeError):
                    props = {}
            values.append((
                e.get("session_id", ""),
                e.get("event_name", ""),
                e.get("event_ts"),
                db.jsonb(props or {}),
            ))
        db.execute_values(
            cur,
            """
            INSERT INTO copilot_events (session_id, event_name, event_ts, properties)
            VALUES %s
            ON CONFLICT (session_id, event_name, event_ts) DO NOTHING
            """,
            values,
        )
        conn.commit()
    finally:
        conn.close()


def _insert_errors(errors: list[dict]):
    conn = db.get_conn()
    try:
        cur = conn.cursor()
        values = []
        for e in errors:
            values.append((
                e.get("conversationId", ""),
                e.get("agent_name", ""),
                e.get("channelId", ""),
                e.get("errorCode", ""),
                e.get("errorMessage", ""),
                e.get("timestamp"),
            ))
        db.execute_values(
            cur,
            """
            INSERT INTO copilot_errors
                (session_id, agent_name, channel, error_code, error_message, error_ts)
            VALUES %s
            ON CONFLICT (session_id, error_code, error_ts) DO NOTHING
            """,
            values,
        )
        conn.commit()
    finally:
        conn.close()


def _aggregate_topics(topics: list[dict]) -> list[dict]:
    """Collapse hourly-bucketed topic rows into one aggregate row per topic name."""
    agg: dict[str, dict] = {}
    for t in topics:
        name = t.get("topicName", "")
        count = int(t.get("execution_count", 0))
        if name not in agg:
            agg[name] = {"total_count": 0, "weighted_avg": 0.0,
                         "weighted_median": 0.0, "max_duration_sec": 0.0}
        agg[name]["total_count"] += count
        agg[name]["weighted_avg"] += float(t.get("avg_duration_sec", 0)) * count
        agg[name]["weighted_median"] += float(t.get("median_duration_sec", 0)) * count
        agg[name]["max_duration_sec"] = max(
            agg[name]["max_duration_sec"], float(t.get("max_duration_sec", 0))
        )
    result = []
    for name, d in agg.items():
        c = d["total_count"] or 1
        result.append({
            "topicName": name,
            "avg_duration_sec": round(d["weighted_avg"] / c, 2),
            "median_duration_sec": round(d["weighted_median"] / c, 2),
            "max_duration_sec": round(d["max_duration_sec"], 2),
            "execution_count": d["total_count"],
        })
    return result


def _aggregate_tools(tools: list[dict]) -> list[dict]:
    """Collapse hourly-bucketed tool rows into one aggregate row per tool name."""
    agg: dict[str, dict] = {}
    for t in tools:
        name = t.get("tool_name", "")
        total = int(t.get("total_calls", 0))
        if name not in agg:
            agg[name] = {"tool_type": t.get("tool_type", ""), "total_calls": 0,
                         "successful_calls": 0, "failed_calls": 0,
                         "weighted_avg": 0.0, "weighted_p50": 0.0,
                         "weighted_p95": 0.0, "unique_conversations": 0}
        agg[name]["total_calls"] += total
        agg[name]["successful_calls"] += int(t.get("successful_calls", 0))
        agg[name]["failed_calls"] += int(t.get("failed_calls", 0))
        agg[name]["weighted_avg"] += float(t.get("avg_duration_sec", 0)) * total
        agg[name]["weighted_p50"] += float(t.get("p50_duration_sec", 0)) * total
        agg[name]["weighted_p95"] += float(t.get("p95_duration_sec", 0)) * total
        agg[name]["unique_conversations"] += int(t.get("unique_conversations", 0))
    result = []
    for name, d in agg.items():
        c = d["total_calls"] or 1
        success_rate = round(d["successful_calls"] * 100.0 / c, 2)
        result.append({
            "tool_name": name,
            "tool_type": d["tool_type"],
            "total_calls": d["total_calls"],
            "successful_calls": d["successful_calls"],
            "failed_calls": d["failed_calls"],
            "success_rate": success_rate,
            "avg_duration_sec": round(d["weighted_avg"] / c, 2),
            "p50_duration_sec": round(d["weighted_p50"] / c, 2),
            "p95_duration_sec": round(d["weighted_p95"] / c, 2),
            "unique_conversations": d["unique_conversations"],
        })
    return result


def _upsert_topics(topics: list[dict]):
    conn = db.get_conn()
    try:
        cur = conn.cursor()
        values = []
        for t in topics:
            values.append((
                t.get("topicName", ""),
                float(t.get("avg_duration_sec", 0)),
                float(t.get("median_duration_sec", 0)),
                float(t.get("max_duration_sec", 0)),
                int(t.get("execution_count", 0)),
            ))
        db.execute_values(
            cur,
            """
            INSERT INTO copilot_topic_stats
                (topic_name, avg_duration_sec, median_duration_sec,
                 max_duration_sec, execution_count)
            VALUES %s
            ON CONFLICT (topic_name) DO UPDATE SET
                avg_duration_sec    = EXCLUDED.avg_duration_sec,
                median_duration_sec = EXCLUDED.median_duration_sec,
                max_duration_sec    = EXCLUDED.max_duration_sec,
                execution_count     = EXCLUDED.execution_count,
                synced_at           = now()
            """,
            values,
        )
        conn.commit()
    finally:
        conn.close()


def _upsert_tools(tools: list[dict]):
    conn = db.get_conn()
    try:
        cur = conn.cursor()
        values = []
        for t in tools:
            values.append((
                t.get("tool_name", ""),
                t.get("tool_type", ""),
                int(t.get("total_calls", 0)),
                int(t.get("successful_calls", 0)),
                int(t.get("failed_calls", 0)),
                float(t.get("success_rate", 0)),
                float(t.get("avg_duration_sec", 0)),
                float(t.get("p50_duration_sec", 0)),
                float(t.get("p95_duration_sec", 0)),
                int(t.get("unique_conversations", 0)),
            ))
        db.execute_values(
            cur,
            """
            INSERT INTO copilot_tool_stats
                (tool_name, tool_type, total_calls, successful_calls,
                 failed_calls, success_rate, avg_duration_sec,
                 p50_duration_sec, p95_duration_sec, unique_conversations)
            VALUES %s
            ON CONFLICT (tool_name) DO UPDATE SET
                tool_type            = EXCLUDED.tool_type,
                total_calls          = EXCLUDED.total_calls,
                successful_calls     = EXCLUDED.successful_calls,
                failed_calls         = EXCLUDED.failed_calls,
                success_rate         = EXCLUDED.success_rate,
                avg_duration_sec     = EXCLUDED.avg_duration_sec,
                p50_duration_sec     = EXCLUDED.p50_duration_sec,
                p95_duration_sec     = EXCLUDED.p95_duration_sec,
                unique_conversations = EXCLUDED.unique_conversations,
                synced_at            = now()
            """,
            values,
        )
        conn.commit()
    finally:
        conn.close()


def _upsert_topics_hourly(topics: list[dict]):
    conn = db.get_conn()
    try:
        cur = conn.cursor()
        values = []
        for t in topics:
            if not t.get("time_bucket") or not t.get("bot_id"):
                continue
            values.append((
                t.get("topicName", ""),
                t.get("bot_id", ""),
                t.get("channel") or "",
                bool(t.get("is_test", False)),
                t.get("time_bucket"),
                float(t.get("avg_duration_sec", 0)),
                float(t.get("median_duration_sec", 0)),
                float(t.get("max_duration_sec", 0)),
                int(t.get("execution_count", 0)),
            ))
        if not values:
            return
        db.execute_values(
            cur,
            """
            INSERT INTO copilot_topic_stats_hourly
                (topic_name, bot_id, channel, is_test, time_bucket, avg_duration_sec,
                 median_duration_sec, max_duration_sec, execution_count)
            VALUES %s
            ON CONFLICT (topic_name, bot_id, channel, is_test, time_bucket) DO UPDATE SET
                avg_duration_sec    = EXCLUDED.avg_duration_sec,
                median_duration_sec = EXCLUDED.median_duration_sec,
                max_duration_sec    = EXCLUDED.max_duration_sec,
                execution_count     = EXCLUDED.execution_count,
                synced_at           = now()
            """,
            values,
        )
        conn.commit()
    finally:
        conn.close()


def _upsert_tools_hourly(tools: list[dict]):
    conn = db.get_conn()
    try:
        cur = conn.cursor()
        values = []
        for t in tools:
            if not t.get("time_bucket") or not t.get("bot_id"):
                continue
            values.append((
                t.get("tool_name", ""),
                t.get("bot_id", ""),
                t.get("channel") or "",
                bool(t.get("is_test", False)),
                t.get("time_bucket"),
                t.get("tool_type", ""),
                int(t.get("total_calls", 0)),
                int(t.get("successful_calls", 0)),
                int(t.get("failed_calls", 0)),
                float(t.get("success_rate", 0)),
                float(t.get("avg_duration_sec", 0)),
                float(t.get("p50_duration_sec", 0)),
                float(t.get("p95_duration_sec", 0)),
                int(t.get("unique_conversations", 0)),
            ))
        if not values:
            return
        db.execute_values(
            cur,
            """
            INSERT INTO copilot_tool_stats_hourly
                (tool_name, bot_id, channel, is_test, time_bucket, tool_type, total_calls,
                 successful_calls, failed_calls, success_rate, avg_duration_sec,
                 p50_duration_sec, p95_duration_sec, unique_conversations)
            VALUES %s
            ON CONFLICT (tool_name, bot_id, channel, is_test, time_bucket) DO UPDATE SET
                tool_type            = EXCLUDED.tool_type,
                total_calls          = EXCLUDED.total_calls,
                successful_calls     = EXCLUDED.successful_calls,
                failed_calls         = EXCLUDED.failed_calls,
                success_rate         = EXCLUDED.success_rate,
                avg_duration_sec     = EXCLUDED.avg_duration_sec,
                p50_duration_sec     = EXCLUDED.p50_duration_sec,
                p95_duration_sec     = EXCLUDED.p95_duration_sec,
                unique_conversations = EXCLUDED.unique_conversations,
                synced_at            = now()
            """,
            values,
        )
        conn.commit()
    finally:
        conn.close()


def _upsert_response_times(rows: list[dict]):
    conn = db.get_conn()
    try:
        cur = conn.cursor()
        values = []
        for r in rows:
            values.append((
                r.get("bot_id"),
                r.get("channel") or "",
                bool(r.get("is_test", False)),
                r.get("time_bucket"),
                float(r.get("avg_response_sec", 0)),
                float(r.get("p50_response_sec", 0)),
                float(r.get("p95_response_sec", 0)),
                float(r.get("p99_response_sec", 0)),
                int(r.get("total_responses", 0)),
            ))
        db.execute_values(
            cur,
            """
            INSERT INTO copilot_response_times
                (bot_id, channel, is_test, time_bucket, avg_response_sec, p50_response_sec,
                 p95_response_sec, p99_response_sec, total_responses)
            VALUES %s
            ON CONFLICT (bot_id, channel, is_test, time_bucket) DO UPDATE SET
                avg_response_sec  = EXCLUDED.avg_response_sec,
                p50_response_sec  = EXCLUDED.p50_response_sec,
                p95_response_sec  = EXCLUDED.p95_response_sec,
                p99_response_sec  = EXCLUDED.p99_response_sec,
                total_responses   = EXCLUDED.total_responses,
                synced_at         = now()
            """,
            values,
        )
        conn.commit()
    finally:
        conn.close()


def _classify_outcome(turn_count: int, error_count: int = 0) -> str:
    if turn_count == 0:
        return "abandoned"
    if error_count > 0:
        return "escalated"
    return "resolved"
