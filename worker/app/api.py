from http import HTTPStatus
from threading import Thread
from flask import Flask, g, jsonify, request

from app import db
from app.auth import require_internal_token
from app.heartbeat import get_heartbeat_status, is_heartbeat_healthy
from app.license import (
    LicenseFeatureError,
    get_current_license,
    get_job_type_license_feature,
    get_license_lookup_failure_summary,
    require_license_feature,
)
from app.runtime_logger import emit
from app.scheduler import get_scheduler_status, run_job_once
from app.utils import log_audit_event


def _actor_from_body(body):
    actor = body.get("actor") or {}
    return {
        "oid": actor.get("oid"),
        "upn": actor.get("upn"),
        "name": actor.get("name"),
    }


def _job_id_from_body(body):
    value = body.get("job_id")
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def _status_phrase(code: int) -> str:
    try:
        return HTTPStatus(code).phrase
    except ValueError:
        return "Unknown Status"


def _response_error_summary(response) -> str:
    payload = response.get_json(silent=True)
    if isinstance(payload, dict):
        if payload.get("error"):
            return str(payload.get("error"))
        if payload.get("message"):
            return str(payload.get("message"))
    body = response.get_data(as_text=True) or ""
    body = body.replace("\n", " ").replace("\r", " ").strip()
    if not body:
        return "unspecified_error"
    if len(body) > 220:
        return body[:217] + "..."
    return body


def create_app():
    app = Flask(__name__)

    @app.before_request
    def log_request_start():
        g._log_method = request.method
        g._log_path = request.path
        emit("INFO", "FLASK_API", f"Request received: {request.method} {request.path}")

    @app.after_request
    def log_request_end(response):
        method = getattr(g, "_log_method", request.method)
        path = getattr(g, "_log_path", request.path)
        status = response.status_code
        phrase = _status_phrase(status)
        if 200 <= status < 300:
            emit("INFO", "FLASK_API", f"Response sent: {status} {phrase} for {method} {path}")
        else:
            error_summary = _response_error_summary(response)
            level = "WARN" if status < 500 else "ERROR"
            emit(
                level,
                "FLASK_API",
                f"Response sent: {status} {phrase} for {method} {path}; error={error_summary}",
            )
        return response

    @app.teardown_request
    def log_request_exception(exc):
        if exc is None:
            return
        method = getattr(g, "_log_method", "UNKNOWN")
        path = getattr(g, "_log_path", "UNKNOWN")
        text = str(exc).replace("\n", " ").replace("\r", " ").strip()
        if len(text) > 220:
            text = text[:217] + "..."
        emit("ERROR", "FLASK_API", f"Unhandled exception during {method} {path}: error={text}")

    @app.get("/health")
    @require_internal_token
    def health():
        try:
            db.fetch_one("SELECT 1 AS ok")
            db_ok = True
        except Exception:
            db_ok = False
        heartbeat = get_heartbeat_status()
        try:
            license_summary = get_current_license()
        except Exception as exc:
            text = str(exc).replace("\n", " ").replace("\r", " ").strip() or "license_lookup_failed"
            if len(text) > 220:
                text = text[:217] + "..."
            emit("ERROR", "FLASK_API", f"Health check license lookup failed: error={text}")
            license_summary = get_license_lookup_failure_summary(text)
        return jsonify(
            {
                "ok": db_ok and is_heartbeat_healthy(),
                "db": db_ok,
                "scheduler": get_scheduler_status(),
                "heartbeat": heartbeat,
                "license": license_summary,
            }
        )

    @app.get("/jobs/status")
    @require_internal_token
    def jobs_status():
        rows = db.fetch_all(
            """
            SELECT j.job_id, j.job_type, j.enabled,
                   js.schedule_id, js.cron_expr, js.next_run_at, js.enabled AS schedule_enabled,
                   m.run_id, m.started_at, m.finished_at, m.status, m.status AS latest_run_status, m.error
            FROM jobs j
            LEFT JOIN job_schedules js ON js.job_id = j.job_id
            LEFT JOIN LATERAL (
                SELECT run_id, started_at, finished_at, status, error
                FROM job_runs
                WHERE job_id = j.job_id
                ORDER BY started_at DESC NULLS LAST, run_id DESC
                LIMIT 1
            ) m ON true
            ORDER BY j.job_type
            """
        )
        return jsonify({"jobs": rows, "license": get_current_license()})

    @app.post("/jobs/run-now")
    @require_internal_token
    def run_now():
        body = request.get_json(silent=True) or {}
        job_id = _job_id_from_body(body)
        if not job_id:
            return jsonify({"error": "job_id_required"}), 400

        job = db.fetch_one("SELECT job_id, job_type FROM jobs WHERE job_id = %s", [job_id])
        if not job:
            return jsonify({"error": "job_not_found"}), 404

        try:
            require_license_feature("job_control")
            feature_key = get_job_type_license_feature(job.get("job_type"))
            if feature_key:
                require_license_feature(feature_key)
        except LicenseFeatureError as exc:
            return jsonify({"error": str(exc), "license": exc.summary}), 403

        actor = _actor_from_body(body)
        log_audit_event(
            action="job_run_requested",
            entity_type="job",
            entity_id=job_id,
            actor=actor,
            details={"job_type": job["job_type"]},
        )

        thread = Thread(target=run_job_once, args=(job, actor))
        thread.daemon = True
        thread.start()

        return jsonify({"status": "queued"}), 202

    @app.post("/jobs/pause")
    @require_internal_token
    def pause_job():
        body = request.get_json(silent=True) or {}
        job_id = _job_id_from_body(body)
        if not job_id:
            return jsonify({"error": "job_id_required"}), 400

        job = db.fetch_one("SELECT job_id, job_type FROM jobs WHERE job_id = %s", [job_id])
        if not job:
            return jsonify({"error": "job_not_found"}), 404

        try:
            require_license_feature("job_control")
        except LicenseFeatureError as exc:
            return jsonify({"error": str(exc), "license": exc.summary}), 403

        updated = db.execute("UPDATE job_schedules SET enabled = false, next_run_at = NULL WHERE job_id = %s", [job_id])
        if updated <= 0:
            return jsonify({"error": "schedule_not_found"}), 404

        log_audit_event(
            action="job_paused",
            entity_type="job",
            entity_id=job_id,
            actor=_actor_from_body(body),
            details={"job_type": job["job_type"]},
        )
        return jsonify({"status": "paused"})

    @app.post("/jobs/resume")
    @require_internal_token
    def resume_job():
        body = request.get_json(silent=True) or {}
        job_id = _job_id_from_body(body)
        if not job_id:
            return jsonify({"error": "job_id_required"}), 400

        job = db.fetch_one("SELECT job_id, job_type FROM jobs WHERE job_id = %s", [job_id])
        if not job:
            return jsonify({"error": "job_not_found"}), 404

        try:
            require_license_feature("job_control")
        except LicenseFeatureError as exc:
            return jsonify({"error": str(exc), "license": exc.summary}), 403

        updated = db.execute("UPDATE job_schedules SET enabled = true, next_run_at = NULL WHERE job_id = %s", [job_id])
        if updated <= 0:
            return jsonify({"error": "schedule_not_found"}), 404
        # Resume should restore job-level enablement for legacy/pre-upgrade disabled rows.
        db.execute("UPDATE jobs SET enabled = true WHERE job_id = %s", [job_id])

        log_audit_event(
            action="job_resumed",
            entity_type="job",
            entity_id=job_id,
            actor=_actor_from_body(body),
            details={"job_type": job["job_type"]},
        )
        return jsonify({"status": "resumed"})

    return app
