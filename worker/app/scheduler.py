import os
import json
import threading
import time
from datetime import datetime, timezone

from croniter import croniter

from app import db
from app.jobs.graph_ingest import run_graph_ingest
from app.jobs.mv_refresh import run_mv_refresh
from app.jobs.copilot_telemetry import run_copilot_telemetry
from app.jobs.copilot_usage_sync import run_copilot_usage_sync
from app.license import LicenseFeatureError, get_job_type_license_feature, require_license_feature
from app.runtime_logger import emit
from app.utils import log_audit_event, log_job_run_log

SCHEDULER_POLL_SECONDS = int(os.getenv("SCHEDULER_POLL_SECONDS", "30"))
RECOVER_INTERRUPTED_RUNS_ON_STARTUP = os.getenv("RECOVER_INTERRUPTED_RUNS_ON_STARTUP", "true").strip().lower() in {
    "1",
    "true",
    "t",
    "yes",
    "y",
    "on",
}

_scheduler_status = {
    "running": False,
    "last_tick": None,
    "last_error": None,
}

INTERRUPTED_RUN_ERROR = "interrupted_worker_restart"


def get_scheduler_status():
    return _scheduler_status


def start_scheduler_thread():
    thread = threading.Thread(target=_scheduler_loop, daemon=True)
    thread.start()
    emit("INFO", "SCHEDULER", "Scheduler thread started")


def _scheduler_loop():
    _scheduler_status["running"] = True
    if RECOVER_INTERRUPTED_RUNS_ON_STARTUP:
        try:
            recovered = _recover_interrupted_runs()
            if recovered:
                emit("WARN", "SCHEDULER", f"Recovered interrupted runs at startup: count={recovered}")
        except Exception as exc:
            emit("ERROR", "SCHEDULER", f"Failed recovering interrupted runs: error={exc}")
    while True:
        _scheduler_status["last_tick"] = datetime.now(timezone.utc).isoformat()
        try:
            _run_due_schedule()
            _scheduler_status["last_error"] = None
        except Exception as exc:
            _scheduler_status["last_error"] = str(exc)
            emit("ERROR", "SCHEDULER", f"Scheduler loop failure: error={exc}")
        time.sleep(SCHEDULER_POLL_SECONDS)


def _run_due_schedule():
    conn = db.get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT schedule_id, job_id, cron_expr
            FROM job_schedules
            WHERE enabled = true
              AND next_run_at IS NULL
            ORDER BY schedule_id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
            """
        )
        row = cur.fetchone()
        if row:
            schedule_id, job_id, cron_expr = row
            try:
                next_run_at = _compute_next_run(cron_expr)
            except Exception as exc:
                conn.rollback()
                _disable_invalid_schedule(
                    schedule_id=schedule_id,
                    job_id=job_id,
                    cron_expr=cron_expr,
                    error_reason=f"invalid_cron_expr: {exc}",
                )
                return
            cur.execute(
                "UPDATE job_schedules SET next_run_at = %s WHERE schedule_id = %s",
                [next_run_at, schedule_id],
            )
            conn.commit()
            emit(
                "INFO",
                "SCHEDULER",
                f"New schedule picked up: schedule_id={schedule_id} next_run_at={next_run_at.isoformat()}",
            )
            return

        cur.execute(
            """
            SELECT js.schedule_id, js.job_id, js.cron_expr, j.job_type
            FROM job_schedules js
            JOIN jobs j ON j.job_id = js.job_id
            WHERE js.enabled = true
              AND j.enabled = true
              AND js.next_run_at <= now()
            ORDER BY js.next_run_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
            """
        )
        row = cur.fetchone()
        if not row:
            conn.rollback()
            return

        schedule_id, job_id, cron_expr, job_type = row
        try:
            next_run_at = _compute_next_run(cron_expr)
        except Exception as exc:
            conn.rollback()
            _disable_invalid_schedule(
                schedule_id=schedule_id,
                job_id=job_id,
                cron_expr=cron_expr,
                error_reason=f"invalid_cron_expr: {exc}",
            )
            return

        feature_key = get_job_type_license_feature(job_type)
        if feature_key:
            try:
                require_license_feature(feature_key)
            except LicenseFeatureError as exc:
                cur.execute(
                    "UPDATE job_schedules SET next_run_at = %s WHERE schedule_id = %s",
                    [next_run_at, schedule_id],
                )
                conn.commit()
                emit(
                    "WARN",
                    "SCHEDULER",
                    f"Scheduled job blocked by license: job_id={job_id} job_type={job_type} feature={feature_key} error={exc}",
                )
                log_audit_event(
                    action="job_run_blocked_license",
                    entity_type="job",
                    entity_id=str(job_id),
                    actor=None,
                    details={"job_type": job_type, "trigger": "schedule", "feature": feature_key, "error": str(exc)},
                )
                return

        locked = db.try_advisory_lock(cur, str(job_id))
        if not locked:
            conn.rollback()
            emit(
                "WARN",
                "SCHEDULER",
                f"Scheduled job skipped: advisory lock unavailable job_id={job_id}",
            )
            return

        run_id = _insert_job_run(cur, job_id)
        cur.execute(
            "UPDATE job_schedules SET next_run_at = %s WHERE schedule_id = %s",
            [next_run_at, schedule_id],
        )
        conn.commit()
        emit(
            "INFO",
            "SCHEDULER",
            f"Scheduled job triggered: job_id={job_id} job_type={job_type} run_id={run_id}",
        )

        log_audit_event(
            action="job_run_started",
            entity_type="job_run",
            entity_id=str(run_id),
            actor=None,
            details={"job_id": str(job_id), "job_type": job_type, "trigger": "schedule"},
        )

        status, error = _execute_job(job_type, run_id=str(run_id), job_id=str(job_id), actor_claims=None)

        cur.execute(
            "UPDATE job_runs SET finished_at = now(), status = %s, error = %s WHERE run_id = %s",
            [status, error, run_id],
        )
        db.advisory_unlock(cur, str(job_id))
        conn.commit()
        if status == "success":
            emit(
                "INFO",
                "SCHEDULER",
                f"Scheduled job finished: job_id={job_id} job_type={job_type} run_id={run_id} status={status}",
            )
        else:
            emit(
                "ERROR",
                "SCHEDULER",
                f"Scheduled job finished: job_id={job_id} job_type={job_type} run_id={run_id} status={status} error={error}",
            )

        log_audit_event(
            action="job_run_%s" % ("succeeded" if status == "success" else "failed"),
            entity_type="job_run",
            entity_id=str(run_id),
            actor=None,
            details={"job_id": str(job_id), "job_type": job_type, "trigger": "schedule", "error": error},
        )

        log_job_run_log(
            run_id=str(run_id),
            level="INFO" if status == "success" else "ERROR",
            message="job_finished",
            context={"job_id": str(job_id), "job_type": job_type, "trigger": "schedule", "status": status, "error": error},
        )
    finally:
        conn.close()


def _disable_invalid_schedule(*, schedule_id, job_id, cron_expr, error_reason: str):
    schedule_id = str(schedule_id)
    job_id = str(job_id) if job_id is not None else None
    cron_expr = str(cron_expr or "")
    short_error = str(error_reason or "invalid_cron_expr").replace("\n", " ").replace("\r", " ").strip()
    if len(short_error) > 300:
        short_error = short_error[:297] + "..."
    run_id = None

    conn = db.get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE job_schedules
            SET enabled = false,
                next_run_at = NULL
            WHERE schedule_id = %s
            RETURNING schedule_id
            """,
            [schedule_id],
        )
        row = cur.fetchone()
        if not row:
            conn.rollback()
            return

        if job_id:
            cur.execute(
                """
                INSERT INTO job_runs (run_id, job_id, started_at, finished_at, status, error)
                VALUES (gen_random_uuid(), %s, now(), now(), 'failed', %s)
                RETURNING run_id
                """,
                [job_id, short_error],
            )
            run_row = cur.fetchone()
            if run_row:
                run_id = str(run_row[0])
                cur.execute(
                    """
                    INSERT INTO job_run_logs (run_id, level, message, context)
                    VALUES (%s, %s, %s, %s::jsonb)
                    """,
                    [
                        run_id,
                        "ERROR",
                        "schedule_invalid_cron_disabled",
                        json.dumps(
                            {
                                "job_id": job_id,
                                "schedule_id": schedule_id,
                                "cron_expr": cron_expr,
                                "error": short_error,
                                "trigger": "scheduler_validation",
                            }
                        ),
                    ],
                )
        conn.commit()
    except Exception as exc:
        conn.rollback()
        emit(
            "ERROR",
            "SCHEDULER",
            f"Failed to disable invalid schedule: schedule_id={schedule_id} job_id={job_id} error={exc}",
        )
        return
    finally:
        conn.close()

    emit(
        "ERROR",
        "SCHEDULER",
        f"Disabled invalid schedule: schedule_id={schedule_id} job_id={job_id} cron_expr='{cron_expr}' error={short_error}",
    )

    try:
        log_audit_event(
            action="schedule_invalid_cron_disabled",
            entity_type="job_schedule",
            entity_id=schedule_id,
            actor=None,
            details={
                "job_id": job_id,
                "cron_expr": cron_expr,
                "error": short_error,
                "run_id": run_id,
            },
        )
    except Exception as exc:
        emit(
            "WARN",
            "SCHEDULER",
            f"Failed writing invalid schedule audit event: schedule_id={schedule_id} job_id={job_id} error={exc}",
        )


def _recover_interrupted_runs() -> int:
    conn = db.get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE job_runs
            SET finished_at = now(),
                status = 'failed',
                error = COALESCE(error, %s)
            WHERE status = 'running'
              AND finished_at IS NULL
            RETURNING run_id, job_id
            """,
            [INTERRUPTED_RUN_ERROR],
        )
        rows = cur.fetchall()
        conn.commit()
    finally:
        conn.close()

    recovered = 0
    for row in rows:
        run_id = str(row[0])
        job_id = str(row[1])
        recovered += 1
        try:
            log_audit_event(
                action="job_run_failed",
                entity_type="job_run",
                entity_id=run_id,
                actor=None,
                details={"job_id": job_id, "trigger": "worker_recovery", "error": INTERRUPTED_RUN_ERROR},
            )
        except Exception as exc:
            emit(
                "WARN",
                "SCHEDULER",
                f"Recovered run audit log failed: run_id={run_id} job_id={job_id} error={exc}",
            )
        try:
            log_job_run_log(
                run_id=run_id,
                level="ERROR",
                message="job_interrupted_recovered",
                context={"job_id": job_id, "error": INTERRUPTED_RUN_ERROR, "trigger": "worker_recovery"},
            )
        except Exception as exc:
            emit(
                "WARN",
                "SCHEDULER",
                f"Recovered run log write failed: run_id={run_id} job_id={job_id} error={exc}",
            )
    return recovered


def run_job_once(job, actor_claims=None):
    job_id = job["job_id"]
    job_type = job["job_type"]
    feature_key = get_job_type_license_feature(job_type)
    if feature_key:
        try:
            require_license_feature(feature_key)
        except LicenseFeatureError as exc:
            emit(
                "WARN",
                "SCHEDULER",
                f"Run-now job blocked by license: job_id={job_id} job_type={job_type} feature={feature_key} error={exc}",
            )
            log_audit_event(
                action="job_run_blocked_license",
                entity_type="job",
                entity_id=str(job_id),
                actor=actor_claims,
                details={"job_type": job_type, "trigger": "run_now", "feature": feature_key, "error": str(exc)},
            )
            return
    conn = db.get_conn()
    try:
        cur = conn.cursor()
        locked = db.try_advisory_lock(cur, str(job_id))
        if not locked:
            conn.rollback()
            emit("WARN", "SCHEDULER", f"Run-now job skipped: advisory lock unavailable job_id={job_id}")
            return

        run_id = _insert_job_run(cur, job_id)
        conn.commit()
        emit(
            "INFO",
            "SCHEDULER",
            f"Run-now job triggered: job_id={job_id} job_type={job_type} run_id={run_id}",
        )

        log_audit_event(
            action="job_run_started",
            entity_type="job_run",
            entity_id=str(run_id),
            actor=actor_claims,
            details={"job_id": str(job_id), "job_type": job_type, "trigger": "run_now"},
        )

        status, error = _execute_job(
            job_type,
            run_id=str(run_id),
            job_id=str(job_id),
            actor_claims=actor_claims,
        )

        cur.execute(
            "UPDATE job_runs SET finished_at = now(), status = %s, error = %s WHERE run_id = %s",
            [status, error, run_id],
        )
        db.advisory_unlock(cur, str(job_id))
        conn.commit()
        if status == "success":
            emit(
                "INFO",
                "SCHEDULER",
                f"Run-now job finished: job_id={job_id} job_type={job_type} run_id={run_id} status={status}",
            )
        else:
            emit(
                "ERROR",
                "SCHEDULER",
                f"Run-now job finished: job_id={job_id} job_type={job_type} run_id={run_id} status={status} error={error}",
            )

        log_audit_event(
            action="job_run_%s" % ("succeeded" if status == "success" else "failed"),
            entity_type="job_run",
            entity_id=str(run_id),
            actor=actor_claims,
            details={"job_id": str(job_id), "job_type": job_type, "trigger": "run_now", "error": error},
        )

        log_job_run_log(
            run_id=str(run_id),
            level="INFO" if status == "success" else "ERROR",
            message="job_finished",
            context={"job_id": str(job_id), "job_type": job_type, "trigger": "run_now", "status": status, "error": error},
        )
    finally:
        conn.close()


def _insert_job_run(cur, job_id):
    cur.execute(
        """
        INSERT INTO job_runs (run_id, job_id, started_at, status)
        VALUES (gen_random_uuid(), %s, now(), 'running')
        RETURNING run_id
        """,
        [job_id],
    )
    return cur.fetchone()[0]


def _compute_next_run(cron_expr):
    base = datetime.now(timezone.utc)
    itr = croniter(cron_expr, base)
    return itr.get_next(datetime)


def _execute_job(job_type, *, run_id: str, job_id: str, actor_claims=None):
    try:
        feature_key = get_job_type_license_feature(job_type)
        if feature_key:
            require_license_feature(feature_key)
        if job_type == "graph_ingest":
            log_job_run_log(run_id=run_id, level="INFO", message="graph_ingest_started", context={"job_id": job_id})
            run_graph_ingest(run_id=run_id, job_id=job_id, actor=actor_claims)
        elif job_type == "mv_refresh":
            log_job_run_log(run_id=run_id, level="INFO", message="mv_refresh_started", context={"job_id": job_id})
            run_mv_refresh(run_id=run_id, job_id=job_id, actor=actor_claims)
        elif job_type == "copilot_telemetry":
            log_job_run_log(run_id=run_id, level="INFO", message="copilot_telemetry_started", context={"job_id": job_id})
            run_copilot_telemetry(run_id=run_id, job_id=job_id, actor=actor_claims)
        elif job_type == "copilot_usage_sync":
            log_job_run_log(run_id=run_id, level="INFO", message="copilot_usage_sync_started", context={"job_id": job_id})
            run_copilot_usage_sync(run_id=run_id, job_id=job_id, actor=actor_claims)
        else:
            raise RuntimeError(f"Unknown job_type: {job_type}")
        return "success", None
    except Exception as exc:
        emit("ERROR", "SCHEDULER", f"Job execution failed: job_id={job_id} job_type={job_type} error={exc}")
        log_job_run_log(
            run_id=run_id,
            level="ERROR",
            message="job_exception",
            context={"job_id": job_id, "job_type": job_type, "error": str(exc)},
        )
        return "failed", str(exc)
