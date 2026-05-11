import re


ALLOWED_LOG_TYPES = {"INFO", "WARN", "ERROR"}
ALLOWED_ACTORS = {"FLASK_API", "SCHEDULER", "HEARTBEAT", "GRAPH", "DB_CONN", "COPILOT_TELEMETRY", "COPILOT_USAGE_SYNC"}
SENSITIVE_LOG_PATTERNS = [
    re.compile(
        r"(?i)([\"']?\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)\b[\"']?\s*[:=]\s*)"
        r"([\"']?)([^,\"'\s}\]]+)([\"']?)"
    ),
    re.compile(r"(?i)(Bearer\s+)[A-Za-z0-9._~+/-]+=*"),
]


def _redact_sensitive_text(message: str) -> str:
    message = SENSITIVE_LOG_PATTERNS[0].sub(
        lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]{match.group(4)}",
        message,
    )
    return SENSITIVE_LOG_PATTERNS[1].sub(r"\1[REDACTED]", message)


def _sanitize_text(text: object) -> str:
    message = str(text) if text is not None else ""
    message = message.replace("\n", " ").replace("\r", " ").strip()
    if not message:
        return "-"
    message = _redact_sensitive_text(message)
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
