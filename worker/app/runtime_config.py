import os
import threading
import time
from functools import lru_cache
from typing import Any, Callable

import requests

from app import key_vault_env


_TOKEN_REFRESH_SKEW_SECONDS = 60
_token_lock = threading.Lock()
_token_cache: dict[str, Any] = {"token": None, "expires_at": 0.0}
_last_known_good: dict[str, str] = {}
_manifest_cache: dict[str, Any] | None = None
_requests_module = requests
_token_provider: Callable[[], str] | None = None


def _is_truthy(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "t", "yes", "y", "on"}


def is_local_docker_deployment() -> bool:
    return _is_truthy(os.getenv("LOCAL_DOCKER_DEPLOYMENT"))


def is_azure_key_vault_runtime_enabled() -> bool:
    return bool(key_vault_env.normalize_vault_url(os.getenv("AZ_KEY_VAULT_URL"))) and not is_local_docker_deployment()


def _is_present(value: str | None) -> bool:
    return value is not None and value.strip() != ""


def _load_manifest() -> dict[str, Any]:
    global _manifest_cache
    if _manifest_cache is None:
        _manifest_cache = key_vault_env.load_manifest()
    return _manifest_cache


@lru_cache(maxsize=1)
def _runtime_keys() -> dict[str, dict[str, Any]]:
    keys: dict[str, dict[str, Any]] = {}
    manifest = _load_manifest()
    for service in (manifest.get("services") or {}).values():
        required = set(service.get("required") or [])
        for name in [*(service.get("required") or []), *(service.get("optional") or [])]:
            keys[str(name)] = {
                "name": str(name),
                "required": bool(keys.get(str(name), {}).get("required") or name in required),
            }
    return keys


def is_runtime_manifest_key(name: str) -> bool:
    return name in _runtime_keys()


def _parse_token_expires_at(payload: dict[str, Any]) -> float:
    now = time.time()
    expires_on = payload.get("expires_on") or payload.get("expiresOn")
    if isinstance(expires_on, (int, float)):
        return float(expires_on / 1000 if expires_on > 10_000_000_000 else expires_on)
    if isinstance(expires_on, str) and expires_on.strip().isdigit():
        parsed = float(expires_on.strip())
        return parsed / 1000 if parsed > 10_000_000_000 else parsed
    expires_in = payload.get("expires_in") or payload.get("expiresIn")
    if isinstance(expires_in, (int, float)):
        return now + float(expires_in)
    if isinstance(expires_in, str) and expires_in.strip().isdigit():
        return now + float(expires_in.strip())
    return now + 55 * 60


def _acquire_cached_managed_identity_token() -> str:
    if _token_provider:
        return _token_provider()

    now = time.time()
    cached_token = _token_cache.get("token")
    if cached_token and now < float(_token_cache.get("expires_at") or 0) - _TOKEN_REFRESH_SKEW_SECONDS:
        return str(cached_token)

    with _token_lock:
        now = time.time()
        cached_token = _token_cache.get("token")
        if cached_token and now < float(_token_cache.get("expires_at") or 0) - _TOKEN_REFRESH_SKEW_SECONDS:
            return str(cached_token)

        env = os.environ
        endpoint = env.get("IDENTITY_ENDPOINT")
        identity_header = env.get("IDENTITY_HEADER")
        client_id = env.get("MANAGED_IDENTITY_CLIENT_ID") or env.get("AZURE_CLIENT_ID")
        if endpoint and identity_header:
            params = {"api-version": "2019-08-01", "resource": key_vault_env.KEY_VAULT_SCOPE}
            if client_id:
                params["client_id"] = client_id
            response = _requests_module.get(
                endpoint,
                params=params,
                headers={"X-IDENTITY-HEADER": identity_header, "Metadata": "true"},
                timeout=10,
            )
        else:
            params = {"api-version": "2018-02-01", "resource": key_vault_env.KEY_VAULT_SCOPE}
            if client_id:
                params["client_id"] = client_id
            response = _requests_module.get(
                "http://169.254.169.254/metadata/identity/oauth2/token",
                params=params,
                headers={"Metadata": "true"},
                timeout=10,
            )
        if response.status_code >= 400:
            raise RuntimeError(f"Managed identity token request failed: status {response.status_code}")
        payload = response.json()
        token = payload.get("access_token")
        if not token:
            raise RuntimeError("Managed identity token response did not include access_token")
        _token_cache["token"] = str(token)
        _token_cache["expires_at"] = _parse_token_expires_at(payload)
        return str(token)


def _fetch_secret(name: str) -> tuple[bool, str]:
    vault_url = key_vault_env.normalize_vault_url(os.getenv("AZ_KEY_VAULT_URL"))
    secret_name = key_vault_env.env_key_to_secret_name(name)
    response = _requests_module.get(
        f"{vault_url}/secrets/{secret_name}",
        params={"api-version": "7.4"},
        headers={"Authorization": f"Bearer {_acquire_cached_managed_identity_token()}"},
        timeout=10,
    )
    if response.status_code == 404:
        return False, ""
    if response.status_code >= 400:
        raise RuntimeError(f"Key Vault secret lookup failed for {name}: status {response.status_code}")
    payload = response.json()
    if "value" not in payload:
        raise RuntimeError(f"Key Vault secret lookup failed for {name}: missing value")
    return True, str(payload["value"])


def get_runtime_env(name: str, default: str | None = None) -> str | None:
    existing = os.getenv(name)
    if not is_azure_key_vault_runtime_enabled() or not is_runtime_manifest_key(name):
        return existing if existing is not None else default

    try:
        found, value = _fetch_secret(name)
        if not found or value == key_vault_env.KEY_VAULT_UNSET_VALUE or not _is_present(value):
            if _is_present(existing):
                _last_known_good[name] = str(existing)
                return str(existing)
            os.environ[name] = ""
            _last_known_good.pop(name, None)
            return default
        os.environ[name] = value
        _last_known_good[name] = value
        return value
    except Exception as exc:
        stale = _last_known_good.get(name) or (existing if _is_present(existing) else None)
        if stale:
            _last_known_good[name] = stale
            print(f"Key Vault runtime config lookup failed for {name}; using last-known-good value: {exc}", flush=True)
            return stale
        raise


def require_runtime_env(name: str) -> str:
    value = get_runtime_env(name)
    if not _is_present(value):
        raise RuntimeError(f"{name} is not set")
    return str(value)


def get_int_runtime_env(name: str, default: int) -> int:
    value = get_runtime_env(name)
    if not _is_present(value):
        return default
    try:
        return int(str(value))
    except ValueError:
        return default


def get_float_runtime_env(name: str, default: float) -> float:
    value = get_runtime_env(name)
    if not _is_present(value):
        return default
    try:
        return float(str(value))
    except ValueError:
        return default


def get_bool_runtime_env(name: str, default: bool = False) -> bool:
    value = get_runtime_env(name)
    if value is None:
        return default
    return _is_truthy(value)


def set_runtime_config_requests_for_tests(requests_module) -> None:
    global _requests_module
    _requests_module = requests_module
    _token_cache["token"] = None
    _token_cache["expires_at"] = 0.0


def set_runtime_config_token_provider_for_tests(provider: Callable[[], str] | None) -> None:
    global _token_provider
    _token_provider = provider
    _token_cache["token"] = None
    _token_cache["expires_at"] = 0.0


def reset_runtime_config_for_tests() -> None:
    global _manifest_cache, _requests_module, _token_provider
    _manifest_cache = None
    _runtime_keys.cache_clear()
    _requests_module = requests
    _token_provider = None
    _token_cache["token"] = None
    _token_cache["expires_at"] = 0.0
    _last_known_good.clear()
