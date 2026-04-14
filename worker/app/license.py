import base64
import hashlib
import json
import os
import threading
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from app import db
from app.local_testing_state import get_local_testing_state
from app.runtime_config import is_local_docker_deployment


LICENSE_SCHEMA_VERSION = 1
LICENSE_SIGNATURE_DELIMITER = "\n---SIGNATURE---\n"
LICENSE_FEATURE_DEFAULTS = {
    "dashboard_read": True,
    "live_graph_read": True,
    "admin_view": True,
    "license_manage": True,
    "permission_revoke": False,
    "job_control": False,
    "graph_ingest": False,
    "copilot_telemetry": False,
    "agents_dashboard": False,
}
JOB_TYPE_LICENSE_FEATURES = {
    "graph_ingest": "graph_ingest",
    "copilot_telemetry": "copilot_telemetry",
}

_cache_lock = threading.Lock()
_summary_cache = None
_public_key_cache = None


class LicenseFeatureError(RuntimeError):
    def __init__(self, feature_key: str, summary: Dict[str, Any]):
        super().__init__(f"license_feature_{feature_key}_disabled")
        self.feature_key = feature_key
        self.summary = summary


def _normalize_newlines(value: str) -> str:
    return value.replace("\r\n", "\n")


def _normalize_timestamp(value: Optional[Any]) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return _format_canonical_timestamp(value)
    parsed = _parse_datetime(str(value))
    return _format_canonical_timestamp(parsed) if parsed else str(value)


def _sort_json_value(value: Any) -> Any:
    if isinstance(value, list):
        return [_sort_json_value(entry) for entry in value]
    if isinstance(value, dict):
        return {key: _sort_json_value(value[key]) for key in sorted(value.keys())}
    return value


def canonicalize_license_payload(value: Any) -> str:
    return json.dumps(_sort_json_value(value), separators=(",", ":"), ensure_ascii=False)


def _default_features() -> Dict[str, bool]:
    return dict(LICENSE_FEATURE_DEFAULTS)


def _fully_enabled_features() -> Dict[str, bool]:
    return {key: True for key in LICENSE_FEATURE_DEFAULTS.keys()}


def _fallback_summary(error: Optional[str], **overrides) -> Dict[str, Any]:
    summary = {
        "status": "invalid",
        "mode": "read_only",
        "verification_status": "invalid",
        "verification_error": error,
        "artifact_id": None,
        "sha256": None,
        "uploaded_at": None,
        "uploaded_by": {"oid": None, "upn": None, "name": None},
        "payload": None,
        "features": _default_features(),
    }
    summary.update(overrides)
    return summary


def _local_docker_license_summary() -> Dict[str, Any]:
    tenant_id = _non_empty_string(os.getenv("ENTRA_TENANT_ID")) or "local-docker"
    features = _fully_enabled_features()
    return {
        "status": "active",
        "mode": "full",
        "verification_status": "verified",
        "verification_error": None,
        "artifact_id": None,
        "sha256": None,
        "uploaded_at": None,
        "uploaded_by": {"oid": None, "upn": None, "name": None},
        "payload": {
            "schema_version": LICENSE_SCHEMA_VERSION,
            "license_id": "local-docker-emulated-license",
            "license_type": "local_docker",
            "tenant_id": tenant_id,
            "issued_at": "1970-01-01T00:00:00.000Z",
            "expires_at": None,
            "features": features,
        },
        "features": features,
    }


def get_license_lookup_failure_summary(error: Optional[str] = None) -> Dict[str, Any]:
    return _fallback_summary(error or "license_lookup_failed")


def _non_empty_string(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _parse_datetime(value: Optional[str]) -> Optional[datetime]:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    try:
        return datetime.fromisoformat(normalized.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _format_canonical_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_required_timestamp(value: Any, field_name: str, allow_null: bool = False) -> Optional[str]:
    if value is None and allow_null:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name}_required")
    parsed = _parse_datetime(value)
    if parsed is None:
        raise ValueError(f"{field_name}_invalid")
    return _format_canonical_timestamp(parsed)


def _derive_features(value: Any) -> Dict[str, bool]:
    if not isinstance(value, dict):
        raise ValueError("license_features_invalid")
    features = _default_features()
    for key in LICENSE_FEATURE_DEFAULTS.keys():
        if key not in value:
            continue
        raw = value[key]
        if not isinstance(raw, bool):
            raise ValueError(f"license_feature_{key}_invalid")
        features[key] = raw
    return features


def _parse_payload(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("license_payload_invalid")
    if value.get("schema_version") != LICENSE_SCHEMA_VERSION:
        raise ValueError("license_schema_version_invalid")
    license_id = _non_empty_string(value.get("license_id"))
    license_type = _non_empty_string(value.get("license_type"))
    tenant_id = _non_empty_string(value.get("tenant_id"))
    if not license_id:
        raise ValueError("license_id_required")
    if not license_type:
        raise ValueError("license_type_required")
    if not tenant_id:
        raise ValueError("license_tenant_id_required")
    return {
        "schema_version": LICENSE_SCHEMA_VERSION,
        "license_id": license_id,
        "license_type": license_type,
        "tenant_id": tenant_id,
        "issued_at": _parse_required_timestamp(value.get("issued_at"), "license_issued_at"),
        "expires_at": _parse_required_timestamp(value.get("expires_at"), "license_expires_at", allow_null=True),
        "features": _derive_features(value.get("features")),
    }


def _load_public_key():
    global _public_key_cache
    public_key_path = _non_empty_string(os.getenv("LICENSE_PUBLIC_KEY_PATH"))
    if not public_key_path:
        raise RuntimeError("license_public_key_path_not_configured")
    with _cache_lock:
        if _public_key_cache and _public_key_cache["path"] == public_key_path:
            return _public_key_cache["value"]
        with open(public_key_path, "rb") as handle:
            value = serialization.load_pem_public_key(handle.read())
        _public_key_cache = {"path": public_key_path, "value": value}
        return value


def inspect_license_artifact(raw_license_text: str) -> Dict[str, Any]:
    sha256 = hashlib.sha256(raw_license_text.encode("utf-8")).hexdigest()
    normalized = _normalize_newlines(raw_license_text)
    try:
        delimiter_index = normalized.find(LICENSE_SIGNATURE_DELIMITER)
        if delimiter_index < 0:
            raise ValueError("license_signature_delimiter_missing")
        if normalized.find(LICENSE_SIGNATURE_DELIMITER, delimiter_index + len(LICENSE_SIGNATURE_DELIMITER)) >= 0:
            raise ValueError("license_signature_delimiter_duplicated")

        payload_text = normalized[:delimiter_index]
        signature_text = normalized[delimiter_index + len(LICENSE_SIGNATURE_DELIMITER) :].strip()
        if not signature_text:
          raise ValueError("license_signature_missing")
        if any(ch.isspace() for ch in signature_text):
            raise ValueError("license_signature_invalid")

        payload = _parse_payload(json.loads(payload_text))
        canonical_payload = canonicalize_license_payload(payload)
        if payload_text != canonical_payload:
            raise ValueError("license_payload_not_canonical")

        public_key = _load_public_key()
        signature = base64.b64decode(signature_text.encode("ascii"), validate=True)
        public_key.verify(signature, canonical_payload.encode("utf-8"), padding.PKCS1v15(), hashes.SHA256())
        return {
            "verification_status": "verified",
            "verification_error": None,
            "payload": payload,
            "sha256": sha256,
        }
    except Exception as exc:
        return {
            "verification_status": "invalid",
            "verification_error": str(exc) or "license_verification_failed",
            "payload": None,
            "sha256": sha256,
        }


def summarize_license_artifact(raw_license_text: str, *, artifact_id=None, uploaded_at=None, uploaded_by=None) -> Dict[str, Any]:
    inspection = inspect_license_artifact(raw_license_text)
    metadata = {
        "artifact_id": artifact_id,
        "sha256": inspection["sha256"],
        "uploaded_at": _normalize_timestamp(uploaded_at),
        "uploaded_by": {
            "oid": (uploaded_by or {}).get("oid"),
            "upn": (uploaded_by or {}).get("upn"),
            "name": (uploaded_by or {}).get("name"),
        },
    }

    if inspection["verification_status"] != "verified" or not inspection["payload"]:
        return _fallback_summary(
            inspection["verification_error"],
            artifact_id=metadata["artifact_id"],
            sha256=metadata["sha256"],
            uploaded_at=metadata["uploaded_at"],
            uploaded_by=metadata["uploaded_by"],
        )

    tenant_id = _non_empty_string(os.getenv("ENTRA_TENANT_ID"))
    if not tenant_id:
        return _fallback_summary(
            "entra_tenant_id_not_configured",
            artifact_id=metadata["artifact_id"],
            sha256=metadata["sha256"],
            uploaded_at=metadata["uploaded_at"],
            uploaded_by=metadata["uploaded_by"],
            payload=inspection["payload"],
        )

    if inspection["payload"]["tenant_id"] != tenant_id:
        return _fallback_summary(
            "license_tenant_id_mismatch",
            artifact_id=metadata["artifact_id"],
            sha256=metadata["sha256"],
            uploaded_at=metadata["uploaded_at"],
            uploaded_by=metadata["uploaded_by"],
            payload=inspection["payload"],
        )

    expires_at = inspection["payload"]["expires_at"]
    expires_dt = _parse_datetime(expires_at) if expires_at else None
    if expires_dt is not None and expires_dt < datetime.now(timezone.utc):
        return {
            "status": "expired",
            "mode": "read_only",
            "verification_status": "verified",
            "verification_error": "license_expired",
            "artifact_id": metadata["artifact_id"],
            "sha256": metadata["sha256"],
            "uploaded_at": metadata["uploaded_at"],
            "uploaded_by": metadata["uploaded_by"],
            "payload": inspection["payload"],
            "features": _default_features(),
        }

    return {
        "status": "active",
        "mode": "full",
        "verification_status": "verified",
        "verification_error": None,
        "artifact_id": metadata["artifact_id"],
        "sha256": metadata["sha256"],
        "uploaded_at": metadata["uploaded_at"],
        "uploaded_by": metadata["uploaded_by"],
        "payload": inspection["payload"],
        "features": inspection["payload"]["features"],
    }


def clear_license_cache():
    global _summary_cache
    with _cache_lock:
        _summary_cache = None


def get_current_license() -> Dict[str, Any]:
    global _summary_cache
    ttl_seconds = int(os.getenv("LICENSE_CACHE_TTL_SECONDS", "300") or "300")
    local_testing_state = get_local_testing_state() if is_local_docker_deployment() else None
    meta = None
    if local_testing_state is None:
        meta = db.fetch_one(
            """
            SELECT ala.artifact_id, ala.updated_at, la.sha256
            FROM active_license_artifact ala
            LEFT JOIN license_artifacts la ON la.artifact_id = ala.artifact_id
            WHERE ala.slot = 'default'
            LIMIT 1
            """
        )
    cache_key = (
        "local:%s:%s"
        % (
            "enabled" if local_testing_state and local_testing_state["emulate_license_enabled"] else "disabled",
            local_testing_state.get("updated_at") or "none",
        )
        if local_testing_state is not None
        else "%s:%s:%s"
        % (
            meta.get("artifact_id") if meta else "missing",
            meta.get("sha256") if meta else "none",
            _normalize_timestamp(meta.get("updated_at")) if meta else "none",
        )
    )
    now_ts = datetime.now(timezone.utc).timestamp()

    with _cache_lock:
        if _summary_cache and _summary_cache["cache_key"] == cache_key and _summary_cache["expires_at_ts"] > now_ts:
            return _summary_cache["summary"]

    if local_testing_state is not None:
        summary = (
            _local_docker_license_summary()
            if local_testing_state["emulate_license_enabled"]
            else _fallback_summary("license_missing", status="missing", verification_status="missing")
        )
    elif not meta or not meta.get("artifact_id"):
        summary = _fallback_summary("license_missing", status="missing", verification_status="missing")
    else:
        artifact = db.fetch_one(
            """
            SELECT artifact_id,
                   raw_license_text,
                   sha256,
                   uploaded_by_oid,
                   uploaded_by_upn,
                   uploaded_by_name,
                   uploaded_at,
                   verification_status,
                   verification_error
            FROM license_artifacts
            WHERE artifact_id = %s
            LIMIT 1
            """,
            [meta["artifact_id"]],
        )
        if not artifact:
            summary = _fallback_summary(
                "active_license_artifact_missing_row",
                artifact_id=meta.get("artifact_id"),
                sha256=meta.get("sha256"),
            )
        else:
            summary = summarize_license_artifact(
                artifact["raw_license_text"],
                artifact_id=artifact["artifact_id"],
                uploaded_at=artifact.get("uploaded_at"),
                uploaded_by={
                    "oid": artifact.get("uploaded_by_oid"),
                    "upn": artifact.get("uploaded_by_upn"),
                    "name": artifact.get("uploaded_by_name"),
                },
            )

    with _cache_lock:
        _summary_cache = {
            "cache_key": cache_key,
            "expires_at_ts": now_ts + max(1, ttl_seconds),
            "summary": summary,
        }
    return summary


def require_license_feature(feature_key: str) -> Dict[str, Any]:
    summary = get_current_license()
    if summary["features"].get(feature_key):
        return summary
    raise LicenseFeatureError(feature_key, summary)


def get_job_type_license_feature(job_type: Optional[str]) -> Optional[str]:
    if not job_type:
        return None
    return JOB_TYPE_LICENSE_FEATURES.get(str(job_type))
