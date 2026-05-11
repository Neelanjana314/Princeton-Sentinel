ALLOWED_LOG_TYPES = {"INFO", "WARN", "ERROR"}
ALLOWED_ACTORS = {"FLASK_API", "SCHEDULER", "HEARTBEAT", "GRAPH", "DB_CONN", "COPILOT_TELEMETRY", "COPILOT_USAGE_SYNC"}


def _sanitize_text(text: object) -> str:
    message = str(text) if text is not None else ""
    message = message.replace("\n", " ").replace("\r", " ").strip()
    if not message:
        return "-"
    if len(message) > 600:
        return message[:597] + "..."
    return message


def emit(log_type: str, actor: str, text: object):
    level = (log_type or "INFO").upper()
    if level not in ALLOWED_LOG_TYPES:
        level = "INFO"

    source = (actor or "").upper()
    if source not in ALLOWED_ACTORS:
        source = "DB_CONN"

    message = _sanitize_text(text)
    print(f"[{level}] [{source}]: {message}", flush=True)
