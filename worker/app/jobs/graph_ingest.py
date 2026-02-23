import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Hashable, Iterable, Optional, Tuple

from app import db
from app.graph_client import GraphClient, GraphError
from app.jobs.mv_refresh import enqueue_impacted_mvs_for_tables
from app.runtime_logger import emit
from app.utils import log_audit_event, log_job_run_log


FLUSH_EVERY_DEFAULT = int(os.getenv("FLUSH_EVERY", "500"))
GRAPH_PAGE_SIZE = int(os.getenv("GRAPH_PAGE_SIZE", "200"))
GRAPH_MAX_CONCURRENCY = int(os.getenv("GRAPH_MAX_CONCURRENCY", "4"))

DEFAULT_PERMISSIONS_BATCH_SIZE = int(os.getenv("GRAPH_PERMISSIONS_BATCH_SIZE", "50"))
DEFAULT_PERMISSIONS_STALE_AFTER_HOURS = int(os.getenv("GRAPH_PERMISSIONS_STALE_AFTER_HOURS", "24"))

STAGE_IMPACTED_TABLES: Dict[str, Tuple[str, ...]] = {
    "users": ("msgraph_users",),
    "groups": ("msgraph_groups",),
    "group_memberships": ("msgraph_group_memberships",),
    "sites": ("msgraph_sites",),
    "drives": ("msgraph_drives",),
    "drive_items": ("msgraph_drive_items",),
    "permissions": ("msgraph_drive_item_permissions", "msgraph_drive_item_permission_grants"),
}


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if value in {"0", "false", "f", "no", "n", "off"}:
        return False
    return default


def _env_csv(name: str) -> list[str]:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return []
    return [part.strip() for part in raw.split(",") if part.strip()]


def get_graph_sync_runtime_config() -> Dict[str, Any]:
    return {
        "flush_every": FLUSH_EVERY_DEFAULT,
        "pull_permissions": _env_bool("GRAPH_SYNC_PULL_PERMISSIONS", True),
        "sync_group_memberships": _env_bool("GRAPH_SYNC_GROUP_MEMBERSHIPS", True),
        "group_memberships_users_only": _env_bool("GRAPH_SYNC_GROUP_MEMBERSHIPS_USERS_ONLY", True),
        "stages": _env_csv("GRAPH_SYNC_STAGES"),
        "skip_stages": _env_csv("GRAPH_SYNC_SKIP_STAGES"),
        "permissions_batch_size": DEFAULT_PERMISSIONS_BATCH_SIZE,
        "permissions_stale_after_hours": DEFAULT_PERMISSIONS_STALE_AFTER_HOURS,
    }


def _compact_json(value: Any, *, max_len: int = 300) -> str:
    try:
        text = json.dumps(value, sort_keys=True, default=str)
    except TypeError:
        text = str(value)
    text = text.replace("\n", " ").replace("\r", " ").strip()
    if len(text) > max_len:
        return text[: max_len - 3] + "..."
    return text


def _dedupe_rows_keep_last(rows: list[tuple], key_fn: Callable[[tuple], Hashable]) -> tuple[list[tuple], int]:
    if len(rows) < 2:
        return rows, 0
    seen: set[Hashable] = set()
    out_rev: list[tuple] = []
    for row in reversed(rows):
        key = key_fn(row)
        if key in seen:
            continue
        seen.add(key)
        out_rev.append(row)
    if len(out_rev) == len(rows):
        return rows, 0
    out = list(reversed(out_rev))
    return out, len(rows) - len(out)


def _execute_values_dedup_keep_last(
    cur,
    query: str,
    rows: list[tuple],
    *,
    key_fn: Callable[[tuple], Hashable],
) -> tuple[int, int]:
    deduped, dropped = _dedupe_rows_keep_last(rows, key_fn)
    if deduped:
        db.execute_values(cur, query, deduped)
    return len(deduped), dropped


def _merge_drive_rows(existing: tuple, new: tuple) -> tuple:
    merged = list(existing)
    for idx, value in enumerate(new):
        if value is not None:
            merged[idx] = value
    return tuple(merged)


def _dedupe_drive_rows(rows: list[tuple]) -> tuple[list[tuple], int]:
    if len(rows) < 2:
        return rows, 0
    merged_by_id: dict[Hashable, tuple] = {}
    dropped = 0
    for row in rows:
        drive_id = row[0]
        if drive_id in merged_by_id:
            merged_by_id[drive_id] = _merge_drive_rows(merged_by_id[drive_id], row)
            dropped += 1
        else:
            merged_by_id[drive_id] = row
    if dropped == 0:
        return rows, 0
    return list(merged_by_id.values()), dropped


def _execute_values_dedup_merge_drives(
    cur,
    query: str,
    rows: list[tuple],
) -> tuple[int, int]:
    deduped, dropped = _dedupe_drive_rows(rows)
    if deduped:
        db.execute_values(cur, query, deduped)
    return len(deduped), dropped


def _execute_db_mutation_with_retry(
    conn,
    *,
    run_id: str,
    op_name: str,
    retry_log_message: str,
    mutation_fn: Callable[[], None],
) -> tuple[bool, int, Optional[str], Optional[str]]:
    max_retries, base_ms, max_ms, jitter_ms = db.get_db_write_retry_config()
    retries = 0
    while True:
        try:
            mutation_fn()
            conn.commit()
            return True, retries, None, None
        except Exception as exc:
            conn.rollback()
            sqlstate = db.get_db_error_sqlstate(exc)
            if not db.is_retryable_db_error(exc):
                emit("ERROR", "GRAPH", f"DB mutation failed: operation={op_name} sqlstate={sqlstate} error={exc}")
                raise
            if retries >= max_retries:
                emit(
                    "ERROR",
                    "GRAPH",
                    f"DB mutation retries exhausted: operation={op_name} retries={retries} sqlstate={sqlstate} error={exc}",
                )
                return False, retries, sqlstate, str(exc)

            retries += 1
            sleep_seconds = db.compute_db_write_retry_sleep_seconds(
                retries,
                base_ms=base_ms,
                max_ms=max_ms,
                jitter_ms=jitter_ms,
            )
            log_job_run_log(
                run_id=run_id,
                level="WARN",
                message=retry_log_message,
                context={
                    "operation": op_name,
                    "retry_attempt": retries,
                    "max_retries": max_retries,
                    "sqlstate": sqlstate,
                    "error": str(exc),
                    "sleep_ms": int(round(sleep_seconds * 1000)),
                },
            )
            emit(
                "WARN",
                "GRAPH",
                f"DB mutation retry: operation={op_name} attempt={retries}/{max_retries} sqlstate={sqlstate} sleep_ms={int(round(sleep_seconds * 1000))}",
            )
            time.sleep(sleep_seconds)


def _load_user_maps(cur) -> tuple[dict[str, str], dict[str, str]]:
    cur.execute(
        """
        SELECT id, mail, user_principal_name
        FROM msgraph_users
        WHERE deleted_at IS NULL
        """
    )
    users_by_id: dict[str, str] = {}
    users_by_email: dict[str, str] = {}
    for user_id, mail, upn in cur.fetchall():
        if not user_id:
            continue
        users_by_id[user_id] = user_id
        if isinstance(mail, str) and mail:
            users_by_email[mail.lower()] = user_id
        if isinstance(upn, str) and upn:
            users_by_email[upn.lower()] = user_id
    return users_by_id, users_by_email


def _resolve_identity(
    identity: Optional[Dict[str, Any]],
    users_by_id: dict[str, str],
    users_by_email: dict[str, str],
) -> tuple[Optional[str], str, Optional[str], Optional[str], Optional[str]]:
    def to_user_fk(gid: Optional[str], email_like: Optional[str]) -> Optional[str]:
        if gid and gid in users_by_id:
            return gid
        if email_like:
            key = email_like.lower()
            if key in users_by_email:
                return users_by_email[key]
        return None

    def looks_system(display: Optional[str]) -> bool:
        if not display:
            return False
        d = display.strip().lower()
        system_names = {
            "system account",
            "sharepoint app",
            "sharepoint",
            "microsoft office",
            "sharepoint migration tool",
        }
        return d in system_names or "system" in d

    if not identity or not isinstance(identity, dict):
        return None, "unknown", None, None, None

    for key in ("user", "group", "application", "siteGroup", "siteUser", "device", "site"):
        if key in identity and isinstance(identity[key], dict):
            obj = identity[key]
            disp = obj.get("displayName") or obj.get("name")
            email = obj.get("email") or obj.get("userPrincipalName")
            gid = obj.get("id")
            if key == "user":
                if (not gid and not email and looks_system(disp)) or looks_system(disp):
                    return None, "system", disp, None, None
                return to_user_fk(gid, email), "user", disp, email, gid
            if key == "group":
                return None, "group", disp, None, gid
            if key == "application":
                return None, "application", disp, None, gid
            return None, "sharepoint", disp, None, gid

    otype = identity.get("@odata.type") or identity.get("odata.type")
    if isinstance(otype, str):
        disp = identity.get("displayName") or identity.get("name")
        gid = identity.get("id")
        email = identity.get("email") or identity.get("userPrincipalName")
        if looks_system(disp) and not gid and not email:
            return None, "system", disp, None, None
        if "userIdentity" in otype:
            return to_user_fk(gid, email), "user", disp, email, gid
        if "groupIdentity" in otype:
            return None, "group", disp, None, gid
        if "appIdentity" in otype or "application" in otype:
            return None, "application", disp, None, gid
        if "sharepoint" in otype or "site" in otype or "deviceIdentity" in otype:
            return None, "sharepoint", disp, None, gid

    disp = identity.get("displayName")
    if looks_system(disp):
        return None, "system", disp, None, None

    return None, "unknown", disp, identity.get("email") or identity.get("userPrincipalName"), identity.get("id")


def _compute_path_level(normalized_path: Optional[str]) -> Optional[int]:
    if not normalized_path:
        return None
    path = normalized_path
    if ":" in path:
        path = path.split(":", 1)[1]
    path = path.strip()
    if not path:
        return 0
    path = path.lstrip("/")
    if not path:
        return 0
    return len([seg for seg in path.split("/") if seg])


def run_graph_ingest(*, run_id: str, job_id: str, actor: Optional[Dict[str, Any]] = None):
    config = get_graph_sync_runtime_config()
    started_at = datetime.now(timezone.utc)
    flush_every = int(config.get("flush_every", FLUSH_EVERY_DEFAULT))
    pull_permissions = bool(config.get("pull_permissions", True))
    sync_group_memberships = bool(config.get("sync_group_memberships", True))
    group_memberships_users_only = bool(config.get("group_memberships_users_only", True))
    requested_stages = config.get("stages")
    skip_stages = set(config.get("skip_stages") or [])

    client = GraphClient()
    emit(
        "INFO",
        "GRAPH",
        (
            f"Job started: run_id={run_id} job_id={job_id} "
            f"flush_every={flush_every} pull_permissions={pull_permissions} "
            f"sync_group_memberships={sync_group_memberships} users_only={group_memberships_users_only} "
            f"requested_stages={_compact_json(requested_stages)} skip_stages={_compact_json(sorted(skip_stages))}"
        ),
    )

    log_audit_event(
        action="graph_ingest_started",
        entity_type="job_run",
        entity_id=run_id,
        actor=actor,
        details={"job_id": job_id},
    )
    log_job_run_log(
        run_id=run_id,
        level="INFO",
        message="graph_ingest_started",
        context={"job_id": job_id, "started_at": started_at.isoformat()},
    )

    stage_order = [
        "users",
        "groups",
        "group_memberships",
        "sites",
        "drives",
        "drive_items",
        "permissions",
    ]
    if isinstance(requested_stages, list) and requested_stages:
        stage_order = [str(s) for s in requested_stages]

    stages: Dict[str, Any] = {}
    for stage in stage_order:
        if stage in skip_stages:
            stages[stage] = {"skipped": True}
            emit("INFO", "GRAPH", f"Stage completed: {stage} summary={_compact_json(stages[stage])}")
            continue

        log_job_run_log(
            run_id=run_id,
            level="INFO",
            message=f"stage_started:{stage}",
            context={"job_id": job_id},
        )
        emit("INFO", "GRAPH", f"Stage started: {stage}")

        stage_result: Dict[str, Any]
        if stage == "users":
            stage_result = _ingest_users(client, run_id=run_id, flush_every=flush_every)
            stages["users"] = stage_result
        elif stage == "groups":
            stage_result = _ingest_groups(client, run_id=run_id, flush_every=flush_every)
            stages["groups"] = stage_result
        elif stage == "group_memberships":
            if not sync_group_memberships:
                stage_result = {"skipped": True, "reason": "sync_group_memberships_disabled"}
                stages["group_memberships"] = stage_result
            else:
                stage_result = _ingest_group_memberships(
                    client,
                    run_id=run_id,
                    flush_every=flush_every,
                    users_only=group_memberships_users_only,
                )
                stages["group_memberships"] = stage_result
        elif stage == "sites":
            stage_result = _ingest_sites(client, run_id=run_id, flush_every=flush_every)
            stages["sites"] = stage_result
        elif stage == "drives":
            stage_result = _ingest_drives(client, run_id=run_id, flush_every=flush_every)
            stages["drives"] = stage_result
        elif stage == "drive_items":
            stage_result = _ingest_drive_items(client, run_id=run_id, flush_every=flush_every)
            stages["drive_items"] = stage_result
        elif stage == "permissions":
            if not pull_permissions:
                stage_result = {"skipped": True, "reason": "pull_permissions_disabled"}
                stages["permissions"] = stage_result
            else:
                stage_result = _scan_permissions(client, config, run_id=run_id)
                stages["permissions"] = stage_result
        else:
            stage_result = {"skipped": True, "reason": "unknown_stage"}
            stages[stage] = stage_result

        emit("INFO", "GRAPH", f"Stage completed: {stage} summary={_compact_json(stage_result)}")

    queued_mvs_summary: Dict[str, Any] = {"tables": [], "queued": 0, "queued_mvs": []}
    try:
        touched_tables: set[str] = set()
        for stage_name, stage_result in stages.items():
            if isinstance(stage_result, dict) and stage_result.get("skipped"):
                continue
            touched_tables.update(STAGE_IMPACTED_TABLES.get(stage_name, ()))
        queued_mvs_summary = enqueue_impacted_mvs_for_tables(sorted(touched_tables))
        emit(
            "INFO",
            "GRAPH",
            f"Queued impacted MVs: queued={queued_mvs_summary.get('queued', 0)} tables={_compact_json(queued_mvs_summary.get('tables', []))}",
        )
    except Exception as exc:
        emit("WARN", "GRAPH", f"Failed to queue impacted MVs: error={exc}")
    stages["mv_refresh_queue"] = queued_mvs_summary

    log_job_run_log(
        run_id=run_id,
        level="INFO",
        message="graph_ingest_completed",
        context={"job_id": job_id, "stages": stages, "started_at": started_at.isoformat()},
    )
    log_audit_event(
        action="graph_ingest_completed",
        entity_type="job_run",
        entity_id=run_id,
        actor=actor,
        details={"job_id": job_id, "stages": stages},
    )
    duration_seconds = int((datetime.now(timezone.utc) - started_at).total_seconds())
    emit(
        "INFO",
        "GRAPH",
        f"Job finished: run_id={run_id} job_id={job_id} duration_seconds={duration_seconds} stages={_compact_json(stages, max_len=500)}",
    )


def _get_delta_link(cur, resource_type: str, partition_key: str) -> Optional[str]:
    cur.execute(
        "SELECT delta_link FROM msgraph_delta_state WHERE resource_type = %s AND partition_key = %s",
        [resource_type, partition_key],
    )
    row = cur.fetchone()
    if not row:
        return None
    return row[0]


def _set_delta_link(cur, resource_type: str, partition_key: str, delta_link: str):
    cur.execute(
        """
        INSERT INTO msgraph_delta_state (resource_type, partition_key, delta_link, last_synced_at)
        VALUES (%s, %s, %s, now())
        ON CONFLICT (resource_type, partition_key)
        DO UPDATE SET delta_link = EXCLUDED.delta_link, last_synced_at = EXCLUDED.last_synced_at
        """,
        [resource_type, partition_key, delta_link],
    )


def _ingest_users(client: GraphClient, *, run_id: str, flush_every: int) -> Dict[str, Any]:
    synced_at = datetime.now(timezone.utc)
    select = ",".join(
        [
            "id",
            "displayName",
            "userPrincipalName",
            "mail",
            "accountEnabled",
            "userType",
            "jobTitle",
            "department",
            "officeLocation",
            "usageLocation",
            "createdDateTime",
        ]
    )

    upsert_sql = """
        INSERT INTO msgraph_users
          (id, display_name, user_principal_name, mail, account_enabled, user_type, job_title,
           department, office_location, usage_location, created_dt, synced_at, deleted_at, raw_json)
        VALUES %s
        ON CONFLICT (id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          user_principal_name = EXCLUDED.user_principal_name,
          mail = EXCLUDED.mail,
          account_enabled = EXCLUDED.account_enabled,
          user_type = EXCLUDED.user_type,
          job_title = EXCLUDED.job_title,
          department = EXCLUDED.department,
          office_location = EXCLUDED.office_location,
          usage_location = EXCLUDED.usage_location,
          created_dt = EXCLUDED.created_dt,
          synced_at = EXCLUDED.synced_at,
          deleted_at = NULL,
          raw_json = EXCLUDED.raw_json
    """

    total = 0
    flushed = 0
    dropped_duplicates = 0

    conn = db.get_conn()
    try:
        cur = conn.cursor()
        batch: list[tuple] = []
        for user in client.iter_paged(f"/users?$select={select}&$top=999"):
            user_id = user.get("id")
            if not user_id:
                continue
            batch.append(
                (
                    user_id,
                    user.get("displayName"),
                    user.get("userPrincipalName"),
                    user.get("mail"),
                    user.get("accountEnabled"),
                    user.get("userType"),
                    user.get("jobTitle"),
                    user.get("department"),
                    user.get("officeLocation"),
                    user.get("usageLocation"),
                    user.get("createdDateTime"),
                    synced_at,
                    None,
                    db.jsonb(user),
                )
            )
            total += 1
            if len(batch) >= flush_every:
                executed, dropped = _execute_values_dedup_keep_last(cur, upsert_sql, batch, key_fn=lambda r: r[0])
                conn.commit()
                flushed += executed
                dropped_duplicates += dropped
                batch = []

        if batch:
            executed, dropped = _execute_values_dedup_keep_last(cur, upsert_sql, batch, key_fn=lambda r: r[0])
            conn.commit()
            flushed += executed
            dropped_duplicates += dropped

        cur.execute(
            """
            UPDATE msgraph_users
            SET deleted_at = %s, synced_at = %s
            WHERE synced_at < %s AND deleted_at IS NULL
            """,
            [synced_at, synced_at, synced_at],
        )
        marked_deleted = cur.rowcount
        conn.commit()

        log_job_run_log(
            run_id=run_id,
            level="INFO",
            message="users_ingested",
            context={
                "synced_at": synced_at.isoformat(),
                "total_seen": total,
                "upserted": flushed,
                "dropped_duplicates": dropped_duplicates,
                "marked_deleted": marked_deleted,
            },
        )
        return {"total_seen": total, "upserted": flushed, "dropped_duplicates": dropped_duplicates, "marked_deleted": marked_deleted}
    finally:
        conn.close()


def _ingest_groups(client: GraphClient, *, run_id: str, flush_every: int) -> Dict[str, Any]:
    synced_at = datetime.now(timezone.utc)
    select = ",".join(
        [
            "id",
            "displayName",
            "mail",
            "mailEnabled",
            "securityEnabled",
            "groupTypes",
            "visibility",
            "isAssignableToRole",
            "createdDateTime",
        ]
    )

    upsert_sql = """
        INSERT INTO msgraph_groups
          (id, display_name, mail, mail_enabled, security_enabled, group_types,
           visibility, is_assignable_to_role, created_dt, synced_at, deleted_at, raw_json)
        VALUES %s
        ON CONFLICT (id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          mail = EXCLUDED.mail,
          mail_enabled = EXCLUDED.mail_enabled,
          security_enabled = EXCLUDED.security_enabled,
          group_types = EXCLUDED.group_types,
          visibility = EXCLUDED.visibility,
          is_assignable_to_role = EXCLUDED.is_assignable_to_role,
          created_dt = EXCLUDED.created_dt,
          synced_at = EXCLUDED.synced_at,
          deleted_at = NULL,
          raw_json = EXCLUDED.raw_json
    """

    total = 0
    flushed = 0
    dropped_duplicates = 0

    conn = db.get_conn()
    try:
        cur = conn.cursor()
        batch: list[tuple] = []
        for group in client.iter_paged(f"/groups?$select={select}&$top=999"):
            group_id = group.get("id")
            if not group_id:
                continue
            batch.append(
                (
                    group_id,
                    group.get("displayName"),
                    group.get("mail"),
                    group.get("mailEnabled"),
                    group.get("securityEnabled"),
                    group.get("groupTypes"),
                    group.get("visibility"),
                    group.get("isAssignableToRole"),
                    group.get("createdDateTime"),
                    synced_at,
                    None,
                    db.jsonb(group),
                )
            )
            total += 1
            if len(batch) >= flush_every:
                executed, dropped = _execute_values_dedup_keep_last(cur, upsert_sql, batch, key_fn=lambda r: r[0])
                conn.commit()
                flushed += executed
                dropped_duplicates += dropped
                batch = []

        if batch:
            executed, dropped = _execute_values_dedup_keep_last(cur, upsert_sql, batch, key_fn=lambda r: r[0])
            conn.commit()
            flushed += executed
            dropped_duplicates += dropped

        cur.execute(
            """
            UPDATE msgraph_groups
            SET deleted_at = %s, synced_at = %s
            WHERE synced_at < %s AND deleted_at IS NULL
            """,
            [synced_at, synced_at, synced_at],
        )
        marked_deleted = cur.rowcount
        conn.commit()

        log_job_run_log(
            run_id=run_id,
            level="INFO",
            message="groups_ingested",
            context={
                "synced_at": synced_at.isoformat(),
                "total_seen": total,
                "upserted": flushed,
                "dropped_duplicates": dropped_duplicates,
                "marked_deleted": marked_deleted,
            },
        )
        return {"total_seen": total, "upserted": flushed, "dropped_duplicates": dropped_duplicates, "marked_deleted": marked_deleted}
    finally:
        conn.close()


def _member_type(member: Dict[str, Any]) -> str:
    odata_type = (member.get("@odata.type") or "").strip()
    if odata_type.startswith("#microsoft.graph."):
        return odata_type[len("#microsoft.graph.") :]
    if odata_type.startswith("#"):
        return odata_type[1:]
    return odata_type or "directoryObject"


def _ingest_group_memberships(
    client: GraphClient,
    *,
    run_id: str,
    flush_every: int,
    users_only: bool,
) -> Dict[str, Any]:
    synced_at = datetime.now(timezone.utc)
    upsert_sql = """
        INSERT INTO msgraph_group_memberships
          (group_id, member_id, member_type, synced_at, deleted_at, raw_json)
        VALUES %s
        ON CONFLICT (group_id, member_id, member_type) DO UPDATE SET
          synced_at = EXCLUDED.synced_at,
          deleted_at = NULL,
          raw_json = EXCLUDED.raw_json
    """

    group_count = 0
    edge_upserts = 0
    skipped_groups = 0
    dropped_duplicates = 0

    conn = db.get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT id FROM msgraph_groups WHERE deleted_at IS NULL")
        group_ids = [row[0] for row in cur.fetchall()]
        conn.commit()

        for group_id in group_ids:
            group_count += 1
            try:
                members_iter = client.iter_paged(f"/groups/{group_id}/members?$select=id,displayName,userPrincipalName,mail&$top=999")
                batch: list[tuple] = []
                for member in members_iter:
                    member_id = member.get("id")
                    if not member_id:
                        continue
                    mtype = _member_type(member)
                    if users_only and mtype != "user":
                        continue
                    batch.append((group_id, member_id, mtype, synced_at, None, db.jsonb(member)))
                    if len(batch) >= flush_every:
                        executed, dropped = _execute_values_dedup_keep_last(
                            cur,
                            upsert_sql,
                            batch,
                            key_fn=lambda r: (r[0], r[1], r[2]),
                        )
                        conn.commit()
                        edge_upserts += executed
                        dropped_duplicates += dropped
                        batch = []

                if batch:
                    executed, dropped = _execute_values_dedup_keep_last(
                        cur,
                        upsert_sql,
                        batch,
                        key_fn=lambda r: (r[0], r[1], r[2]),
                    )
                    conn.commit()
                    edge_upserts += executed
                    dropped_duplicates += dropped

                cur.execute(
                    """
                    UPDATE msgraph_group_memberships
                    SET deleted_at = %s
                    WHERE group_id = %s AND synced_at < %s AND deleted_at IS NULL
                    """,
                    [synced_at, group_id, synced_at],
                )
                conn.commit()
            except GraphError as exc:
                skipped_groups += 1
                emit(
                    "WARN",
                    "GRAPH",
                    f"Group memberships skipped: group_id={group_id} status_code={exc.status_code} error={exc}",
                )
                log_job_run_log(
                    run_id=run_id,
                    level="WARN",
                    message="group_memberships_skipped",
                    context={"group_id": group_id, "status_code": exc.status_code, "error": str(exc)},
                )
                conn.rollback()
                continue

        log_job_run_log(
            run_id=run_id,
            level="INFO",
            message="group_memberships_ingested",
            context={
                "synced_at": synced_at.isoformat(),
                "groups_processed": group_count,
                "edges_upserted": edge_upserts,
                "dropped_duplicates": dropped_duplicates,
                "skipped_groups": skipped_groups,
                "users_only": users_only,
            },
        )
        return {
            "groups_processed": group_count,
            "edges_upserted": edge_upserts,
            "dropped_duplicates": dropped_duplicates,
            "skipped_groups": skipped_groups,
            "users_only": users_only,
        }
    finally:
        conn.close()


def _normalize_site(
    site: Dict[str, Any],
) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str], Optional[str], Optional[str]]:
    site_collection = site.get("siteCollection") or {}
    sharepoint_ids = site.get("sharepointIds") or {}
    site_id = site.get("id")
    web_url = site.get("webUrl")

    hostname = site_collection.get("hostname") or site_collection.get("hostName")
    site_collection_id = sharepoint_ids.get("siteId") or site_collection.get("id")
    if site_id and site_id.count(",") >= 2:
        parts = site_id.split(",", 2)
        hostname = hostname or parts[0]
        site_collection_id = site_collection_id or parts[1]

    name = site.get("name") or site.get("displayName")
    created_dt = site.get("createdDateTime")
    return site_id, name, web_url, hostname, site_collection_id, created_dt


def _ingest_sites(client: GraphClient, *, run_id: str, flush_every: int) -> Dict[str, Any]:
    synced_at = datetime.now(timezone.utc)
    select = ",".join(
        [
            "id",
            "name",
            "displayName",
            "webUrl",
            "createdDateTime",
            "siteCollection",
            "sharepointIds",
            "isPersonalSite",
        ]
    )

    upsert_active_sql = """
        INSERT INTO msgraph_sites
          (id, name, web_url, hostname, site_collection_id, created_dt, synced_at, deleted_at, raw_json)
        VALUES %s
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          web_url = EXCLUDED.web_url,
          hostname = EXCLUDED.hostname,
          site_collection_id = EXCLUDED.site_collection_id,
          created_dt = EXCLUDED.created_dt,
          synced_at = EXCLUDED.synced_at,
          deleted_at = NULL,
          raw_json = EXCLUDED.raw_json
    """

    upsert_removed_sql = """
        INSERT INTO msgraph_sites
          (id, synced_at, deleted_at, raw_json)
        VALUES %s
        ON CONFLICT (id) DO UPDATE SET
          synced_at = EXCLUDED.synced_at,
          deleted_at = EXCLUDED.deleted_at,
          raw_json = EXCLUDED.raw_json
    """

    total = 0
    removed = 0
    flushed_active = 0
    flushed_removed = 0
    dropped_active_duplicates = 0
    dropped_removed_duplicates = 0
    mode = "delta"

    conn = db.get_conn()
    try:
        cur = conn.cursor()
        delta_link = _get_delta_link(cur, "sites", "global")
        next_url = delta_link or f"/sites/delta?$select={select}&$top=999"
        delta_link_new: Optional[str] = None

        active_batch: list[tuple] = []
        removed_batch: list[tuple] = []

        try:
            while next_url:
                data = client.get_json(next_url)
                for site in data.get("value", []) or []:
                    site_id = site.get("id")
                    if not site_id:
                        continue
                    total += 1
                    if "@removed" in site:
                        removed += 1
                        removed_batch.append((site_id, synced_at, synced_at, db.jsonb(site)))
                    else:
                        site_id, name, web_url, hostname, site_collection_id, created_dt = _normalize_site(site)
                        active_batch.append(
                            (
                                site_id,
                                name,
                                web_url,
                                hostname,
                                site_collection_id,
                                created_dt,
                                synced_at,
                                None,
                                db.jsonb(site),
                            )
                        )

                    if len(active_batch) >= flush_every:
                        executed, dropped = _execute_values_dedup_keep_last(cur, upsert_active_sql, active_batch, key_fn=lambda r: r[0])
                        conn.commit()
                        flushed_active += executed
                        dropped_active_duplicates += dropped
                        active_batch = []

                    if len(removed_batch) >= flush_every:
                        executed, dropped = _execute_values_dedup_keep_last(cur, upsert_removed_sql, removed_batch, key_fn=lambda r: r[0])
                        conn.commit()
                        flushed_removed += executed
                        dropped_removed_duplicates += dropped
                        removed_batch = []

                next_url = data.get("@odata.nextLink")
                delta_link_new = data.get("@odata.deltaLink") or delta_link_new
        except GraphError as exc:
            mode = "list_fallback"
            emit("WARN", "GRAPH", f"Sites delta failed, switching to full listing: status_code={exc.status_code} error={exc}")
            log_job_run_log(
                run_id=run_id,
                level="WARN",
                message="sites_delta_failed_fallback_to_list",
                context={"status_code": exc.status_code, "error": str(exc)},
            )
            conn.rollback()
            active_batch = []
            removed_batch = []
            total = 0
            removed = 0
            flushed_active = 0
            flushed_removed = 0

            for site in client.iter_paged(f"/sites?search=*&$select={select}&$top=999"):
                site_id = site.get("id")
                if not site_id:
                    continue
                total += 1
                site_id, name, web_url, hostname, site_collection_id, created_dt = _normalize_site(site)
                active_batch.append(
                    (
                        site_id,
                        name,
                        web_url,
                        hostname,
                        site_collection_id,
                        created_dt,
                        synced_at,
                        None,
                        db.jsonb(site),
                    )
                )
                if len(active_batch) >= flush_every:
                    executed, dropped = _execute_values_dedup_keep_last(cur, upsert_active_sql, active_batch, key_fn=lambda r: r[0])
                    conn.commit()
                    flushed_active += executed
                    dropped_active_duplicates += dropped
                    active_batch = []

        if active_batch:
            executed, dropped = _execute_values_dedup_keep_last(cur, upsert_active_sql, active_batch, key_fn=lambda r: r[0])
            conn.commit()
            flushed_active += executed
            dropped_active_duplicates += dropped

        if removed_batch:
            executed, dropped = _execute_values_dedup_keep_last(cur, upsert_removed_sql, removed_batch, key_fn=lambda r: r[0])
            conn.commit()
            flushed_removed += executed
            dropped_removed_duplicates += dropped

        if mode == "delta" and delta_link_new:
            _set_delta_link(cur, "sites", "global", delta_link_new)
            conn.commit()

        log_job_run_log(
            run_id=run_id,
            level="INFO",
            message="sites_ingested",
            context={
                "mode": mode,
                "synced_at": synced_at.isoformat(),
                "total_seen": total,
                "removed_seen": removed,
                "upserted_active": flushed_active,
                "upserted_removed": flushed_removed,
                "dropped_active_duplicates": dropped_active_duplicates,
                "dropped_removed_duplicates": dropped_removed_duplicates,
            },
        )
        return {
            "mode": mode,
            "total_seen": total,
            "removed_seen": removed,
            "upserted_active": flushed_active,
            "upserted_removed": flushed_removed,
            "dropped_active_duplicates": dropped_active_duplicates,
            "dropped_removed_duplicates": dropped_removed_duplicates,
        }
    finally:
        conn.close()


def _is_personal_site(site_row: Dict[str, Any]) -> bool:
    raw_json = site_row.get("raw_json") or {}
    raw: Dict[str, Any] = {}
    if isinstance(raw_json, dict):
        raw = raw_json
    elif isinstance(raw_json, str):
        try:
            raw = json.loads(raw_json)
        except Exception:
            raw = {}

    if raw.get("isPersonalSite") is True:
        return True
    hostname = (site_row.get("hostname") or (raw.get("siteCollection") or {}).get("hostname") or "").lower()
    web_url = (site_row.get("web_url") or raw.get("webUrl") or "").lower()
    return hostname.endswith("my.sharepoint.com") or "/personal/" in web_url


def _drive_row(
    drive: Dict[str, Any],
    *,
    site_id: Optional[str],
    owner_hint_id: Optional[str],
    owner_hint_type: Optional[str],
    synced_at: datetime,
    users_by_id: dict[str, str],
    users_by_email: dict[str, str],
) -> tuple:
    quota = drive.get("quota") or {}

    owner_user_id, owner_type, owner_display_name, owner_email, owner_graph_id = _resolve_identity(
        drive.get("owner"), users_by_id, users_by_email
    )
    if owner_hint_id and not owner_graph_id:
        owner_graph_id = owner_hint_id
    if owner_hint_id and owner_type in ("unknown", None):
        owner_type = owner_hint_type or owner_type
    if owner_hint_type == "user" and owner_hint_id and not owner_user_id:
        owner_user_id = owner_hint_id

    created_by_user_id, created_by_type, created_by_display_name, created_by_email, created_by_graph_id = _resolve_identity(
        drive.get("createdBy"), users_by_id, users_by_email
    )
    last_modified_by_user_id, last_modified_by_type, last_modified_by_display_name, last_modified_by_email, last_modified_by_graph_id = _resolve_identity(
        drive.get("lastModifiedBy"), users_by_id, users_by_email
    )

    return (
        drive.get("id"),
        site_id,
        drive.get("name"),
        drive.get("description"),
        drive.get("driveType"),
        drive.get("webUrl"),
        owner_user_id or owner_hint_id,
        owner_type,
        owner_display_name,
        owner_email,
        owner_graph_id,
        created_by_user_id,
        created_by_type,
        created_by_display_name,
        created_by_email,
        created_by_graph_id,
        last_modified_by_user_id,
        last_modified_by_type,
        last_modified_by_display_name,
        last_modified_by_email,
        last_modified_by_graph_id,
        drive.get("lastModifiedDateTime"),
        quota.get("total"),
        quota.get("used"),
        quota.get("remaining"),
        quota.get("deleted"),
        quota.get("state"),
        drive.get("createdDateTime"),
        synced_at,
        None,
        db.jsonb(drive),
    )


def _ingest_drives(client: GraphClient, *, run_id: str, flush_every: int) -> Dict[str, Any]:
    synced_at = datetime.now(timezone.utc)
    select = ",".join(
        [
            "id",
            "name",
            "description",
            "driveType",
            "webUrl",
            "createdDateTime",
            "lastModifiedDateTime",
            "owner",
            "createdBy",
            "lastModifiedBy",
            "quota",
        ]
    )
    upsert_sql = """
        INSERT INTO msgraph_drives
          (id, site_id, name, description, drive_type, web_url, owner_id, owner_type,
           owner_display_name, owner_email, owner_graph_id, created_by_user_id, created_by_type,
           created_by_display_name, created_by_email, created_by_graph_id, last_modified_by_user_id,
           last_modified_by_type, last_modified_by_display_name, last_modified_by_email,
           last_modified_by_graph_id, last_modified_dt, quota_total, quota_used, quota_remaining,
           quota_deleted, quota_state, created_dt, synced_at, deleted_at, raw_json)
        VALUES %s
        ON CONFLICT (id) DO UPDATE SET
          site_id = EXCLUDED.site_id,
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          drive_type = EXCLUDED.drive_type,
          web_url = EXCLUDED.web_url,
          owner_id = EXCLUDED.owner_id,
          owner_type = EXCLUDED.owner_type,
          owner_display_name = EXCLUDED.owner_display_name,
          owner_email = EXCLUDED.owner_email,
          owner_graph_id = EXCLUDED.owner_graph_id,
          created_by_user_id = EXCLUDED.created_by_user_id,
          created_by_type = EXCLUDED.created_by_type,
          created_by_display_name = EXCLUDED.created_by_display_name,
          created_by_email = EXCLUDED.created_by_email,
          created_by_graph_id = EXCLUDED.created_by_graph_id,
          last_modified_by_user_id = EXCLUDED.last_modified_by_user_id,
          last_modified_by_type = EXCLUDED.last_modified_by_type,
          last_modified_by_display_name = EXCLUDED.last_modified_by_display_name,
          last_modified_by_email = EXCLUDED.last_modified_by_email,
          last_modified_by_graph_id = EXCLUDED.last_modified_by_graph_id,
          last_modified_dt = EXCLUDED.last_modified_dt,
          quota_total = EXCLUDED.quota_total,
          quota_used = EXCLUDED.quota_used,
          quota_remaining = EXCLUDED.quota_remaining,
          quota_deleted = EXCLUDED.quota_deleted,
          quota_state = EXCLUDED.quota_state,
          created_dt = EXCLUDED.created_dt,
          synced_at = EXCLUDED.synced_at,
          deleted_at = NULL,
          raw_json = EXCLUDED.raw_json
    """

    site_count = 0
    site_skipped_personal = 0
    site_skipped_error = 0
    group_count = 0
    group_no_drive = 0
    user_count = 0
    user_no_drive = 0
    drive_upserts = 0
    dropped_duplicates = 0

    conn = db.get_conn()
    try:
        cur = conn.cursor()
        users_by_id, users_by_email = _load_user_maps(cur)

        cur.execute("SELECT id, hostname, web_url, raw_json FROM msgraph_sites WHERE deleted_at IS NULL")
        sites = [
            {"id": row[0], "hostname": row[1], "web_url": row[2], "raw_json": row[3]}
            for row in cur.fetchall()
        ]
        conn.commit()

        batch: list[tuple] = []
        for site in sites:
            site_count += 1
            site_id = site["id"]
            if _is_personal_site(site):
                site_skipped_personal += 1
                continue
            try:
                for drive in client.iter_paged(f"/sites/{site_id}/drives?$top={GRAPH_PAGE_SIZE}&$select={select}"):
                    if not drive.get("id"):
                        continue
                    batch.append(
                        _drive_row(
                            drive,
                            site_id=site_id,
                            owner_hint_id=None,
                            owner_hint_type=None,
                            synced_at=synced_at,
                            users_by_id=users_by_id,
                            users_by_email=users_by_email,
                        )
                    )
                    if len(batch) >= flush_every:
                        executed, dropped = _execute_values_dedup_merge_drives(cur, upsert_sql, batch)
                        conn.commit()
                        drive_upserts += executed
                        dropped_duplicates += dropped
                        batch = []
            except GraphError as exc:
                if exc.status_code not in (403, 404, 410):
                    site_skipped_error += 1
                emit("WARN", "GRAPH", f"Site drives skipped: site_id={site_id} status_code={exc.status_code} error={exc}")
                log_job_run_log(
                    run_id=run_id,
                    level="WARN",
                    message="site_drives_skipped",
                    context={"site_id": site_id, "status_code": exc.status_code, "error": str(exc)},
                )
                conn.rollback()

        cur.execute("SELECT id FROM msgraph_groups WHERE deleted_at IS NULL")
        group_ids = [row[0] for row in cur.fetchall()]
        conn.commit()
        for group_id in group_ids:
            group_count += 1
            try:
                has_drive = False
                for drive in client.iter_paged(f"/groups/{group_id}/drives?$top={GRAPH_PAGE_SIZE}&$select={select}"):
                    if not drive.get("id"):
                        continue
                    has_drive = True
                    batch.append(
                        _drive_row(
                            drive,
                            site_id=None,
                            owner_hint_id=group_id,
                            owner_hint_type="group",
                            synced_at=synced_at,
                            users_by_id=users_by_id,
                            users_by_email=users_by_email,
                        )
                    )
                if not has_drive:
                    group_no_drive += 1
            except GraphError as exc:
                if exc.status_code in (403, 404, 410):
                    group_no_drive += 1
                    emit("WARN", "GRAPH", f"Group has no accessible drives: group_id={group_id} status_code={exc.status_code}")
                    continue
                emit("ERROR", "GRAPH", f"Group drive listing failed: group_id={group_id} status_code={exc.status_code} error={exc}")
                raise

            if len(batch) >= flush_every:
                executed, dropped = _execute_values_dedup_merge_drives(cur, upsert_sql, batch)
                conn.commit()
                drive_upserts += executed
                dropped_duplicates += dropped
                batch = []

        cur.execute("SELECT id FROM msgraph_users WHERE deleted_at IS NULL")
        user_ids = [row[0] for row in cur.fetchall()]
        conn.commit()
        for user_id in user_ids:
            user_count += 1
            try:
                has_drive = False
                for drive in client.iter_paged(f"/users/{user_id}/drives?$top={GRAPH_PAGE_SIZE}&$select={select}"):
                    if not drive.get("id"):
                        continue
                    has_drive = True
                    batch.append(
                        _drive_row(
                            drive,
                            site_id=None,
                            owner_hint_id=user_id,
                            owner_hint_type="user",
                            synced_at=synced_at,
                            users_by_id=users_by_id,
                            users_by_email=users_by_email,
                        )
                    )
                if not has_drive:
                    user_no_drive += 1
            except GraphError as exc:
                if exc.status_code in (403, 404, 410):
                    user_no_drive += 1
                    emit("WARN", "GRAPH", f"User has no accessible drives: user_id={user_id} status_code={exc.status_code}")
                    continue
                emit("ERROR", "GRAPH", f"User drive listing failed: user_id={user_id} status_code={exc.status_code} error={exc}")
                raise

            if len(batch) >= flush_every:
                executed, dropped = _execute_values_dedup_merge_drives(cur, upsert_sql, batch)
                conn.commit()
                drive_upserts += executed
                dropped_duplicates += dropped
                batch = []

        if batch:
            executed, dropped = _execute_values_dedup_merge_drives(cur, upsert_sql, batch)
            conn.commit()
            drive_upserts += executed
            dropped_duplicates += dropped

        log_job_run_log(
            run_id=run_id,
            level="INFO",
            message="drives_ingested",
            context={
                "synced_at": synced_at.isoformat(),
                "sites_processed": site_count,
                "sites_skipped_personal": site_skipped_personal,
                "sites_skipped_error": site_skipped_error,
                "groups_processed": group_count,
                "groups_no_drive": group_no_drive,
                "users_processed": user_count,
                "users_no_drive": user_no_drive,
                "drive_upserts": drive_upserts,
                "dropped_duplicates": dropped_duplicates,
            },
        )
        return {
            "sites_processed": site_count,
            "sites_skipped_personal": site_skipped_personal,
            "sites_skipped_error": site_skipped_error,
            "groups_processed": group_count,
            "groups_no_drive": group_no_drive,
            "users_processed": user_count,
            "users_no_drive": user_no_drive,
            "drive_upserts": drive_upserts,
            "dropped_duplicates": dropped_duplicates,
        }
    finally:
        conn.close()


def _item_path(item: Dict[str, Any]) -> Optional[str]:
    name = item.get("name")
    if not name:
        return None
    parent_ref = item.get("parentReference") or {}
    parent_path = parent_ref.get("path") or ""
    if ":" in parent_path:
        parent_path = parent_path.split(":", 1)[1]
    parent_path = parent_path.strip()
    if not parent_path:
        return name
    if parent_path.endswith("/"):
        return f"{parent_path}{name}"
    return f"{parent_path}/{name}"


def _item_file_hash_sha1(item: Dict[str, Any]) -> Optional[str]:
    file_obj = item.get("file") or {}
    hashes = file_obj.get("hashes") or {}
    sha1 = hashes.get("sha1Hash")
    if isinstance(sha1, str):
        return sha1
    return None


def _ingest_drive_items(client: GraphClient, *, run_id: str, flush_every: int) -> Dict[str, Any]:
    synced_at = datetime.now(timezone.utc)
    select = ",".join(
        [
            "id",
            "name",
            "parentReference",
            "webUrl",
            "size",
            "createdDateTime",
            "lastModifiedDateTime",
            "createdBy",
            "lastModifiedBy",
            "file",
            "folder",
            "fileSystemInfo",
            "shared",
            "remoteItem",
            "sharepointIds",
            "deleted",
        ]
    )

    upsert_active_sql = """
        INSERT INTO msgraph_drive_items
          (drive_id, id, name, web_url, parent_id, path, normalized_path, path_level, is_folder, child_count,
           size, mime_type, file_hash_sha1, created_dt, modified_dt, created_by_user_id, created_by_display_name,
           created_by_email, last_modified_by_user_id, last_modified_by_display_name, last_modified_by_email,
           is_shared, sp_site_id, sp_list_id, sp_list_item_id, sp_list_item_unique_id,
           permissions_last_synced_at, permissions_last_error_at, permissions_last_error, permissions_last_error_details,
           synced_at, deleted_at, raw_json)
        VALUES %s
        ON CONFLICT (drive_id, id) DO UPDATE SET
          name = EXCLUDED.name,
          web_url = EXCLUDED.web_url,
          parent_id = EXCLUDED.parent_id,
          path = EXCLUDED.path,
          normalized_path = EXCLUDED.normalized_path,
          path_level = EXCLUDED.path_level,
          is_folder = EXCLUDED.is_folder,
          child_count = EXCLUDED.child_count,
          size = EXCLUDED.size,
          mime_type = EXCLUDED.mime_type,
          file_hash_sha1 = EXCLUDED.file_hash_sha1,
          created_dt = EXCLUDED.created_dt,
          modified_dt = EXCLUDED.modified_dt,
          created_by_user_id = EXCLUDED.created_by_user_id,
          created_by_display_name = EXCLUDED.created_by_display_name,
          created_by_email = EXCLUDED.created_by_email,
          last_modified_by_user_id = EXCLUDED.last_modified_by_user_id,
          last_modified_by_display_name = EXCLUDED.last_modified_by_display_name,
          last_modified_by_email = EXCLUDED.last_modified_by_email,
          is_shared = EXCLUDED.is_shared,
          sp_site_id = EXCLUDED.sp_site_id,
          sp_list_id = EXCLUDED.sp_list_id,
          sp_list_item_id = EXCLUDED.sp_list_item_id,
          sp_list_item_unique_id = EXCLUDED.sp_list_item_unique_id,
          permissions_last_synced_at = NULL,
          permissions_last_error_at = NULL,
          permissions_last_error = NULL,
          permissions_last_error_details = NULL,
          synced_at = EXCLUDED.synced_at,
          deleted_at = NULL,
          raw_json = EXCLUDED.raw_json
    """

    upsert_removed_sql = """
        INSERT INTO msgraph_drive_items
          (drive_id, id, synced_at, deleted_at, raw_json)
        VALUES %s
        ON CONFLICT (drive_id, id) DO UPDATE SET
          synced_at = EXCLUDED.synced_at,
          deleted_at = EXCLUDED.deleted_at,
          raw_json = EXCLUDED.raw_json
    """

    delete_permissions_grants_sql = """
        DELETE FROM msgraph_drive_item_permission_grants g
        USING (VALUES %s) AS v(drive_id, item_id)
        WHERE g.drive_id = v.drive_id AND g.item_id = v.item_id
    """

    delete_permissions_sql = """
        DELETE FROM msgraph_drive_item_permissions p
        USING (VALUES %s) AS v(drive_id, item_id)
        WHERE p.drive_id = v.drive_id AND p.item_id = v.item_id
    """

    drive_count = 0
    drive_skipped_error = 0
    drive_delta_resets = 0
    item_total = 0
    item_removed = 0
    flushed_active = 0
    flushed_removed = 0
    dropped_active_duplicates = 0
    dropped_removed_duplicates = 0

    conn = db.get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT id FROM msgraph_drives WHERE deleted_at IS NULL")
        drive_ids = [row[0] for row in cur.fetchall()]
        conn.commit()
        users_by_id, users_by_email = _load_user_maps(cur)

        for drive_id in drive_ids:
            drive_count += 1
            base_url = f"/drives/{drive_id}/root/delta?$top={GRAPH_PAGE_SIZE}&$select={select}"
            delta_link = _get_delta_link(cur, "drive_items", drive_id)
            next_url = delta_link or base_url

            for attempt in range(2):
                delta_link_new: Optional[str] = None
                active_batch: list[tuple] = []
                removed_batch: list[tuple] = []
                removed_keys: list[tuple] = []
                drive_write_incomplete = False
                try:
                    while next_url:
                        data = client.get_json(next_url)
                        for item in data.get("value", []) or []:
                            item_id = item.get("id")
                            if not item_id:
                                continue
                            item_total += 1
                            removed = "@removed" in item or "deleted" in item
                            if removed:
                                item_removed += 1
                                removed_batch.append((drive_id, item_id, synced_at, synced_at, db.jsonb(item)))
                                removed_keys.append((drive_id, item_id))
                            else:
                                parent_ref = item.get("parentReference") or {}
                                normalized_path = parent_ref.get("path")
                                path_level = _compute_path_level(normalized_path)
                                created_by_user_id, _, created_by_display_name, created_by_email, _ = _resolve_identity(
                                    item.get("createdBy"), users_by_id, users_by_email
                                )
                                last_modified_by_user_id, _, last_modified_by_display_name, last_modified_by_email, _ = _resolve_identity(
                                    item.get("lastModifiedBy"), users_by_id, users_by_email
                                )
                                sp_ids = item.get("sharepointIds") or {}
                                active_batch.append(
                                    (
                                        drive_id,
                                        item_id,
                                        item.get("name"),
                                        item.get("webUrl"),
                                        parent_ref.get("id"),
                                        _item_path(item),
                                        normalized_path,
                                        path_level,
                                        bool(item.get("folder")),
                                        (item.get("folder") or {}).get("childCount"),
                                        item.get("size"),
                                        (item.get("file") or {}).get("mimeType"),
                                        _item_file_hash_sha1(item),
                                        item.get("createdDateTime"),
                                        item.get("lastModifiedDateTime"),
                                        created_by_user_id,
                                        created_by_display_name,
                                        created_by_email,
                                        last_modified_by_user_id,
                                        last_modified_by_display_name,
                                        last_modified_by_email,
                                        bool(item.get("shared") is not None),
                                        sp_ids.get("siteId"),
                                        sp_ids.get("listId"),
                                        sp_ids.get("listItemId"),
                                        sp_ids.get("listItemUniqueId"),
                                        None,
                                        None,
                                        None,
                                        None,
                                        synced_at,
                                        None,
                                        db.jsonb(item),
                                    )
                                )

                            if len(active_batch) >= flush_every:
                                executed, dropped = _execute_values_dedup_keep_last(
                                    cur,
                                    upsert_active_sql,
                                    active_batch,
                                    key_fn=lambda r: (r[0], r[1]),
                                )
                                conn.commit()
                                flushed_active += executed
                                dropped_active_duplicates += dropped
                                active_batch = []

                            if len(removed_batch) >= flush_every:
                                removed_batch, dropped = _dedupe_rows_keep_last(removed_batch, key_fn=lambda r: (r[0], r[1]))
                                removed_batch.sort(key=lambda r: (r[0], r[1]))
                                removed_keys = [(r[0], r[1]) for r in removed_batch]

                                def write_removed_batch():
                                    if removed_batch:
                                        db.execute_values(cur, upsert_removed_sql, removed_batch)
                                    if removed_keys:
                                        db.execute_values(cur, delete_permissions_grants_sql, removed_keys)
                                        db.execute_values(cur, delete_permissions_sql, removed_keys)

                                success, _, sqlstate, error = _execute_db_mutation_with_retry(
                                    conn,
                                    run_id=run_id,
                                    op_name=f"drive_items_removed_cleanup:{drive_id}",
                                    retry_log_message="drive_items_db_write_retry",
                                    mutation_fn=write_removed_batch,
                                )
                                if success:
                                    flushed_removed += len(removed_batch)
                                    dropped_removed_duplicates += dropped
                                else:
                                    drive_write_incomplete = True
                                    emit(
                                        "WARN",
                                        "GRAPH",
                                        f"Drive items cleanup write retries exhausted: drive_id={drive_id} sqlstate={sqlstate} error={error}",
                                    )
                                    log_job_run_log(
                                        run_id=run_id,
                                        level="WARN",
                                        message="drive_items_db_write_retry",
                                        context={
                                            "operation": f"drive_items_removed_cleanup:{drive_id}",
                                            "exhausted": True,
                                            "sqlstate": sqlstate,
                                            "error": error,
                                        },
                                    )
                                removed_batch = []
                                removed_keys = []

                        next_url = data.get("@odata.nextLink")
                        delta_link_new = data.get("@odata.deltaLink") or delta_link_new

                    if active_batch:
                        executed, dropped = _execute_values_dedup_keep_last(
                            cur,
                            upsert_active_sql,
                            active_batch,
                            key_fn=lambda r: (r[0], r[1]),
                        )
                        conn.commit()
                        flushed_active += executed
                        dropped_active_duplicates += dropped

                    if removed_batch:
                        removed_batch, dropped = _dedupe_rows_keep_last(removed_batch, key_fn=lambda r: (r[0], r[1]))
                        removed_batch.sort(key=lambda r: (r[0], r[1]))
                        removed_keys = [(r[0], r[1]) for r in removed_batch]
                        def write_removed_batch():
                            if removed_batch:
                                db.execute_values(cur, upsert_removed_sql, removed_batch)
                            if removed_keys:
                                db.execute_values(cur, delete_permissions_grants_sql, removed_keys)
                                db.execute_values(cur, delete_permissions_sql, removed_keys)

                        success, _, sqlstate, error = _execute_db_mutation_with_retry(
                            conn,
                            run_id=run_id,
                            op_name=f"drive_items_removed_cleanup:{drive_id}",
                            retry_log_message="drive_items_db_write_retry",
                            mutation_fn=write_removed_batch,
                        )
                        if success:
                            flushed_removed += len(removed_batch)
                            dropped_removed_duplicates += dropped
                        else:
                            drive_write_incomplete = True
                            emit(
                                "WARN",
                                "GRAPH",
                                f"Drive items cleanup write retries exhausted: drive_id={drive_id} sqlstate={sqlstate} error={error}",
                            )
                            log_job_run_log(
                                run_id=run_id,
                                level="WARN",
                                message="drive_items_db_write_retry",
                                context={
                                    "operation": f"drive_items_removed_cleanup:{drive_id}",
                                    "exhausted": True,
                                    "sqlstate": sqlstate,
                                    "error": error,
                                },
                            )

                    if delta_link_new and not drive_write_incomplete:
                        _set_delta_link(cur, "drive_items", drive_id, delta_link_new)
                        conn.commit()
                    elif delta_link_new and drive_write_incomplete:
                        emit(
                            "WARN",
                            "GRAPH",
                            f"Drive items delta link not advanced due to incomplete writes: drive_id={drive_id}",
                        )
                        log_job_run_log(
                            run_id=run_id,
                            level="WARN",
                            message="drive_items_db_write_retry",
                            context={
                                "operation": f"drive_items_removed_cleanup:{drive_id}",
                                "delta_link_advanced": False,
                                "reason": "cleanup_write_retry_exhausted",
                            },
                        )

                    break
                except GraphError as exc:
                    if exc.status_code == 410 and attempt == 0 and delta_link:
                        drive_delta_resets += 1
                        emit(
                            "WARN",
                            "GRAPH",
                            f"Drive items delta expired, resetting cursor: drive_id={drive_id} status_code={exc.status_code}",
                        )
                        log_job_run_log(
                            run_id=run_id,
                            level="WARN",
                            message="drive_items_delta_expired_reset",
                            context={"drive_id": drive_id, "status_code": exc.status_code, "error": str(exc)},
                        )
                        cur.execute(
                            "DELETE FROM msgraph_delta_state WHERE resource_type = %s AND partition_key = %s",
                            ["drive_items", drive_id],
                        )
                        conn.commit()
                        delta_link = None
                        next_url = base_url
                        continue

                    drive_skipped_error += 1
                    emit(
                        "WARN",
                        "GRAPH",
                        f"Drive items skipped: drive_id={drive_id} status_code={exc.status_code} error={exc}",
                    )
                    log_job_run_log(
                        run_id=run_id,
                        level="WARN",
                        message="drive_items_skipped",
                        context={"drive_id": drive_id, "status_code": exc.status_code, "error": str(exc)},
                    )
                    conn.rollback()
                    break

        log_job_run_log(
            run_id=run_id,
            level="INFO",
            message="drive_items_ingested",
            context={
                "synced_at": synced_at.isoformat(),
                "drives_processed": drive_count,
                "drives_skipped_error": drive_skipped_error,
                "drives_delta_resets": drive_delta_resets,
                "items_seen": item_total,
                "items_removed_seen": item_removed,
                "upserted_active": flushed_active,
                "upserted_removed": flushed_removed,
                "dropped_active_duplicates": dropped_active_duplicates,
                "dropped_removed_duplicates": dropped_removed_duplicates,
            },
        )
        return {
            "drives_processed": drive_count,
            "drives_skipped_error": drive_skipped_error,
            "drives_delta_resets": drive_delta_resets,
            "items_seen": item_total,
            "items_removed_seen": item_removed,
            "upserted_active": flushed_active,
            "upserted_removed": flushed_removed,
            "dropped_active_duplicates": dropped_active_duplicates,
            "dropped_removed_duplicates": dropped_removed_duplicates,
        }
    finally:
        conn.close()


def _iter_permission_identities(permission: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
    def yield_from_identityset(identityset: Dict[str, Any]):
        for kind in ("user", "group", "application", "siteGroup", "siteUser"):
            obj = identityset.get(kind)
            if not obj:
                continue
            yield {
                "principal_type": kind,
                "principal_id": obj.get("id"),
                "principal_display_name": obj.get("displayName") or obj.get("name"),
                "principal_email": obj.get("email") or obj.get("userPrincipalName"),
                "principal_user_principal_name": obj.get("userPrincipalName"),
                "raw": obj,
            }

    g2 = permission.get("grantedToV2")
    g2_list = permission.get("grantedToIdentitiesV2")
    has_v2 = isinstance(g2, dict) or (isinstance(g2_list, list) and len(g2_list) > 0)

    if has_v2:
        if isinstance(g2, dict):
            yield from yield_from_identityset(g2)
        if isinstance(g2_list, list):
            for identityset in g2_list:
                if isinstance(identityset, dict):
                    yield from yield_from_identityset(identityset)
        return

    g = permission.get("grantedTo")
    if isinstance(g, dict):
        yield from yield_from_identityset(g)

    g_list = permission.get("grantedToIdentities")
    if isinstance(g_list, list):
        for identityset in g_list:
            if isinstance(identityset, dict):
                yield from yield_from_identityset(identityset)


def _extract_grants(permission: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
    grants = []
    for ident in _iter_permission_identities(permission):
        principal_id = ident.get("principal_id")
        if not principal_id:
            continue
        grants.append(ident)

    link = permission.get("link")
    if isinstance(link, dict) and link:
        grants.append(
            {
                "principal_type": "link",
                "principal_id": "link",
                "principal_display_name": link.get("type"),
                "principal_email": None,
                "principal_user_principal_name": None,
                "raw": link,
            }
        )

    return grants


def _fetch_permissions(client: GraphClient, drive_id: str, item_id: str) -> list[Dict[str, Any]]:
    select = ",".join(
        [
            "id",
            "roles",
            "link",
            "inheritedFrom",
            "grantedTo",
            "grantedToV2",
            "grantedToIdentities",
            "grantedToIdentitiesV2",
        ]
    )
    url = f"/drives/{drive_id}/items/{item_id}/permissions?$select={select}&$top=200"
    return list(client.iter_paged(url))


def _truncate_text(value: Optional[str], *, max_len: int) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) <= max_len:
        return text
    return text[: max_len - 3] + "..."


def _classify_permission_sync_error(error: Any) -> Dict[str, Any]:
    info: Dict[str, Any] = {
        "category": "unknown",
        "status_code": None,
        "graph_code": None,
        "message": None,
        "request_url": None,
        "response_excerpt": None,
        "error_type": None,
    }

    if isinstance(error, GraphError):
        status_code = int(error.status_code)
        parsed_graph_code: Optional[str] = None
        parsed_graph_message: Optional[str] = None
        if error.response_text:
            try:
                payload = json.loads(error.response_text)
                payload_error = payload.get("error") if isinstance(payload, dict) else None
                if isinstance(payload_error, dict):
                    parsed_graph_code = _truncate_text(payload_error.get("code"), max_len=120)
                    parsed_graph_message = _truncate_text(payload_error.get("message"), max_len=500)
            except (ValueError, TypeError):
                # Best-effort parse only; fall back to default GraphError fields.
                payload_error = None

        if status_code == 404:
            category = "graph_not_found"
        elif status_code == 403:
            category = "graph_forbidden"
        elif status_code == 429:
            category = "graph_throttled"
        elif status_code >= 500:
            category = "graph_server_error"
        else:
            category = "graph_error"

        info.update(
            {
                "category": category,
                "status_code": status_code,
                "graph_code": parsed_graph_code,
                "message": _truncate_text(parsed_graph_message or error.message, max_len=500),
                "request_url": _truncate_text(error.url, max_len=500),
                "response_excerpt": _truncate_text(error.response_text, max_len=500),
                "error_type": error.__class__.__name__,
            }
        )
        return info

    message = _truncate_text(str(error) if error is not None else None, max_len=500)
    category = "unknown"
    if isinstance(error, RuntimeError) and message:
        lower_msg = message.lower()
        if "graph request failed" in lower_msg or "graph request retries exhausted" in lower_msg:
            category = "transport_error"
    info.update(
        {
            "category": category,
            "message": message or "permissions_fetch_failed",
            "error_type": type(error).__name__ if error is not None else "NoneType",
        }
    )
    return info


def _build_permission_error_state(
    *,
    classification: Dict[str, Any],
    run_id: str,
    phase: str,
    attempt_in_run: int,
    failed_at: datetime,
    previous_details: Optional[Dict[str, Any]],
    extra_details: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    category = classification.get("category") or "unknown"
    status_code = classification.get("status_code")
    graph_code = classification.get("graph_code")
    message = classification.get("message") or "permissions_sync_failed"
    signature = f"{category}|{status_code if status_code is not None else ''}|{graph_code or ''}"

    prev_signature = None
    prev_consecutive = 0
    if isinstance(previous_details, dict):
        prev_signature = previous_details.get("last_failure_signature")
        try:
            prev_consecutive = int(previous_details.get("consecutive_failures") or 0)
        except Exception:
            prev_consecutive = 0

    consecutive_failures = prev_consecutive + 1 if prev_signature == signature else 1
    summary_parts = [category]
    if status_code is not None:
        summary_parts.append(f"status={status_code}")
    if graph_code:
        summary_parts.append(f"code={graph_code}")
    if message:
        summary_parts.append(f"message={message}")
    summary = _truncate_text(" ".join(summary_parts), max_len=500) or "permissions_sync_failed"

    details: Dict[str, Any] = {
        "category": category,
        "status_code": status_code,
        "graph_code": graph_code,
        "message": message,
        "request_url": classification.get("request_url"),
        "response_excerpt": classification.get("response_excerpt"),
        "error_type": classification.get("error_type"),
        "run_id": run_id,
        "phase": phase,
        "attempt_in_run": attempt_in_run,
        "failed_at": failed_at.isoformat(),
        "last_failure_signature": signature,
        "consecutive_failures": consecutive_failures,
    }
    if extra_details:
        details.update(extra_details)

    return {"summary": summary, "details": details}


def _scan_permissions(client: GraphClient, config: Dict[str, Any], *, run_id: str) -> Dict[str, Any]:
    permissions_batch_size = int(config.get("permissions_batch_size", DEFAULT_PERMISSIONS_BATCH_SIZE))
    stale_after_hours = int(config.get("permissions_stale_after_hours", DEFAULT_PERMISSIONS_STALE_AFTER_HOURS))
    if stale_after_hours < 0:
        stale_after_hours = 0

    cutoff = datetime.now(timezone.utc) - timedelta(hours=stale_after_hours)
    synced_at = datetime.now(timezone.utc)

    delete_grants_sql = """
        DELETE FROM msgraph_drive_item_permission_grants g
        USING (VALUES %s) AS v(drive_id, item_id)
        WHERE g.drive_id = v.drive_id AND g.item_id = v.item_id
    """
    delete_permissions_sql = """
        DELETE FROM msgraph_drive_item_permissions p
        USING (VALUES %s) AS v(drive_id, item_id)
        WHERE p.drive_id = v.drive_id AND p.item_id = v.item_id
    """
    insert_permissions_sql = """
        INSERT INTO msgraph_drive_item_permissions
          (drive_id, item_id, permission_id, source, roles, link_type, link_scope, link_web_url,
           link_prevents_download, link_expiration_dt, inherited_from_id, synced_at, deleted_at, raw_json)
        VALUES %s
        ON CONFLICT (drive_id, item_id, permission_id) DO UPDATE SET
          source = EXCLUDED.source,
          roles = EXCLUDED.roles,
          link_type = EXCLUDED.link_type,
          link_scope = EXCLUDED.link_scope,
          link_web_url = EXCLUDED.link_web_url,
          link_prevents_download = EXCLUDED.link_prevents_download,
          link_expiration_dt = EXCLUDED.link_expiration_dt,
          inherited_from_id = EXCLUDED.inherited_from_id,
          synced_at = EXCLUDED.synced_at,
          deleted_at = NULL,
          raw_json = EXCLUDED.raw_json
    """
    insert_grants_sql = """
        INSERT INTO msgraph_drive_item_permission_grants
          (drive_id, item_id, permission_id, principal_type, principal_id, principal_display_name,
           principal_email, principal_user_principal_name, synced_at, deleted_at, raw_json)
        VALUES %s
        ON CONFLICT (drive_id, item_id, permission_id, principal_type, principal_id) DO UPDATE SET
          principal_display_name = EXCLUDED.principal_display_name,
          principal_email = EXCLUDED.principal_email,
          principal_user_principal_name = EXCLUDED.principal_user_principal_name,
          synced_at = EXCLUDED.synced_at,
          deleted_at = NULL,
          raw_json = EXCLUDED.raw_json
    """
    update_items_ok_sql = """
        UPDATE msgraph_drive_items d
        SET permissions_last_synced_at = v.synced_at,
            permissions_last_error_at = NULL,
            permissions_last_error = NULL,
            permissions_last_error_details = NULL
        FROM (VALUES %s) AS v(drive_id, item_id, synced_at)
        WHERE d.drive_id = v.drive_id AND d.id = v.item_id
    """
    update_items_err_sql = """
        UPDATE msgraph_drive_items d
        SET permissions_last_synced_at = v.synced_at,
            permissions_last_error_at = v.error_at,
            permissions_last_error = v.error,
            permissions_last_error_details = v.error_details
        FROM (VALUES %s) AS v(drive_id, item_id, synced_at, error_at, error, error_details)
        WHERE d.drive_id = v.drive_id AND d.id = v.item_id
    """

    batches = 0
    items_processed = 0
    items_ok = 0
    items_err = 0
    dropped_permission_duplicates = 0
    dropped_grant_duplicates = 0
    db_retry_attempts = 0
    db_retry_exhausted_batches = 0
    successful_db_batches = 0
    terminal_skip_batches = 0
    terminal_retry_requeues = 0
    terminal_fail_count_by_key: Dict[Tuple[str, str], int] = {}
    deferred_until_success_batch: Dict[Tuple[str, str], int] = {}
    dropped_for_run: set[Tuple[str, str]] = set()
    failed_key_attempts: Dict[Tuple[str, str], int] = {}
    failed_keys_for_end_retry: set[Tuple[str, str]] = set()
    end_retry_candidates = 0
    end_retry_ok = 0
    end_retry_err = 0
    candidate_limit = min(max(permissions_batch_size * 10, permissions_batch_size), 1000)
    terminal_retry_success_batch_delay = 5
    terminal_fail_drop_threshold = 2

    conn = db.get_conn()
    try:
        cur = conn.cursor()

        def _iter_key_batches(key_rows: list[Tuple[str, str]]) -> Iterable[list[Tuple[str, str]]]:
            for idx in range(0, len(key_rows), permissions_batch_size):
                yield key_rows[idx : idx + permissions_batch_size]

        def _load_existing_error_details(key_rows: list[Tuple[str, str]]) -> Dict[Tuple[str, str], Dict[str, Any]]:
            if not key_rows:
                return {}
            placeholders = ",".join(["(%s,%s)"] * len(key_rows))
            params: list[str] = []
            for drive_id, item_id in key_rows:
                params.extend([drive_id, item_id])
            cur.execute(
                f"""
                SELECT drive_id, id, permissions_last_error_details
                FROM msgraph_drive_items
                WHERE (drive_id, id) IN ({placeholders})
                """,
                params,
            )
            rows = cur.fetchall()
            details_by_key: Dict[Tuple[str, str], Dict[str, Any]] = {}
            for drive_id, item_id, details in rows:
                parsed_details = details
                if isinstance(parsed_details, str):
                    try:
                        parsed_details = json.loads(parsed_details)
                    except Exception:
                        parsed_details = None
                if isinstance(parsed_details, dict):
                    details_by_key[(drive_id, item_id)] = parsed_details
            return details_by_key

        def _mark_key_sync_success(key: Tuple[str, str]):
            failed_keys_for_end_retry.discard(key)
            failed_key_attempts.pop(key, None)

        def _register_key_failure(key: Tuple[str, str]) -> int:
            attempt_in_run = failed_key_attempts.get(key, 0) + 1
            failed_key_attempts[key] = attempt_in_run
            failed_keys_for_end_retry.add(key)
            return attempt_in_run

        def _collect_permission_results(keys: list[Tuple[str, str]]) -> Dict[Tuple[str, str], Dict[str, Any]]:
            results: Dict[Tuple[str, str], Dict[str, Any]] = {}
            if GRAPH_MAX_CONCURRENCY > 1:
                with ThreadPoolExecutor(max_workers=GRAPH_MAX_CONCURRENCY) as executor:
                    future_to_key = {
                        executor.submit(_fetch_permissions, client, drive_id, item_id): (drive_id, item_id)
                        for drive_id, item_id in keys
                    }
                    for future in as_completed(future_to_key):
                        drive_id, item_id = future_to_key[future]
                        try:
                            results[(drive_id, item_id)] = {"ok": True, "permissions": future.result()}
                        except Exception as exc:
                            results[(drive_id, item_id)] = {"ok": False, "error": exc}
            else:
                for drive_id, item_id in keys:
                    try:
                        results[(drive_id, item_id)] = {
                            "ok": True,
                            "permissions": _fetch_permissions(client, drive_id, item_id),
                        }
                    except Exception as exc:
                        results[(drive_id, item_id)] = {"ok": False, "error": exc}
            return results

        def _prepare_batch_payload(
            keys: list[Tuple[str, str]],
            *,
            phase: str,
            existing_error_details: Dict[Tuple[str, str], Dict[str, Any]],
        ) -> Dict[str, Any]:
            results = _collect_permission_results(keys)
            ok_keys: list[tuple] = []
            ok_updates: list[tuple] = []
            err_updates: list[tuple] = []
            permission_rows: list[tuple] = []
            grant_rows: list[tuple] = []
            not_found_cleanup_keys: list[Tuple[str, str]] = []
            sample_errors: list[dict] = []

            for drive_id, item_id in keys:
                key = (drive_id, item_id)
                res = results.get(key) or {}
                if res.get("ok"):
                    ok_keys.append(key)
                    ok_updates.append((drive_id, item_id, synced_at))
                    perms = res.get("permissions") or []
                    for perm in perms:
                        perm_id = perm.get("id")
                        if not perm_id:
                            continue
                        link = perm.get("link") or {}
                        inherited_from_id = (perm.get("inheritedFrom") or {}).get("id")
                        source = "inherited" if inherited_from_id else "direct"
                        permission_rows.append(
                            (
                                drive_id,
                                item_id,
                                perm_id,
                                source,
                                perm.get("roles"),
                                link.get("type"),
                                link.get("scope"),
                                link.get("webUrl"),
                                link.get("preventsDownload"),
                                link.get("expirationDateTime"),
                                inherited_from_id,
                                synced_at,
                                None,
                                db.jsonb(perm),
                            )
                        )
                        for grant in _extract_grants(perm):
                            grant_rows.append(
                                (
                                    drive_id,
                                    item_id,
                                    perm_id,
                                    grant.get("principal_type"),
                                    grant.get("principal_id"),
                                    grant.get("principal_display_name"),
                                    grant.get("principal_email"),
                                    grant.get("principal_user_principal_name"),
                                    synced_at,
                                    None,
                                    db.jsonb(grant.get("raw") or {}),
                                )
                            )
                    continue

                failed_at = datetime.now(timezone.utc)
                classification = _classify_permission_sync_error(res.get("error"))
                attempt_in_run = _register_key_failure(key)
                state = _build_permission_error_state(
                    classification=classification,
                    run_id=run_id,
                    phase=phase,
                    attempt_in_run=attempt_in_run,
                    failed_at=failed_at,
                    previous_details=existing_error_details.get(key),
                )
                err_updates.append((drive_id, item_id, synced_at, failed_at, state["summary"], db.jsonb(state["details"])))
                if classification.get("category") == "graph_not_found":
                    not_found_cleanup_keys.append(key)
                if len(sample_errors) < 5:
                    sample_errors.append(
                        {
                            "drive_id": drive_id,
                            "item_id": item_id,
                            "category": classification.get("category"),
                            "status_code": classification.get("status_code"),
                            "graph_code": classification.get("graph_code"),
                            "error": state["summary"],
                        }
                    )

            ok_keys.sort(key=lambda r: (r[0], r[1]))
            ok_updates.sort(key=lambda r: (r[0], r[1]))
            err_updates.sort(key=lambda r: (r[0], r[1]))
            if permission_rows:
                deduped_rows, dropped = _dedupe_rows_keep_last(permission_rows, key_fn=lambda r: (r[0], r[1], r[2]))
                permission_rows = deduped_rows
                permission_rows.sort(key=lambda r: (r[0], r[1], r[2]))
            else:
                dropped = 0
            dropped_permissions = dropped
            if grant_rows:
                deduped_rows, dropped = _dedupe_rows_keep_last(grant_rows, key_fn=lambda r: (r[0], r[1], r[2], r[3], r[4]))
                grant_rows = deduped_rows
                grant_rows.sort(key=lambda r: (r[0], r[1], r[2], r[3], r[4]))
            else:
                dropped = 0
            dropped_grants = dropped

            not_found_cleanup_keys = sorted(set(not_found_cleanup_keys), key=lambda r: (r[0], r[1]))
            return {
                "ok_keys": ok_keys,
                "ok_updates": ok_updates,
                "err_updates": err_updates,
                "permission_rows": permission_rows,
                "grant_rows": grant_rows,
                "not_found_cleanup_keys": not_found_cleanup_keys,
                "sample_errors": sample_errors,
                "dropped_permissions": dropped_permissions,
                "dropped_grants": dropped_grants,
            }

        def _build_db_write_exhausted_err_updates(
            keys: list[Tuple[str, str]],
            *,
            phase: str,
            sqlstate: Optional[str],
            write_error: Optional[str],
            existing_error_details: Dict[Tuple[str, str], Dict[str, Any]],
            operation: str,
        ) -> list[tuple]:
            updates: list[tuple] = []
            msg_suffix = _truncate_text(write_error, max_len=320)
            for drive_id, item_id in keys:
                key = (drive_id, item_id)
                failed_at = datetime.now(timezone.utc)
                attempt_in_run = _register_key_failure(key)
                classification = {
                    "category": "db_write_error",
                    "status_code": None,
                    "graph_code": sqlstate,
                    "message": f"db_write_retry_exhausted:{sqlstate or 'unknown'}"
                    + (f" {msg_suffix}" if msg_suffix else ""),
                    "request_url": None,
                    "response_excerpt": None,
                    "error_type": "DBWriteError",
                }
                state = _build_permission_error_state(
                    classification=classification,
                    run_id=run_id,
                    phase=phase,
                    attempt_in_run=attempt_in_run,
                    failed_at=failed_at,
                    previous_details=existing_error_details.get(key),
                    extra_details={"operation": operation, "sqlstate": sqlstate},
                )
                updates.append((drive_id, item_id, synced_at, failed_at, state["summary"], db.jsonb(state["details"])))
            updates.sort(key=lambda r: (r[0], r[1]))
            return updates

        while True:
            cur.execute(
                """
                SELECT drive_id, id
                FROM msgraph_drive_items
                WHERE deleted_at IS NULL
                  AND is_folder = false
                  AND (
                    permissions_last_synced_at IS NULL
                    OR permissions_last_synced_at < %s
                    OR (
                      permissions_last_error_at IS NOT NULL
                      AND (permissions_last_synced_at IS NULL OR permissions_last_synced_at < %s)
                    )
                    OR (
                      modified_dt IS NOT NULL
                      AND modified_dt >= %s
                      AND (permissions_last_synced_at IS NULL OR permissions_last_synced_at < %s)
                    )
                  )
                ORDER BY
                  CASE WHEN permissions_last_error_at IS NOT NULL THEN 0 ELSE 1 END,
                  permissions_last_synced_at NULLS FIRST
                LIMIT %s
                """,
                [cutoff, synced_at, cutoff, synced_at, candidate_limit],
            )
            candidate_rows = cur.fetchall()
            if not candidate_rows:
                conn.commit()
                break

            candidate_keys = sorted([(row[0], row[1]) for row in candidate_rows], key=lambda r: (r[0], r[1]))
            keys: list[Tuple[str, str]] = []
            for key in candidate_keys:
                if key in dropped_for_run:
                    continue
                eligible_after = deferred_until_success_batch.get(key)
                if eligible_after is not None and successful_db_batches < eligible_after:
                    continue
                keys.append(key)
                if len(keys) >= permissions_batch_size:
                    break

            if not keys:
                conn.commit()
                break

            batches += 1
            items_processed += len(keys)
            existing_error_details = _load_existing_error_details(keys)
            payload = _prepare_batch_payload(keys, phase="primary", existing_error_details=existing_error_details)
            ok_keys = payload["ok_keys"]
            ok_updates = payload["ok_updates"]
            err_updates = payload["err_updates"]
            permission_rows = payload["permission_rows"]
            grant_rows = payload["grant_rows"]
            not_found_cleanup_keys = payload["not_found_cleanup_keys"]
            sample_errors = payload["sample_errors"]
            dropped_permission_duplicates += payload["dropped_permissions"]
            dropped_grant_duplicates += payload["dropped_grants"]

            def write_batch():
                if ok_keys:
                    db.execute_values(cur, delete_grants_sql, ok_keys)
                    db.execute_values(cur, delete_permissions_sql, ok_keys)
                    if permission_rows:
                        db.execute_values(cur, insert_permissions_sql, permission_rows)
                    if grant_rows:
                        db.execute_values(cur, insert_grants_sql, grant_rows)
                    db.execute_values(cur, update_items_ok_sql, ok_updates)

                if not_found_cleanup_keys:
                    db.execute_values(cur, delete_grants_sql, not_found_cleanup_keys)
                    db.execute_values(cur, delete_permissions_sql, not_found_cleanup_keys)

                if err_updates:
                    db.execute_values(cur, update_items_err_sql, err_updates)

            write_success, retries, sqlstate, write_error = _execute_db_mutation_with_retry(
                conn,
                run_id=run_id,
                op_name=f"permissions_batch:{batches}",
                retry_log_message="permissions_db_write_retry",
                mutation_fn=write_batch,
            )
            db_retry_attempts += retries
            if write_success:
                successful_db_batches += 1
                for key in keys:
                    deferred_until_success_batch.pop(key, None)
                items_ok += len(ok_updates)
                items_err += len(err_updates)
                for key in ok_keys:
                    _mark_key_sync_success(key)
            else:
                db_retry_exhausted_batches += 1
                emit(
                    "WARN",
                    "GRAPH",
                    f"Permissions batch write retries exhausted: batch={batches} items={len(keys)} sqlstate={sqlstate} error={write_error}",
                )
                log_job_run_log(
                    run_id=run_id,
                    level="WARN",
                    message="permissions_db_write_retry_exhausted",
                    context={
                        "batch": batches,
                        "items": len(keys),
                        "sqlstate": sqlstate,
                        "error": write_error,
                    },
                )

                fallback_err_updates = _build_db_write_exhausted_err_updates(
                    keys,
                    phase="primary",
                    sqlstate=sqlstate,
                    write_error=write_error,
                    existing_error_details=existing_error_details,
                    operation=f"permissions_batch:{batches}",
                )

                def mark_batch_error():
                    if fallback_err_updates:
                        db.execute_values(cur, update_items_err_sql, fallback_err_updates)

                mark_success, mark_retries, mark_sqlstate, mark_error = _execute_db_mutation_with_retry(
                    conn,
                    run_id=run_id,
                    op_name=f"permissions_batch_mark_error:{batches}",
                    retry_log_message="permissions_db_write_retry",
                    mutation_fn=mark_batch_error,
                )
                db_retry_attempts += mark_retries
                if mark_success:
                    for key in keys:
                        deferred_until_success_batch.pop(key, None)
                    items_err += len(fallback_err_updates)
                else:
                    terminal_skip_batches += 1
                    deferred_in_batch = 0
                    dropped_in_batch: list[Tuple[str, str]] = []
                    next_eligible_success_batch = successful_db_batches + terminal_retry_success_batch_delay

                    for key in keys:
                        fail_count = terminal_fail_count_by_key.get(key, 0) + 1
                        terminal_fail_count_by_key[key] = fail_count
                        if fail_count < terminal_fail_drop_threshold:
                            deferred_until_success_batch[key] = next_eligible_success_batch
                            terminal_retry_requeues += 1
                            deferred_in_batch += 1
                        else:
                            deferred_until_success_batch.pop(key, None)
                            dropped_for_run.add(key)
                            dropped_in_batch.append(key)

                    if deferred_in_batch:
                        emit(
                            "WARN",
                            "GRAPH",
                            (
                                f"Permissions keys deferred after terminal DB write failures: batch={batches} "
                                f"deferred_keys={deferred_in_batch} next_success_batch={next_eligible_success_batch}"
                            ),
                        )
                        log_job_run_log(
                            run_id=run_id,
                            level="WARN",
                            message="permissions_batch_terminal_deferred",
                            context={
                                "batch": batches,
                                "items": len(keys),
                                "deferred_keys": deferred_in_batch,
                                "retry_requeues_total": terminal_retry_requeues,
                                "next_eligible_success_batch": next_eligible_success_batch,
                                "write_sqlstate": sqlstate,
                                "mark_sqlstate": mark_sqlstate,
                            },
                        )

                    if dropped_in_batch:
                        emit(
                            "WARN",
                            "GRAPH",
                            f"Permissions keys dropped after repeated terminal failures: batch={batches} dropped_keys={len(dropped_in_batch)}",
                        )
                        sample_dropped = [
                            {"drive_id": drive_id, "item_id": item_id}
                            for drive_id, item_id in dropped_in_batch[:5]
                        ]
                        log_job_run_log(
                            run_id=run_id,
                            level="WARN",
                            message="permissions_key_terminal_dropped",
                            context={
                                "batch": batches,
                                "dropped_keys": len(dropped_in_batch),
                                "dropped_keys_total": len(dropped_for_run),
                                "terminal_fail_drop_threshold": terminal_fail_drop_threshold,
                                "sample": sample_dropped,
                            },
                        )

                    log_job_run_log(
                        run_id=run_id,
                        level="WARN",
                        message="permissions_db_write_retry_exhausted",
                        context={
                            "batch": batches,
                            "operation": "mark_batch_error",
                            "sqlstate": mark_sqlstate,
                            "error": mark_error,
                        },
                    )
                    emit(
                        "WARN",
                        "GRAPH",
                        f"Permissions mark-batch-error retries exhausted: batch={batches} sqlstate={mark_sqlstate} error={mark_error}",
                    )

                if err_updates:
                    emit(
                        "WARN",
                        "GRAPH",
                        f"Permissions batch finished with item errors: batch={batches} errors={len(err_updates)}",
                    )
                    log_job_run_log(
                        run_id=run_id,
                        level="WARN",
                        message="permissions_batch_errors",
                        context={
                            "batch": batches,
                            "errors": len(err_updates),
                            "sample": sample_errors,
                            "batch_write_exhausted": True,
                        },
                    )
                continue

            if err_updates:
                emit("WARN", "GRAPH", f"Permissions batch finished with item errors: batch={batches} errors={len(err_updates)}")
                log_job_run_log(
                    run_id=run_id,
                    level="WARN",
                    message="permissions_batch_errors",
                    context={"batch": batches, "errors": len(err_updates), "sample": sample_errors},
                )

        pending_end_retry_keys = sorted(list(failed_keys_for_end_retry), key=lambda r: (r[0], r[1]))
        end_retry_candidates = len(pending_end_retry_keys)
        if pending_end_retry_keys:
            emit(
                "INFO",
                "GRAPH",
                f"Permissions end-of-run retry started: candidates={end_retry_candidates}",
            )
            for retry_batch_num, retry_keys in enumerate(_iter_key_batches(pending_end_retry_keys), start=1):
                items_processed += len(retry_keys)
                existing_error_details = _load_existing_error_details(retry_keys)
                payload = _prepare_batch_payload(
                    retry_keys,
                    phase="final_retry",
                    existing_error_details=existing_error_details,
                )
                ok_keys = payload["ok_keys"]
                ok_updates = payload["ok_updates"]
                err_updates = payload["err_updates"]
                permission_rows = payload["permission_rows"]
                grant_rows = payload["grant_rows"]
                not_found_cleanup_keys = payload["not_found_cleanup_keys"]
                sample_errors = payload["sample_errors"]
                dropped_permission_duplicates += payload["dropped_permissions"]
                dropped_grant_duplicates += payload["dropped_grants"]

                def write_final_retry_batch():
                    if ok_keys:
                        db.execute_values(cur, delete_grants_sql, ok_keys)
                        db.execute_values(cur, delete_permissions_sql, ok_keys)
                        if permission_rows:
                            db.execute_values(cur, insert_permissions_sql, permission_rows)
                        if grant_rows:
                            db.execute_values(cur, insert_grants_sql, grant_rows)
                        db.execute_values(cur, update_items_ok_sql, ok_updates)

                    if not_found_cleanup_keys:
                        db.execute_values(cur, delete_grants_sql, not_found_cleanup_keys)
                        db.execute_values(cur, delete_permissions_sql, not_found_cleanup_keys)

                    if err_updates:
                        db.execute_values(cur, update_items_err_sql, err_updates)

                write_success, retries, sqlstate, write_error = _execute_db_mutation_with_retry(
                    conn,
                    run_id=run_id,
                    op_name=f"permissions_final_retry_batch:{retry_batch_num}",
                    retry_log_message="permissions_db_write_retry",
                    mutation_fn=write_final_retry_batch,
                )
                db_retry_attempts += retries
                if write_success:
                    successful_db_batches += 1
                    items_ok += len(ok_updates)
                    items_err += len(err_updates)
                    end_retry_ok += len(ok_updates)
                    end_retry_err += len(err_updates)
                    for key in ok_keys:
                        _mark_key_sync_success(key)
                else:
                    db_retry_exhausted_batches += 1
                    emit(
                        "WARN",
                        "GRAPH",
                        (
                            f"Permissions final retry batch write retries exhausted: batch={retry_batch_num} "
                            f"items={len(retry_keys)} sqlstate={sqlstate} error={write_error}"
                        ),
                    )
                    log_job_run_log(
                        run_id=run_id,
                        level="WARN",
                        message="permissions_db_write_retry_exhausted",
                        context={
                            "batch": retry_batch_num,
                            "operation": "final_retry_batch",
                            "items": len(retry_keys),
                            "sqlstate": sqlstate,
                            "error": write_error,
                        },
                    )

                    fallback_err_updates = _build_db_write_exhausted_err_updates(
                        retry_keys,
                        phase="final_retry",
                        sqlstate=sqlstate,
                        write_error=write_error,
                        existing_error_details=existing_error_details,
                        operation=f"permissions_final_retry_batch:{retry_batch_num}",
                    )

                    def mark_final_retry_error():
                        if fallback_err_updates:
                            db.execute_values(cur, update_items_err_sql, fallback_err_updates)

                    mark_success, mark_retries, mark_sqlstate, mark_error = _execute_db_mutation_with_retry(
                        conn,
                        run_id=run_id,
                        op_name=f"permissions_final_retry_batch_mark_error:{retry_batch_num}",
                        retry_log_message="permissions_db_write_retry",
                        mutation_fn=mark_final_retry_error,
                    )
                    db_retry_attempts += mark_retries
                    if mark_success:
                        items_err += len(fallback_err_updates)
                        end_retry_err += len(fallback_err_updates)
                    else:
                        end_retry_err += len(retry_keys)
                        emit(
                            "WARN",
                            "GRAPH",
                            (
                                f"Permissions final retry mark-error retries exhausted: batch={retry_batch_num} "
                                f"sqlstate={mark_sqlstate} error={mark_error}"
                            ),
                        )
                        log_job_run_log(
                            run_id=run_id,
                            level="WARN",
                            message="permissions_db_write_retry_exhausted",
                            context={
                                "batch": retry_batch_num,
                                "operation": "final_retry_mark_batch_error",
                                "sqlstate": mark_sqlstate,
                                "error": mark_error,
                            },
                        )

                if err_updates:
                    emit(
                        "WARN",
                        "GRAPH",
                        (
                            f"Permissions final retry batch finished with item errors: "
                            f"batch={retry_batch_num} errors={len(err_updates)}"
                        ),
                    )
                    log_job_run_log(
                        run_id=run_id,
                        level="WARN",
                        message="permissions_batch_errors",
                        context={
                            "batch": retry_batch_num,
                            "phase": "final_retry",
                            "errors": len(err_updates),
                            "sample": sample_errors,
                        },
                    )

        terminal_deferred_keys = len(deferred_until_success_batch)
        terminal_dropped_keys = len(dropped_for_run)
        terminal_keys_pending_end_of_run = terminal_deferred_keys
        end_retry_remaining = len(failed_keys_for_end_retry)
        if terminal_keys_pending_end_of_run > 0:
            emit(
                "WARN",
                "GRAPH",
                (
                    f"Permissions run ended with pending keys: pending={terminal_keys_pending_end_of_run} "
                    f"deferred={terminal_deferred_keys} dropped={terminal_dropped_keys}"
                ),
            )
            sample_pending = [
                {"drive_id": drive_id, "item_id": item_id}
                for drive_id, item_id in list(deferred_until_success_batch.keys())[:5]
            ]
            log_job_run_log(
                run_id=run_id,
                level="WARN",
                message="permissions_terminal_pending_at_end",
                context={
                    "pending_keys": terminal_keys_pending_end_of_run,
                    "deferred_keys": terminal_deferred_keys,
                    "dropped_keys": terminal_dropped_keys,
                    "sample": sample_pending,
                },
            )

        log_job_run_log(
            run_id=run_id,
            level="INFO",
            message="permissions_scan_completed",
            context={
                "synced_at": synced_at.isoformat(),
                "cutoff": cutoff.isoformat(),
                "batches": batches,
                "items_processed": items_processed,
                "items_ok": items_ok,
                "items_err": items_err,
                "dropped_permission_duplicates": dropped_permission_duplicates,
                "dropped_grant_duplicates": dropped_grant_duplicates,
                "db_retry_attempts": db_retry_attempts,
                "db_retry_exhausted_batches": db_retry_exhausted_batches,
                "terminal_skip_batches": terminal_skip_batches,
                "terminal_deferred_keys": terminal_deferred_keys,
                "terminal_dropped_keys": terminal_dropped_keys,
                "terminal_retry_requeues": terminal_retry_requeues,
                "terminal_keys_pending_end_of_run": terminal_keys_pending_end_of_run,
                "end_retry_candidates": end_retry_candidates,
                "end_retry_ok": end_retry_ok,
                "end_retry_err": end_retry_err,
                "end_retry_remaining": end_retry_remaining,
            },
        )
        return {
            "batches": batches,
            "items_processed": items_processed,
            "items_ok": items_ok,
            "items_err": items_err,
            "stale_after_hours": stale_after_hours,
            "dropped_permission_duplicates": dropped_permission_duplicates,
            "dropped_grant_duplicates": dropped_grant_duplicates,
            "db_retry_attempts": db_retry_attempts,
            "db_retry_exhausted_batches": db_retry_exhausted_batches,
            "terminal_skip_batches": terminal_skip_batches,
            "terminal_deferred_keys": terminal_deferred_keys,
            "terminal_dropped_keys": terminal_dropped_keys,
            "terminal_retry_requeues": terminal_retry_requeues,
            "terminal_keys_pending_end_of_run": terminal_keys_pending_end_of_run,
            "end_retry_candidates": end_retry_candidates,
            "end_retry_ok": end_retry_ok,
            "end_retry_err": end_retry_err,
            "end_retry_remaining": end_retry_remaining,
        }
    finally:
        conn.close()
