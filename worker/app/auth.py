import os
import hmac
from functools import wraps
from typing import Dict, Any

import jwt
from jwt import PyJWKClient
from flask import request, jsonify


TENANT_ID = os.getenv("ENTRA_TENANT_ID")
WORKER_API_AUDIENCE = os.getenv("WORKER_API_AUDIENCE")
ADMIN_GROUP_ID = os.getenv("ADMIN_GROUP_ID")
USER_GROUP_ID = os.getenv("USER_GROUP_ID")
WORKER_INTERNAL_API_TOKEN_HEADER = "X-Worker-Internal-Token"

ISSUER = None
JWKS_URL = None
_jwks_client = None
if TENANT_ID and WORKER_API_AUDIENCE:
    ISSUER = f"https://login.microsoftonline.com/{TENANT_ID}/v2.0"
    JWKS_URL = f"https://login.microsoftonline.com/{TENANT_ID}/discovery/v2.0/keys"
    _jwks_client = PyJWKClient(JWKS_URL)


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
    expected_token = os.getenv("WORKER_INTERNAL_API_TOKEN", "").strip()
    if not expected_token or not provided_token:
        return False
    return hmac.compare_digest(provided_token, expected_token)


def decode_token(token: str) -> Dict[str, Any]:
    if not _jwks_client or not ISSUER or not WORKER_API_AUDIENCE:
        raise RuntimeError("Worker auth is disabled (WORKER_API_AUDIENCE not set)")
    signing_key = _jwks_client.get_signing_key_from_jwt(token).key
    return jwt.decode(
        token,
        signing_key,
        algorithms=["RS256"],
        audience=WORKER_API_AUDIENCE,
        issuer=ISSUER,
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
    return ADMIN_GROUP_ID and ADMIN_GROUP_ID in groups


def is_user(claims: Dict[str, Any]) -> bool:
    groups = _groups_from_claims(claims)
    if ADMIN_GROUP_ID and ADMIN_GROUP_ID in groups:
        return True
    return USER_GROUP_ID and USER_GROUP_ID in groups


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
