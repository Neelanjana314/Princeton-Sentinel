from app.key_vault_env import hydrate_env_from_key_vault
from app.runtime_config import get_bool_runtime_env

hydrate_env_from_key_vault("worker")

from app.api import create_app
from app.heartbeat import start_heartbeat_thread
from app.scheduler import start_scheduler_thread

app = create_app()
_bootstrapped = False


def bootstrap_background_threads():
    global _bootstrapped
    if _bootstrapped:
        return
    if not get_bool_runtime_env("WORKER_ENABLE_BACKGROUND_THREADS", True):
        _bootstrapped = True
        return
    start_scheduler_thread()
    start_heartbeat_thread()
    _bootstrapped = True


bootstrap_background_threads()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
