"""Manage Entra ID Conditional Access policies for Copilot agent kill-switch.

Each agent gets at most one CA policy named ``Sentinel-Block-{bot_id}``.
Blocked users are added to the policy's ``conditions.users.includeUsers`` array.
When the last user is unblocked the policy is deleted.

All methods return a ``(success, detail)`` tuple so callers can persist
``entra_sync_status`` / ``entra_sync_error`` without try/except boilerplate.
"""

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from app.graph_client import GraphClient, GraphError
from app.runtime_config import get_runtime_env
from app.runtime_logger import emit

POLICY_PREFIX = "Sentinel-Block-"

CA_BASE = "/identity/conditionalAccess/policies"


# ── Result types ───────────────────────────────────────────────────────────

@dataclass
class CAResult:
    success: bool
    policy_id: Optional[str] = None
    error: Optional[str] = None


# ── Helper ─────────────────────────────────────────────────────────────────

def _policy_display_name(bot_id: str) -> str:
    return f"{POLICY_PREFIX}{bot_id}"


def _build_policy_body(
    display_name: str,
    user_ids: List[str],
    app_id: str,
) -> Dict[str, Any]:
    """Build the JSON body for creating / patching a CA policy."""
    return {
        "displayName": display_name,
        "state": "enabled",
        "conditions": {
            "users": {
                "includeUsers": user_ids,
            },
            "applications": {
                "includeApplications": [app_id],
            },
        },
        "grantControls": {
            "operator": "OR",
            "builtInControls": ["block"],
        },
    }


# ── Core class ─────────────────────────────────────────────────────────────

class ConditionalAccessManager:
    """Thin wrapper around the Graph ``/identity/conditionalAccess`` endpoints."""

    def __init__(self, graph: Optional[GraphClient] = None):
        self._graph = graph or GraphClient()

    # ── read ────────────────────────────────────────────────────────────

    def find_policy_for_bot(self, bot_id: str) -> Optional[Dict[str, Any]]:
        """Return the existing Sentinel CA policy for *bot_id*, or ``None``."""
        display_name = _policy_display_name(bot_id)
        try:
            data = self._graph.get_json(
                f"{CA_BASE}?$filter=displayName eq '{display_name}'"
            )
            policies = data.get("value", [])
            return policies[0] if policies else None
        except GraphError as exc:
            emit("ERROR", "CA", f"find_policy_for_bot failed: bot_id={bot_id} error={exc}")
            raise

    def get_blocked_users(self, bot_id: str) -> List[str]:
        """Return the list of user object IDs currently blocked for *bot_id*."""
        policy = self.find_policy_for_bot(bot_id)
        if not policy:
            return []
        return (
            policy.get("conditions", {})
            .get("users", {})
            .get("includeUsers", [])
        )

    # ── block ───────────────────────────────────────────────────────────

    def block_user(self, bot_id: str, bot_name: str, user_id: str) -> CAResult:
        """Add *user_id* to the block policy for *bot_id*.

        Creates the policy if it does not exist; patches it otherwise.
        """
        copilot_app_id = (get_runtime_env("COPILOT_APP_ID") or "").strip()
        if not copilot_app_id:
            return CAResult(
                success=False,
                error="COPILOT_APP_ID env var is not configured",
            )

        display_name = _policy_display_name(bot_id)

        try:
            existing = self.find_policy_for_bot(bot_id)
        except GraphError as exc:
            return _graph_error_to_result(exc, "find_policy")

        # ── Policy exists → patch the user list ────────────────────────
        if existing:
            policy_id = existing["id"]
            current_users: List[str] = (
                existing.get("conditions", {})
                .get("users", {})
                .get("includeUsers", [])
            )
            if user_id in current_users:
                emit("INFO", "CA", f"User already blocked: user={user_id} bot={bot_id}")
                return CAResult(success=True, policy_id=policy_id)

            updated_users = current_users + [user_id]
            patch_body = {
                "conditions": {
                    "users": {
                        "includeUsers": updated_users,
                    },
                },
            }
            try:
                self._graph.request_json("PATCH", f"{CA_BASE}/{policy_id}", json=patch_body)
            except GraphError as exc:
                return _graph_error_to_result(exc, "patch_policy")

            emit("INFO", "CA", f"User added to existing policy: user={user_id} bot={bot_id} policy={policy_id}")
            return CAResult(success=True, policy_id=policy_id)

        # ── No policy yet → create ─────────────────────────────────────
        body = _build_policy_body(display_name, [user_id], copilot_app_id)
        try:
            result = self._graph.request_json("POST", CA_BASE, json=body)
        except GraphError as exc:
            return _graph_error_to_result(exc, "create_policy")

        policy_id = result.get("id")
        emit("INFO", "CA", f"Policy created: user={user_id} bot={bot_id} policy={policy_id}")
        return CAResult(success=True, policy_id=policy_id)

    # ── unblock ─────────────────────────────────────────────────────────

    def unblock_user(self, bot_id: str, user_id: str) -> CAResult:
        """Remove *user_id* from the block policy for *bot_id*.

        Deletes the policy entirely if no users remain.
        """
        try:
            existing = self.find_policy_for_bot(bot_id)
        except GraphError as exc:
            return _graph_error_to_result(exc, "find_policy")

        if not existing:
            emit("WARN", "CA", f"No policy found to unblock: user={user_id} bot={bot_id}")
            return CAResult(success=True, policy_id=None)

        policy_id = existing["id"]
        current_users: List[str] = (
            existing.get("conditions", {})
            .get("users", {})
            .get("includeUsers", [])
        )

        if user_id not in current_users:
            emit("INFO", "CA", f"User not in policy, nothing to unblock: user={user_id} bot={bot_id}")
            return CAResult(success=True, policy_id=policy_id)

        remaining = [u for u in current_users if u != user_id]

        # ── Last user removed → delete the whole policy ────────────────
        if not remaining:
            try:
                self._graph.request_json("DELETE", f"{CA_BASE}/{policy_id}")
            except GraphError as exc:
                return _graph_error_to_result(exc, "delete_policy")

            emit("INFO", "CA", f"Policy deleted (last user removed): bot={bot_id} policy={policy_id}")
            return CAResult(success=True, policy_id=None)

        # ── Other users remain → patch ─────────────────────────────────
        patch_body = {
            "conditions": {
                "users": {
                    "includeUsers": remaining,
                },
            },
        }
        try:
            self._graph.request_json("PATCH", f"{CA_BASE}/{policy_id}", json=patch_body)
        except GraphError as exc:
            return _graph_error_to_result(exc, "patch_policy")

        emit("INFO", "CA", f"User removed from policy: user={user_id} bot={bot_id} policy={policy_id}")
        return CAResult(success=True, policy_id=policy_id)

    # ── list (for reconciliation / UI) ──────────────────────────────────

    def list_sentinel_policies(self) -> Tuple[bool, List[Dict[str, Any]]]:
        """Return all CA policies with the ``Sentinel-Block-`` prefix."""
        try:
            data = self._graph.get_json(
                f"{CA_BASE}?$filter=startsWith(displayName, '{POLICY_PREFIX}')"
            )
            return True, data.get("value", [])
        except GraphError as exc:
            emit("ERROR", "CA", f"list_sentinel_policies failed: error={exc}")
            return False, []

    # ── global agent disable/enable ──────────────────────────────────

    def get_service_principal_object_id(self, app_registration_id: str) -> Optional[str]:
        """Look up the Entra service principal object ID for an app registration."""
        try:
            data = self._graph.get_json(
                f"/servicePrincipals?$filter=appId eq '{app_registration_id}'&$select=id"
            )
            principals = data.get("value", [])
            return principals[0]["id"] if principals else None
        except GraphError as exc:
            emit("ERROR", "CA", f"get_service_principal_object_id failed: appId={app_registration_id} error={exc}")
            return None

    def disable_agent(self, service_principal_object_id: str) -> CAResult:
        """Disable an agent's service principal — blocks ALL users immediately."""
        try:
            self._graph.request_json(
                "PATCH", f"/servicePrincipals/{service_principal_object_id}",
                json={"accountEnabled": False},
            )
            emit("INFO", "CA", f"Agent disabled: service_principal_object_id={service_principal_object_id}")
            return CAResult(success=True)
        except GraphError as exc:
            return _graph_error_to_result(exc, "disable_agent")

    def enable_agent(self, service_principal_object_id: str) -> CAResult:
        """Re-enable an agent's service principal — restores access for all users."""
        try:
            self._graph.request_json(
                "PATCH", f"/servicePrincipals/{service_principal_object_id}",
                json={"accountEnabled": True},
            )
            emit("INFO", "CA", f"Agent re-enabled: service_principal_object_id={service_principal_object_id}")
            return CAResult(success=True)
        except GraphError as exc:
            return _graph_error_to_result(exc, "enable_agent")


# ── Helpers ────────────────────────────────────────────────────────────────

def _graph_error_to_result(exc: GraphError, context: str) -> CAResult:
    """Convert a GraphError to a CAResult with a human-readable message."""
    if exc.status_code == 403:
        msg = "Admin consent not granted for Policy.ReadWrite.ConditionalAccess"
    elif exc.status_code == 401:
        msg = "Authentication failed — check ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET"
    else:
        msg = f"{context}: {exc.status_code} — {exc.message[:200]}"

    emit("ERROR", "CA", f"Graph CA error: context={context} status={exc.status_code} error={exc.message[:200]}")
    return CAResult(success=False, error=msg)
