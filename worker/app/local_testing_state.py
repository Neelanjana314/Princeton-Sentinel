from typing import Any, Dict

from app import db


def _normalize_timestamp(value):
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def get_local_testing_state() -> Dict[str, Any]:
    row = db.fetch_one(
        """
        SELECT emulate_license_enabled, updated_at
        FROM local_testing_state
        WHERE state_key = 'default'
        LIMIT 1
        """
    )

    return {
        "emulate_license_enabled": bool(row["emulate_license_enabled"]) if row else True,
        "updated_at": _normalize_timestamp(row.get("updated_at")) if row else None,
    }
