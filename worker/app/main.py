import os

from app.key_vault_env import hydrate_env_from_key_vault

hydrate_env_from_key_vault("worker")

from app.api import create_app
from app.heartbeat import start_heartbeat_thread
from app.scheduler import start_scheduler_thread

app = create_app()
_bootstrapped = False


def _is_enabled(value: str | None, default: bool = True) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    return normalized in {"1", "true", "t", "yes", "y", "on"}


def bootstrap_background_threads():
    global _bootstrapped
    if _bootstrapped:
        return
    if not _is_enabled(os.getenv("WORKER_ENABLE_BACKGROUND_THREADS"), default=True):
        _bootstrapped = True
        return
    start_scheduler_thread()
    start_heartbeat_thread()
    _bootstrapped = True


bootstrap_background_threads()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
