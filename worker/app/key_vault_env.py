import json
import os
from pathlib import Path
from typing import Any, Callable

import requests


KEY_VAULT_SCOPE = "https://vault.azure.net"
KEY_VAULT_UNSET_VALUE = "__PRINCETON_SENTINEL_UNSET__"


def _is_present(value: str | None) -> bool:
    return value is not None and value.strip() != ""


def env_key_to_secret_name(key: str) -> str:
    return key.replace("_", "-")


def normalize_vault_url(value: str | None) -> str:
    return str(value or "").strip().rstrip("/")


def _manifest_candidates() -> list[Path]:
    current = Path(__file__).resolve()
    return [
        current.parent / "runtime-env-manifest.json",
        current.parents[2] / "runtime-env-manifest.json",
    ]


def load_manifest(path: str | Path | None = None) -> dict[str, Any]:
    if path:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    for candidate in _manifest_candidates():
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise RuntimeError("runtime-env-manifest.json was not found")


def collect_service_keys(manifest: dict[str, Any], service: str) -> list[dict[str, Any]]:
    service_manifest = (manifest.get("services") or {}).get(service)
    if not service_manifest:
        raise RuntimeError(f"Missing runtime env manifest service: {service}")
    required = set(service_manifest.get("required") or [])
    names = list(dict.fromkeys([*(service_manifest.get("required") or []), *(service_manifest.get("optional") or [])]))
    return [{"name": name, "required": name in required} for name in names]


def acquire_managed_identity_token(
    *,
    env: dict[str, str] | None = None,
    requests_module=requests,
) -> str:
    env = env if env is not None else os.environ
    endpoint = env.get("IDENTITY_ENDPOINT")
    identity_header = env.get("IDENTITY_HEADER")
    client_id = env.get("MANAGED_IDENTITY_CLIENT_ID") or env.get("AZURE_CLIENT_ID")

    if endpoint and identity_header:
        params = {"api-version": "2019-08-01", "resource": KEY_VAULT_SCOPE}
        if client_id:
            params["client_id"] = client_id
        response = requests_module.get(
            endpoint,
            params=params,
            headers={"X-IDENTITY-HEADER": identity_header, "Metadata": "true"},
            timeout=10,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"Managed identity token request failed: status {response.status_code}")
        payload = response.json()
        token = payload.get("access_token")
        if not token:
            raise RuntimeError("Managed identity token response did not include access_token")
        return str(token)

    params = {"api-version": "2018-02-01", "resource": KEY_VAULT_SCOPE}
    if client_id:
        params["client_id"] = client_id
    response = requests_module.get(
        "http://169.254.169.254/metadata/identity/oauth2/token",
        params=params,
        headers={"Metadata": "true"},
        timeout=10,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"IMDS token request failed: status {response.status_code}")
    payload = response.json()
    token = payload.get("access_token")
    if not token:
        raise RuntimeError("IMDS token response did not include access_token")
    return str(token)


def _fetch_secret(
    *,
    vault_url: str,
    token: str,
    key: str,
    requests_module=requests,
) -> tuple[bool, str]:
    secret_name = env_key_to_secret_name(key)
    url = f"{vault_url}/secrets/{secret_name}"
    response = requests_module.get(
        url,
        params={"api-version": "7.4"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    )
    if response.status_code == 404:
        return False, ""
    if response.status_code >= 400:
        raise RuntimeError(f"Key Vault secret lookup failed for {key}: status {response.status_code}")
    payload = response.json()
    if "value" not in payload:
        raise RuntimeError(f"Key Vault secret lookup failed for {key}: missing value")
    return True, str(payload["value"])


def hydrate_env_from_key_vault(
    service: str,
    *,
    env: dict[str, str] | None = None,
    manifest: dict[str, Any] | None = None,
    manifest_path: str | Path | None = None,
    token_provider: Callable[[], str] | None = None,
    requests_module=requests,
    vault_url: str | None = None,
) -> dict[str, Any]:
    env = env if env is not None else os.environ
    normalized_vault_url = normalize_vault_url(vault_url or env.get("AZ_KEY_VAULT_URL"))
    if not normalized_vault_url:
        return {"vault_configured": False, "hydrated": [], "missing": []}

    runtime_manifest = manifest or load_manifest(manifest_path)
    keys = collect_service_keys(runtime_manifest, service)
    token = token_provider() if token_provider else acquire_managed_identity_token(env=env, requests_module=requests_module)
    hydrated: list[str] = []

    for item in keys:
        name = str(item["name"])
        if _is_present(env.get(name)):
            continue
        found, value = _fetch_secret(
            vault_url=normalized_vault_url,
            token=token,
            key=name,
            requests_module=requests_module,
        )
        if found and value == KEY_VAULT_UNSET_VALUE:
            continue
        if found and _is_present(value):
            env[name] = value
            hydrated.append(name)

    missing = [str(item["name"]) for item in keys if item["required"] and not _is_present(env.get(str(item["name"])))]
    if missing:
        raise RuntimeError(f"Missing required runtime configuration after Key Vault hydration: {', '.join(missing)}")

    return {"vault_configured": True, "hydrated": hydrated, "missing": missing}
