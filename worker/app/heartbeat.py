import threading
import time
from datetime import datetime, timezone

import requests

from app.runtime_config import get_int_runtime_env, get_runtime_env
from app.runtime_logger import emit


_state_lock = threading.Lock()
_heartbeat_state = {
    "last_attempt_at": None,
    "last_success_at": None,
    "consecutive_failures": 0,
    "last_error": None,
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_heartbeat_healthy() -> bool:
    with _state_lock:
        return _heartbeat_state["consecutive_failures"] < get_int_runtime_env("WORKER_HEARTBEAT_FAIL_THRESHOLD", 2)


def get_heartbeat_status() -> dict:
    with _state_lock:
        status = dict(_heartbeat_state)
    fail_threshold = get_int_runtime_env("WORKER_HEARTBEAT_FAIL_THRESHOLD", 2)
    status["webapp_reachable"] = status["consecutive_failures"] < fail_threshold
    status["interval_seconds"] = get_int_runtime_env("WORKER_HEARTBEAT_INTERVAL_SECONDS", 30)
    status["fail_threshold"] = fail_threshold
    return status


def start_heartbeat_thread():
    thread = threading.Thread(target=_heartbeat_loop, daemon=True)
    thread.start()


def _heartbeat_loop():
    while True:
        interval_seconds = max(1, get_int_runtime_env("WORKER_HEARTBEAT_INTERVAL_SECONDS", 30))
        heartbeat_url = get_runtime_env("WORKER_HEARTBEAT_URL", "http://web:3000/api/internal/worker-heartbeat") or "http://web:3000/api/internal/worker-heartbeat"
        heartbeat_token = get_runtime_env("WORKER_HEARTBEAT_TOKEN", "") or ""
        timeout_seconds = get_int_runtime_env("WORKER_HEARTBEAT_TIMEOUT_SECONDS", 5)
        fail_threshold = get_int_runtime_env("WORKER_HEARTBEAT_FAIL_THRESHOLD", 2)
        headers = {}
        if heartbeat_token:
            headers["X-Worker-Heartbeat-Token"] = heartbeat_token
        attempted_at = _now_iso()
        error = None
        ok = False
        try:
            resp = requests.post(
                heartbeat_url,
                json={"sent_at": attempted_at},
                headers=headers,
                timeout=timeout_seconds,
            )
            resp.raise_for_status()
            ok = True
        except Exception as exc:
            error = str(exc)

        with _state_lock:
            previous_failures = _heartbeat_state["consecutive_failures"]
            _heartbeat_state["last_attempt_at"] = attempted_at
            if ok:
                _heartbeat_state["last_success_at"] = attempted_at
                _heartbeat_state["consecutive_failures"] = 0
                _heartbeat_state["last_error"] = None
            else:
                _heartbeat_state["consecutive_failures"] += 1
                _heartbeat_state["last_error"] = error
            failures = _heartbeat_state["consecutive_failures"]

        if not ok:
            short_error = (error or "heartbeat_failed").replace("\n", " ").replace("\r", " ").strip()
            if len(short_error) > 220:
                short_error = short_error[:217] + "..."
            emit(
                "WARN",
                "HEARTBEAT",
                f"Heartbeat failed: url={heartbeat_url} failures={failures} error={short_error}",
            )
            if previous_failures < fail_threshold <= failures:
                emit(
                    "ERROR",
                    "HEARTBEAT",
                    f"Heartbeat fail threshold reached: url={heartbeat_url} failures={failures}",
                )

        time.sleep(interval_seconds)
