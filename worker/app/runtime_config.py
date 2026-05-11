import os


def _is_truthy(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "t", "yes", "y", "on"}


def is_local_docker_deployment() -> bool:
    return _is_truthy(os.getenv("LOCAL_DOCKER_DEPLOYMENT"))
