import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Optional

from psycopg2 import sql

from app import db
from app.runtime_logger import emit
from app.utils import log_audit_event, log_job_run_log


DEFAULT_MAX_VIEWS_PER_RUN = int(os.getenv("MV_REFRESH_MAX_VIEWS_PER_RUN", "20"))
_MV_NAME_PATTERN = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


def _normalize_table_names(table_names: Iterable[str]) -> list[str]:
    return sorted({str(name).strip() for name in table_names if str(name).strip()})


def _get_mv_refresh_runtime_config(job_id: str) -> Dict[str, Any]:
    row = db.fetch_one("SELECT config FROM jobs WHERE job_id = %s", [job_id]) or {}
    config = row.get("config") if isinstance(row, dict) else {}
    if not isinstance(config, dict):
        config = {}
    max_views_per_run = int(config.get("max_views_per_run", DEFAULT_MAX_VIEWS_PER_RUN))
    return {"max_views_per_run": max(1, min(max_views_per_run, 200))}


def enqueue_impacted_mvs_for_tables(table_names: Iterable[str]) -> Dict[str, Any]:
    normalized_tables = _normalize_table_names(table_names)
    if not normalized_tables:
        return {"tables": [], "queued": 0, "queued_mvs": []}

    conn = db.get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            WITH impacted AS (
              SELECT DISTINCT mv_name
              FROM mv_dependencies
              WHERE table_name = ANY(%s::text[])
            ),
            queued AS (
              INSERT INTO mv_refresh_queue (mv_name, dirty_since)
              SELECT mv_name, now()
              FROM impacted
              ON CONFLICT (mv_name) DO NOTHING
              RETURNING mv_name
            )
            SELECT mv_name
            FROM queued
            ORDER BY mv_name
            """,
            [normalized_tables],
        )
        rows = cur.fetchall()
        conn.commit()
    finally:
        conn.close()

    queued_mvs = [row[0] for row in rows]
    return {"tables": normalized_tables, "queued": len(queued_mvs), "queued_mvs": queued_mvs}


def _refresh_mv_concurrently(mv_name: str):
    if not _MV_NAME_PATTERN.match(mv_name):
        raise ValueError(f"invalid_mv_name:{mv_name}")

    conn = db.get_conn()
    try:
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute(
            sql.SQL("REFRESH MATERIALIZED VIEW CONCURRENTLY {}").format(sql.Identifier(mv_name))
        )
    finally:
        conn.close()


def run_mv_refresh(*, run_id: str, job_id: str, actor: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    config = _get_mv_refresh_runtime_config(job_id)
    max_views_per_run = int(config.get("max_views_per_run", DEFAULT_MAX_VIEWS_PER_RUN))

    conn = db.get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT q.mv_name, q.dirty_since, q.attempts
            FROM mv_refresh_queue q
            JOIN (SELECT DISTINCT mv_name FROM mv_dependencies) d ON d.mv_name = q.mv_name
            ORDER BY q.dirty_since ASC, q.mv_name ASC
            LIMIT %s
            """,
            [max_views_per_run],
        )
        pending_rows = cur.fetchall()
        conn.commit()
    finally:
        conn.close()

    summary: Dict[str, Any] = {
        "max_views_per_run": max_views_per_run,
        "pending_seen": len(pending_rows),
        "attempted": 0,
        "refreshed": 0,
        "failed": 0,
        "refreshed_mvs": [],
        "failed_mvs": [],
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }

    emit(
        "INFO",
        "SCHEDULER",
        f"MV refresh run started: run_id={run_id} job_id={job_id} pending={len(pending_rows)} limit={max_views_per_run}",
    )
    log_job_run_log(
        run_id=run_id,
        level="INFO",
        message="mv_refresh_started",
        context={"job_id": job_id, "pending": len(pending_rows), "max_views_per_run": max_views_per_run},
    )

    for mv_name, _, _ in pending_rows:
        summary["attempted"] += 1
        db.execute(
            "UPDATE mv_refresh_queue SET last_attempt_at = now(), attempts = attempts + 1 WHERE mv_name = %s",
            [mv_name],
        )
        try:
            _refresh_mv_concurrently(mv_name)
            db.execute(
                """
                INSERT INTO mv_refresh_log (mv_name, last_refreshed_at)
                VALUES (%s, now())
                ON CONFLICT (mv_name)
                DO UPDATE SET last_refreshed_at = EXCLUDED.last_refreshed_at
                """,
                [mv_name],
            )
            db.execute("DELETE FROM mv_refresh_queue WHERE mv_name = %s", [mv_name])
            summary["refreshed"] += 1
            summary["refreshed_mvs"].append(mv_name)
            emit("INFO", "SCHEDULER", f"MV refreshed: mv_name={mv_name}")
        except Exception as exc:
            summary["failed"] += 1
            summary["failed_mvs"].append({"mv_name": mv_name, "error": str(exc)})
            emit("WARN", "SCHEDULER", f"MV refresh failed: mv_name={mv_name} error={exc}")

    log_job_run_log(
        run_id=run_id,
        level="INFO" if summary["failed"] == 0 else "WARN",
        message="mv_refresh_completed",
        context={"job_id": job_id, "summary": summary},
    )
    log_audit_event(
        action="mv_refresh_completed",
        entity_type="job_run",
        entity_id=run_id,
        actor=actor,
        details={"job_id": job_id, "summary": summary},
    )
    emit(
        "INFO",
        "SCHEDULER",
        f"MV refresh run finished: run_id={run_id} job_id={job_id} refreshed={summary['refreshed']} failed={summary['failed']}",
    )
    return summary
