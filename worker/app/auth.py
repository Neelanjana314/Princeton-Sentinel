import hmac
from functools import wraps
from typing import Dict, Any

import jwt
from jwt import PyJWKClient
from flask import request, jsonify

from app.runtime_config import get_runtime_env


WORKER_INTERNAL_API_TOKEN_HEADER = "X-Worker-Internal-Token"

_jwks_cache: dict[str, Any] = {"tenant_id": None, "audience": None, "issuer": None, "client": None}


def _get_token_from_header() -> str | None:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    return auth_header.split(" ", 1)[1]


def _get_internal_token_from_header() -> str | None:
    value = request.headers.get(WORKER_INTERNAL_API_TOKEN_HEADER, "")
    value = value.strip()
    return value or None


def _is_valid_internal_token(provided_token: str | None) -> bool:
    expected_token = (get_runtime_env("WORKER_INTERNAL_API_TOKEN") or "").strip()
    if not expected_token or not provided_token:
        return False
    return hmac.compare_digest(provided_token, expected_token)


def decode_token(token: str) -> Dict[str, Any]:
    tenant_id = (get_runtime_env("ENTRA_TENANT_ID") or "").strip()
    audience = (get_runtime_env("WORKER_API_AUDIENCE") or "").strip()
    if not tenant_id or not audience:
        raise RuntimeError("Worker auth is disabled (WORKER_API_AUDIENCE not set)")
    if _jwks_cache["tenant_id"] != tenant_id or _jwks_cache["audience"] != audience:
        _jwks_cache["tenant_id"] = tenant_id
        _jwks_cache["audience"] = audience
        _jwks_cache["issuer"] = f"https://login.microsoftonline.com/{tenant_id}/v2.0"
        _jwks_cache["client"] = PyJWKClient(f"https://login.microsoftonline.com/{tenant_id}/discovery/v2.0/keys")
    signing_key = _jwks_cache["client"].get_signing_key_from_jwt(token).key
    return jwt.decode(
        token,
        signing_key,
        algorithms=["RS256"],
        audience=audience,
        issuer=_jwks_cache["issuer"],
    )


def _has_group_overage(claims: Dict[str, Any]) -> bool:
    return "_claim_names" in claims and "groups" in claims["_claim_names"]


def _groups_from_claims(claims: Dict[str, Any]) -> list[str]:
    groups = claims.get("groups") or []
    if isinstance(groups, list):
        return groups
    return []


def is_admin(claims: Dict[str, Any]) -> bool:
    groups = _groups_from_claims(claims)
    admin_group_id = get_runtime_env("ADMIN_GROUP_ID")
    return bool(admin_group_id and admin_group_id in groups)


def is_user(claims: Dict[str, Any]) -> bool:
    groups = _groups_from_claims(claims)
    admin_group_id = get_runtime_env("ADMIN_GROUP_ID")
    user_group_id = get_runtime_env("USER_GROUP_ID")
    if admin_group_id and admin_group_id in groups:
        return True
    return bool(user_group_id and user_group_id in groups)


def require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        token = _get_token_from_header()
        if not token:
            return jsonify({"error": "missing_bearer_token"}), 401
        try:
            claims = decode_token(token)
        except Exception:
            return jsonify({"error": "invalid_token"}), 401
        if _has_group_overage(claims):
            return jsonify({"error": "groups_overage"}), 403
        request.claims = claims
        return fn(*args, **kwargs)

    return wrapper


def require_admin(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        resp = require_auth(lambda: None)()
        if resp is not None:
            return resp
        claims = request.claims
        if not is_admin(claims):
            return jsonify({"error": "forbidden"}), 403
        return fn(*args, **kwargs)

    return wrapper


def require_internal_token(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        token = _get_internal_token_from_header()
        if not token:
            return jsonify({"error": "missing_internal_token"}), 401
        if not _is_valid_internal_token(token):
            return jsonify({"error": "invalid_internal_token"}), 401
        return fn(*args, **kwargs)

    return wrapper
