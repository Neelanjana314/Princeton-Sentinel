from __future__ import annotations

import argparse
import csv
import datetime as dt
import getpass
import hashlib
import importlib.util
import json
import os
import re
import secrets
import shlex
import stat
import subprocess
import sys
import tempfile
import textwrap
import urllib.parse
import uuid
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_ROOT = ROOT / "scripts"
DEPLOYMENT_SUITE_ROOT = Path(__file__).resolve().parent
LOCAL_ROOT = ROOT / ".local"
AZURE_CONFIG_DIR = LOCAL_ROOT / "azure-cli"
DEPLOYMENTS_ROOT = LOCAL_ROOT / "deployments"
MASTER_CSV_PATH = DEPLOYMENTS_ROOT / "client-deployments-master.csv"
STATE_FILE_NAME = "state.json"
ENV_SNAPSHOT_FILE_NAME = "env-snapshot.json"
SUMMARY_FILE_NAME = "deployment-summary.md"
STAGING_WORKFLOW_PATH = ROOT / ".github" / "workflows" / "deploy-staging.yml"
RUNTIME_ENV_MANIFEST_PATH = ROOT / "runtime-env-manifest.json"
DEFAULT_LICENSE_PUBLIC_KEY_MOUNT_PATH = "/mnt/secrets/licensepublickey"
PLACEHOLDER_IMAGE = "docker.io/library/nginx:1.27-alpine"
DEFAULT_GRAPH_INGEST_CRON = "0 */6 * * *"

MASTER_CSV_FIELDS = [
    "deployment_id",
    "client_name",
    "client_slug",
    "environment",
    "deployed_at_utc",
    "app_version",
    "staging_version_source",
    "git_branch",
    "git_commit_sha",
    "image_tag",
    "web_image",
    "worker_image",
    "azure_subscription",
    "azure_location",
    "resource_group",
    "resource_group_provisioning_mode",
    "containerapp_environment",
    "acr_access_mode",
    "acr_provisioning_mode",
    "acr_sku",
    "acr_name",
    "acr_login_server",
    "acr_username",
    "acr_password",
    "key_vault_name",
    "key_vault_url",
    "app_insights_name",
    "app_insights_app_id",
    "app_insights_api_key",
    "postgres_server",
    "postgres_location",
    "postgres_database",
    "postgres_admin_username",
    "postgres_admin_password",
    "database_url",
    "dataverse_base_url",
    "power_platform_environment_id",
    "dataverse_table_url",
    "dataverse_column_prefix",
    "dataverse_agent_security_group_mapping_table_url",
    "web_app_name",
    "web_fqdn",
    "worker_app_name",
    "worker_fqdn",
    "nextauth_url",
    "entra_tenant_id",
    "entra_client_id",
    "entra_client_secret",
    "admin_group_id",
    "user_group_id",
    "internal_email_domains",
    "dashboard_dormant_lookback_days",
    "worker_api_url",
    "worker_internal_api_token",
    "worker_heartbeat_token",
    "worker_heartbeat_url",
    "license_public_key_path",
    "license_cache_ttl_seconds",
    "db_connect_timeout_seconds",
    "scheduler_poll_seconds",
    "graph_base",
    "graph_max_concurrency",
    "graph_max_retries",
    "graph_connect_timeout",
    "graph_read_timeout",
    "graph_page_size",
    "graph_permissions_batch_size",
    "graph_permissions_stale_after_hours",
    "flush_every",
    "license_id",
    "license_type",
    "license_file_path",
    "license_installed_at_utc",
    "web_latest_revision",
    "web_ready_revision",
    "worker_latest_revision",
    "worker_ready_revision",
    "web_image_matches_expected",
    "worker_image_matches_expected",
    "smoke_check_web",
    "smoke_check_worker",
]

DEFAULT_RUNTIME_VALUES = {
    "INTERNAL_EMAIL_DOMAINS": "",
    "DASHBOARD_DORMANT_LOOKBACK_DAYS": "90",
    "DB_CONNECT_TIMEOUT_SECONDS": "10",
    "SCHEDULER_POLL_SECONDS": "30",
    "GRAPH_BASE": "https://graph.microsoft.com/v1.0",
    "GRAPH_MAX_CONCURRENCY": "4",
    "GRAPH_MAX_RETRIES": "5",
    "GRAPH_CONNECT_TIMEOUT": "10",
    "GRAPH_READ_TIMEOUT": "60",
    "GRAPH_PAGE_SIZE": "200",
    "GRAPH_PERMISSIONS_BATCH_SIZE": "50",
    "GRAPH_PERMISSIONS_STALE_AFTER_HOURS": "24",
    "FLUSH_EVERY": "500",
    "LICENSE_CACHE_TTL_SECONDS": "300",
}

REQUIRED_RUNTIME_FIELDS = [
    "ENTRA_TENANT_ID",
    "ENTRA_CLIENT_ID",
    "ENTRA_CLIENT_SECRET",
    "ADMIN_GROUP_ID",
    "USER_GROUP_ID",
    "DATABASE_URL",
    "DATAVERSE_BASE_URL",
    "DATAVERSE_TABLE_URL",
    "DATAVERSE_COLUMN_PREFIX",
    "WORKER_INTERNAL_API_TOKEN",
    "WORKER_HEARTBEAT_TOKEN",
]


class DeploymentError(RuntimeError):
    pass


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def utc_now_iso() -> str:
    return utc_now().replace(microsecond=0).isoformat().replace("+00:00", "Z")


def validate_non_empty(value: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError("value must not be empty")
    return normalized


def validate_ipv4(value: str) -> str:
    normalized = validate_non_empty(value)
    parts = normalized.split(".")
    if len(parts) != 4:
        raise ValueError("must be an IPv4 address")
    for part in parts:
        if not part.isdigit():
            raise ValueError("must be an IPv4 address")
        number = int(part)
        if number < 0 or number > 255:
            raise ValueError("must be an IPv4 address")
    return normalized


def normalize_resource_name(value: str, *, max_length: int = 24, allow_hyphen: bool = True) -> str:
    raw = validate_non_empty(value).lower()
    pattern = r"[^a-z0-9-]+" if allow_hyphen else r"[^a-z0-9]+"
    normalized = re.sub(pattern, "-", raw)
    normalized = re.sub(r"-{2,}", "-", normalized).strip("-")
    if not normalized:
        raise ValueError("resource name normalized to empty")
    if not normalized[0].isalpha():
        normalized = f"s{normalized}"
    normalized = normalized[:max_length].rstrip("-")
    if not normalized[-1].isalnum():
        normalized = f"{normalized[:-1]}0"
    return normalized


def normalize_acr_name(value: str, *, max_length: int = 50) -> str:
    raw = validate_non_empty(value).lower()
    normalized = re.sub(r"[^a-z0-9]+", "", raw)
    if not normalized:
        raise ValueError("ACR name normalized to empty")
    if not normalized[0].isalpha():
        normalized = f"a{normalized}"
    normalized = normalized[:max_length]
    if len(normalized) < 5:
        normalized = f"{normalized}{'0' * (5 - len(normalized))}"
    return normalized


def validate_resource_group_name(value: str) -> str:
    normalized = validate_non_empty(value)
    if len(normalized) > 90:
        raise ValueError("resource group name must be 90 characters or fewer")
    if normalized.endswith("."):
        raise ValueError("resource group name must not end with a period")
    if not re.fullmatch(r"[A-Za-z0-9_.()\-]+", normalized):
        raise ValueError("resource group name contains unsupported characters")
    return normalized


def generate_secret(length: int = 48) -> str:
    return secrets.token_urlsafe(length)[:length]


def render_command(command: Sequence[str], *, secrets_to_mask: Iterable[str] | None = None) -> str:
    rendered = " ".join(shlex.quote(str(part)) for part in command)
    for secret in secrets_to_mask or []:
        if secret:
            rendered = rendered.replace(secret, "***")
    return rendered


def run_command(
    command: Sequence[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    dry_run: bool = False,
    capture_output: bool = False,
    check: bool = True,
    secrets_to_mask: Iterable[str] | None = None,
    io: "BaseIO | None" = None,
) -> subprocess.CompletedProcess[str]:
    io = io or ConsoleIO()
    io.print(f"$ {render_command(command, secrets_to_mask=secrets_to_mask)}")
    if dry_run:
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")
    merged_env = os.environ.copy()
    merged_env["AZURE_CONFIG_DIR"] = str(AZURE_CONFIG_DIR)
    if env:
        merged_env.update({key: str(value) for key, value in env.items()})
    return subprocess.run(
        list(command),
        cwd=str(cwd or ROOT),
        env=merged_env,
        capture_output=capture_output,
        check=check,
        text=True,
    )


def run_and_capture(
    command: Sequence[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    dry_run: bool = False,
    default: str = "",
    secrets_to_mask: Iterable[str] | None = None,
    io: "BaseIO | None" = None,
) -> str:
    if dry_run:
        run_command(
            command,
            cwd=cwd,
            env=env,
            dry_run=True,
            capture_output=True,
            secrets_to_mask=secrets_to_mask,
            io=io,
        )
        return default
    completed = run_command(
        command,
        cwd=cwd,
        env=env,
        dry_run=False,
        capture_output=True,
        secrets_to_mask=secrets_to_mask,
        io=io,
    )
    return completed.stdout.strip()


def run_and_capture_or_default(
    command: Sequence[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    dry_run: bool = False,
    default: str = "",
    secrets_to_mask: Iterable[str] | None = None,
    io: "BaseIO | None" = None,
) -> str:
    try:
        return run_and_capture(
            command,
            cwd=cwd,
            env=env,
            dry_run=dry_run,
            default=default,
            secrets_to_mask=secrets_to_mask,
            io=io,
        )
    except subprocess.CalledProcessError:
        return default


def command_exists(command_name: str) -> bool:
    return shutil.which(command_name) is not None


def psycopg2_available() -> bool:
    return importlib.util.find_spec("psycopg2") is not None


def repo_relative(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def discover_sql_files(path: Path) -> list[Path]:
    return sorted(entry for entry in path.glob("*.sql") if entry.is_file())


def discover_init_sql_files() -> list[Path]:
    return discover_sql_files(ROOT / "db" / "init")


def discover_migration_sql_files() -> list[Path]:
    return discover_sql_files(ROOT / "db" / "migrations")


def build_database_url(
    *,
    username: str,
    password: str,
    host: str,
    port: int,
    database: str,
    schema: str | None = None,
) -> str:
    quoted_username = urllib.parse.quote(username, safe="")
    quoted_password = urllib.parse.quote(password, safe="")
    query_items = [("sslmode", "require")]
    if schema:
        query_items.append(("options", f"-c search_path={schema},public"))
    query = urllib.parse.urlencode(query_items)
    return f"postgresql://{quoted_username}:{quoted_password}@{host}:{port}/{database}?{query}"


def augment_database_url_schema(database_url: str, schema: str) -> str:
    parsed = urllib.parse.urlparse(database_url)
    query_items = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query_items.append(("options", f"-c search_path={schema},public"))
    return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(query_items)))


def sanitize_markdown(value: Any) -> str:
    return str(value or "").replace("\n", " ").replace("\r", " ").strip()


def ensure_private_file(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.touch()
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)


def write_private_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)


def write_private_json(path: Path, value: Any) -> None:
    write_private_text(path, json.dumps(value, indent=2, sort_keys=True) + "\n")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def safe_get(state: dict[str, Any], *keys: str, default: Any = "") -> Any:
    current: Any = state
    for key in keys:
        if not isinstance(current, dict):
            return default
        current = current.get(key)
    return default if current in (None, "") else current


def stable_delimiter(value: str) -> str:
    while True:
        token = f"license_{uuid.uuid4().hex}"
        marker = f"${token}$"
        if marker not in value:
            return token


def compute_source_metadata(io: "BaseIO | None" = None) -> dict[str, str]:
    io = io or ConsoleIO()
    app_version = run_and_capture(
        ["node", "scripts/staging-version.cjs", "from-file", ".github/workflows/deploy-staging.yml"],
        io=io,
    )
    branch = run_and_capture(["git", "branch", "--show-current"], io=io)
    commit_sha = run_and_capture(["git", "rev-parse", "HEAD"], io=io)
    short_sha = commit_sha[:12]
    worktree_status = run_and_capture(["git", "status", "--porcelain"], io=io)
    image_tag = short_sha
    if worktree_status:
        dirty_suffix = hashlib.sha256(worktree_status.encode("utf-8")).hexdigest()[:8]
        image_tag = f"{short_sha}-dirty-{dirty_suffix}"
    return {
        "app_version": app_version,
        "staging_version_source": ".github/workflows/deploy-staging.yml",
        "git_branch": branch,
        "git_commit_sha": commit_sha,
        "image_tag": image_tag,
    }


def build_default_state(
    client_name: str,
    source: dict[str, str],
    subscription: str,
    location: str,
    acr_name: str,
    *,
    resource_group: str | None = None,
    resource_group_provisioning_mode: str = "create",
    acr_access_mode: str = "managed-identity",
    acr_provisioning_mode: str = "existing",
    acr_sku: str = "",
    acr_login_server: str = "",
    acr_username: str = "",
    acr_password: str = "",
) -> dict[str, Any]:
    client_slug = normalize_resource_name(client_name, max_length=18)
    deployment_id = f"{utc_now().strftime('%Y%m%d%H%M%S')}-{client_slug}"
    deployment_root = DEPLOYMENTS_ROOT / client_slug / deployment_id
    name_stem = normalize_resource_name(f"ps-{client_slug}", max_length=20)
    postgres_server = normalize_resource_name(f"pg-{client_slug}", max_length=30)
    resolved_resource_group = validate_resource_group_name(resource_group or f"rg-{name_stem}")
    state = {
        "deployment_id": deployment_id,
        "client_name": client_name,
        "client_slug": client_slug,
        "environment": "production",
        "state_dir": str(deployment_root),
        "created_at_utc": utc_now_iso(),
        "completed_phases": [],
        "source": source,
        "azure": {
            "subscription": subscription,
            "location": location,
            "resource_group_provisioning_mode": resource_group_provisioning_mode,
            "acr_access_mode": acr_access_mode,
            "acr_provisioning_mode": acr_provisioning_mode,
            "acr_sku": acr_sku,
            "acr_name": acr_name,
            "acr_login_server": acr_login_server,
            "acr_username": acr_username,
            "acr_password": acr_password,
            "key_vault_name": normalize_resource_name(f"kv-{client_slug}", max_length=24),
            "key_vault_url": "",
            "resource_group": resolved_resource_group,
            "log_analytics_workspace": f"law-{name_stem}",
            "containerapp_environment": f"cae-{name_stem}",
            "app_insights_name": f"appi-{name_stem}",
            "web_app_name": normalize_resource_name(f"web-{client_slug}", max_length=28),
            "worker_app_name": normalize_resource_name(f"worker-{client_slug}", max_length=28),
            "postgres_server": postgres_server,
            "postgres_location": location,
            "postgres_database": "sentinel",
            "postgres_admin_username": "sentineladmin",
            "postgres_admin_password": generate_secret(32),
        },
        "database": {},
        "runtime": {},
        "license": {},
        "results": {"smoke_checks": {}},
        "manual_checkpoints": {},
    }
    return state


def resolve_latest_state_dir(client_slug: str | None = None) -> Path | None:
    if not DEPLOYMENTS_ROOT.exists():
        return None
    roots: list[Path]
    if client_slug:
        roots = [DEPLOYMENTS_ROOT / client_slug]
    else:
        roots = [path for path in DEPLOYMENTS_ROOT.iterdir() if path.is_dir()]
    state_paths = [path / STATE_FILE_NAME for root in roots if root.exists() for path in root.iterdir() if path.is_dir() and (path / STATE_FILE_NAME).exists()]
    if not state_paths:
        return None
    latest = max(state_paths, key=lambda path: path.stat().st_mtime)
    return latest.parent


def resolve_state_path(state_dir: str | None = None, *, resume: bool = False, client_slug: str | None = None) -> Path:
    if state_dir:
        resolved = Path(state_dir).expanduser().resolve()
        if not resolved.exists():
            raise DeploymentError(f"State directory does not exist: {resolved}")
        return resolved
    if resume:
        resolved = resolve_latest_state_dir(client_slug)
        if resolved:
            return resolved
    raise DeploymentError("Pass --state-dir or --resume to select a deployment state directory.")


def resolve_state_paths(state_dir: Path) -> dict[str, Path]:
    return {
        "state_dir": state_dir,
        "state_file": state_dir / STATE_FILE_NAME,
        "env_snapshot_file": state_dir / ENV_SNAPSHOT_FILE_NAME,
        "summary_file": state_dir / SUMMARY_FILE_NAME,
    }


def load_state_from_dir(state_dir: Path) -> dict[str, Any]:
    paths = resolve_state_paths(state_dir)
    if not paths["state_file"].exists():
        raise DeploymentError(f"Missing state file: {paths['state_file']}")
    state = load_json(paths["state_file"])
    state["state_dir"] = str(state_dir)
    return state


def mark_phase_completed(state: dict[str, Any], phase_name: str) -> None:
    phases = list(state.get("completed_phases") or [])
    if phase_name not in phases:
        phases.append(phase_name)
    state["completed_phases"] = phases
    state["updated_at_utc"] = utc_now_iso()


def build_runtime_env_snapshot(state: dict[str, Any]) -> dict[str, str]:
    azure = state.get("azure", {})
    runtime = state.get("runtime", {})
    source = state.get("source", {})
    database = state.get("database", {})
    snapshot = {
        "APP_VERSION": str(source.get("app_version") or ""),
        "DATABASE_URL": str(database.get("database_url") or runtime.get("DATABASE_URL") or ""),
        "DATAVERSE_BASE_URL": str(runtime.get("DATAVERSE_BASE_URL") or ""),
        "POWER_PLATFORM_ENVIRONMENT_ID": str(runtime.get("POWER_PLATFORM_ENVIRONMENT_ID") or ""),
        "DATAVERSE_TABLE_URL": str(runtime.get("DATAVERSE_TABLE_URL") or ""),
        "DATAVERSE_COLUMN_PREFIX": str(runtime.get("DATAVERSE_COLUMN_PREFIX") or ""),
        "DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL": str(
            runtime.get("DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL") or ""
        ),
        "NEXTAUTH_URL": str(runtime.get("NEXTAUTH_URL") or ""),
        "ENTRA_TENANT_ID": str(runtime.get("ENTRA_TENANT_ID") or ""),
        "ENTRA_CLIENT_ID": str(runtime.get("ENTRA_CLIENT_ID") or ""),
        "ENTRA_CLIENT_SECRET": str(runtime.get("ENTRA_CLIENT_SECRET") or ""),
        "ADMIN_GROUP_ID": str(runtime.get("ADMIN_GROUP_ID") or ""),
        "USER_GROUP_ID": str(runtime.get("USER_GROUP_ID") or ""),
        "INTERNAL_EMAIL_DOMAINS": str(runtime.get("INTERNAL_EMAIL_DOMAINS") or ""),
        "DASHBOARD_DORMANT_LOOKBACK_DAYS": str(runtime.get("DASHBOARD_DORMANT_LOOKBACK_DAYS") or ""),
        "WORKER_API_URL": str(runtime.get("WORKER_API_URL") or ""),
        "WORKER_INTERNAL_API_TOKEN": str(runtime.get("WORKER_INTERNAL_API_TOKEN") or ""),
        "WORKER_HEARTBEAT_TOKEN": str(runtime.get("WORKER_HEARTBEAT_TOKEN") or ""),
        "WORKER_HEARTBEAT_URL": str(runtime.get("WORKER_HEARTBEAT_URL") or ""),
        "APPINSIGHTS_APP_ID": str(runtime.get("APPINSIGHTS_APP_ID") or ""),
        "APPINSIGHTS_API_KEY": str(runtime.get("APPINSIGHTS_API_KEY") or ""),
        "LICENSE_PUBLIC_KEY_PATH": str(runtime.get("LICENSE_PUBLIC_KEY_PATH") or ""),
        "LICENSE_CACHE_TTL_SECONDS": str(runtime.get("LICENSE_CACHE_TTL_SECONDS") or ""),
        "DB_CONNECT_TIMEOUT_SECONDS": str(runtime.get("DB_CONNECT_TIMEOUT_SECONDS") or ""),
        "SCHEDULER_POLL_SECONDS": str(runtime.get("SCHEDULER_POLL_SECONDS") or ""),
        "GRAPH_BASE": str(runtime.get("GRAPH_BASE") or ""),
        "GRAPH_MAX_CONCURRENCY": str(runtime.get("GRAPH_MAX_CONCURRENCY") or ""),
        "GRAPH_MAX_RETRIES": str(runtime.get("GRAPH_MAX_RETRIES") or ""),
        "GRAPH_CONNECT_TIMEOUT": str(runtime.get("GRAPH_CONNECT_TIMEOUT") or ""),
        "GRAPH_READ_TIMEOUT": str(runtime.get("GRAPH_READ_TIMEOUT") or ""),
        "GRAPH_PAGE_SIZE": str(runtime.get("GRAPH_PAGE_SIZE") or ""),
        "GRAPH_PERMISSIONS_BATCH_SIZE": str(runtime.get("GRAPH_PERMISSIONS_BATCH_SIZE") or ""),
        "GRAPH_PERMISSIONS_STALE_AFTER_HOURS": str(runtime.get("GRAPH_PERMISSIONS_STALE_AFTER_HOURS") or ""),
        "FLUSH_EVERY": str(runtime.get("FLUSH_EVERY") or ""),
        "AZ_RESOURCE_GROUP": str(azure.get("resource_group") or ""),
        "AZ_RESOURCE_GROUP_PROVISIONING_MODE": str(azure.get("resource_group_provisioning_mode") or ""),
        "AZ_ACR_ACCESS_MODE": str(azure.get("acr_access_mode") or ""),
        "AZ_ACR_PROVISIONING_MODE": str(azure.get("acr_provisioning_mode") or ""),
        "AZ_ACR_NAME": str(azure.get("acr_name") or ""),
        "AZ_ACR_LOGIN_SERVER": str(azure.get("acr_login_server") or ""),
        "AZ_WEB_APP_NAME": str(azure.get("web_app_name") or ""),
        "AZ_WORKER_APP_NAME": str(azure.get("worker_app_name") or ""),
        "AZ_KEY_VAULT_URL": str(azure.get("key_vault_url") or ""),
    }
    return snapshot


def build_summary_markdown(state: dict[str, Any]) -> str:
    source = state.get("source", {})
    azure = state.get("azure", {})
    database = state.get("database", {})
    runtime = state.get("runtime", {})
    license_state = state.get("license", {})
    results = state.get("results", {})
    smoke_checks = results.get("smoke_checks", {})
    completed_phases = ", ".join(state.get("completed_phases") or []) or "none"
    lines = [
        "# Client Deployment Summary",
        "",
        f"- Deployment ID: `{sanitize_markdown(state.get('deployment_id'))}`",
        f"- Client: `{sanitize_markdown(state.get('client_name'))}`",
        f"- State directory: `{sanitize_markdown(state.get('state_dir'))}`",
        f"- Completed phases: `{sanitize_markdown(completed_phases)}`",
        "",
        "## Source",
        "",
        f"- App version: `{sanitize_markdown(source.get('app_version'))}`",
        f"- Git branch: `{sanitize_markdown(source.get('git_branch'))}`",
        f"- Git commit: `{sanitize_markdown(source.get('git_commit_sha'))}`",
        f"- Image tag: `{sanitize_markdown(source.get('image_tag'))}`",
        "",
        "## Azure",
        "",
        f"- Subscription: `{sanitize_markdown(azure.get('subscription'))}`",
        f"- Location: `{sanitize_markdown(azure.get('location'))}`",
        f"- Resource group: `{sanitize_markdown(azure.get('resource_group'))}`",
        f"- Resource group provisioning mode: `{sanitize_markdown(azure.get('resource_group_provisioning_mode'))}`",
        f"- Container Apps environment: `{sanitize_markdown(azure.get('containerapp_environment'))}`",
        f"- ACR access mode: `{sanitize_markdown(azure.get('acr_access_mode'))}`",
        f"- ACR provisioning mode: `{sanitize_markdown(azure.get('acr_provisioning_mode'))}`",
        f"- ACR SKU: `{sanitize_markdown(azure.get('acr_sku'))}`",
        f"- ACR name: `{sanitize_markdown(azure.get('acr_name'))}`",
        f"- ACR login server: `{sanitize_markdown(azure.get('acr_login_server'))}`",
        f"- Key Vault: `{sanitize_markdown(azure.get('key_vault_name'))}`",
        f"- Key Vault URL: `{sanitize_markdown(azure.get('key_vault_url'))}`",
        f"- Web app: `{sanitize_markdown(azure.get('web_app_name'))}`",
        f"- Web FQDN: `{sanitize_markdown(azure.get('web_fqdn'))}`",
        f"- Worker app: `{sanitize_markdown(azure.get('worker_app_name'))}`",
        f"- Worker FQDN: `{sanitize_markdown(azure.get('worker_fqdn'))}`",
        "",
        "## Database",
        "",
        f"- Postgres server: `{sanitize_markdown(azure.get('postgres_server'))}`",
        f"- Postgres location: `{sanitize_markdown(azure.get('postgres_location') or azure.get('location'))}`",
        f"- Postgres database: `{sanitize_markdown(azure.get('postgres_database'))}`",
        f"- DATABASE_URL saved: `{'yes' if database.get('database_url') else 'no'}`",
        "",
        "## Runtime",
        "",
        f"- DATAVERSE_BASE_URL: `{sanitize_markdown(runtime.get('DATAVERSE_BASE_URL'))}`",
        f"- POWER_PLATFORM_ENVIRONMENT_ID: `{sanitize_markdown(runtime.get('POWER_PLATFORM_ENVIRONMENT_ID'))}`",
        f"- DATAVERSE_TABLE_URL: `{sanitize_markdown(runtime.get('DATAVERSE_TABLE_URL'))}`",
        f"- DATAVERSE_COLUMN_PREFIX: `{sanitize_markdown(runtime.get('DATAVERSE_COLUMN_PREFIX'))}`",
        f"- DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL: `{sanitize_markdown(runtime.get('DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL'))}`",
        f"- NEXTAUTH_URL: `{sanitize_markdown(runtime.get('NEXTAUTH_URL'))}`",
        f"- ENTRA_TENANT_ID: `{sanitize_markdown(runtime.get('ENTRA_TENANT_ID'))}`",
        f"- ENTRA_CLIENT_ID: `{sanitize_markdown(runtime.get('ENTRA_CLIENT_ID'))}`",
        f"- ADMIN_GROUP_ID: `{sanitize_markdown(runtime.get('ADMIN_GROUP_ID'))}`",
        f"- USER_GROUP_ID: `{sanitize_markdown(runtime.get('USER_GROUP_ID'))}`",
        "",
        "## License",
        "",
        f"- License file: `{sanitize_markdown(license_state.get('license_file_path'))}`",
        f"- License id: `{sanitize_markdown(license_state.get('license_id'))}`",
        f"- License type: `{sanitize_markdown(license_state.get('license_type'))}`",
        "",
        "## Results",
        "",
        f"- Web revision: `{sanitize_markdown(safe_get(results, 'web', 'latest_revision'))}`",
        f"- Worker revision: `{sanitize_markdown(safe_get(results, 'worker', 'latest_revision'))}`",
        f"- Smoke check web: `{sanitize_markdown(smoke_checks.get('web'))}`",
        f"- Smoke check worker: `{sanitize_markdown(smoke_checks.get('worker'))}`",
    ]
    return "\n".join(lines) + "\n"


def save_state(state: dict[str, Any]) -> None:
    state_dir = Path(state["state_dir"])
    paths = resolve_state_paths(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    write_private_json(paths["state_file"], state)
    write_private_json(paths["env_snapshot_file"], build_runtime_env_snapshot(state))
    write_private_text(paths["summary_file"], build_summary_markdown(state))


def csv_row_from_state(state: dict[str, Any]) -> dict[str, str]:
    source = state.get("source", {})
    azure = state.get("azure", {})
    database = state.get("database", {})
    runtime = state.get("runtime", {})
    license_state = state.get("license", {})
    results = state.get("results", {})
    smoke_checks = results.get("smoke_checks", {})
    row = {
        "deployment_id": str(state.get("deployment_id") or ""),
        "client_name": str(state.get("client_name") or ""),
        "client_slug": str(state.get("client_slug") or ""),
        "environment": str(state.get("environment") or ""),
        "deployed_at_utc": str(state.get("updated_at_utc") or state.get("created_at_utc") or ""),
        "app_version": str(source.get("app_version") or ""),
        "staging_version_source": str(source.get("staging_version_source") or ""),
        "git_branch": str(source.get("git_branch") or ""),
        "git_commit_sha": str(source.get("git_commit_sha") or ""),
        "image_tag": str(source.get("image_tag") or ""),
        "web_image": str(safe_get(results, "web", "expected_image") or ""),
        "worker_image": str(safe_get(results, "worker", "expected_image") or ""),
        "azure_subscription": str(azure.get("subscription") or ""),
        "azure_location": str(azure.get("location") or ""),
        "resource_group": str(azure.get("resource_group") or ""),
        "resource_group_provisioning_mode": str(azure.get("resource_group_provisioning_mode") or ""),
        "containerapp_environment": str(azure.get("containerapp_environment") or ""),
        "acr_access_mode": str(azure.get("acr_access_mode") or ""),
        "acr_provisioning_mode": str(azure.get("acr_provisioning_mode") or ""),
        "acr_sku": str(azure.get("acr_sku") or ""),
        "acr_name": str(azure.get("acr_name") or ""),
        "acr_login_server": str(azure.get("acr_login_server") or ""),
        "acr_username": str(azure.get("acr_username") or ""),
        "acr_password": str(azure.get("acr_password") or ""),
        "key_vault_name": str(azure.get("key_vault_name") or ""),
        "key_vault_url": str(azure.get("key_vault_url") or ""),
        "app_insights_name": str(azure.get("app_insights_name") or ""),
        "app_insights_app_id": str(runtime.get("APPINSIGHTS_APP_ID") or azure.get("app_insights_app_id") or ""),
        "app_insights_api_key": str(runtime.get("APPINSIGHTS_API_KEY") or azure.get("app_insights_api_key") or ""),
        "postgres_server": str(azure.get("postgres_server") or ""),
        "postgres_location": str(azure.get("postgres_location") or azure.get("location") or ""),
        "postgres_database": str(azure.get("postgres_database") or ""),
        "postgres_admin_username": str(azure.get("postgres_admin_username") or ""),
        "postgres_admin_password": str(azure.get("postgres_admin_password") or ""),
        "database_url": str(database.get("database_url") or runtime.get("DATABASE_URL") or ""),
        "dataverse_base_url": str(runtime.get("DATAVERSE_BASE_URL") or ""),
        "power_platform_environment_id": str(runtime.get("POWER_PLATFORM_ENVIRONMENT_ID") or ""),
        "dataverse_table_url": str(runtime.get("DATAVERSE_TABLE_URL") or ""),
        "dataverse_column_prefix": str(runtime.get("DATAVERSE_COLUMN_PREFIX") or ""),
        "dataverse_agent_security_group_mapping_table_url": str(
            runtime.get("DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL") or ""
        ),
        "web_app_name": str(azure.get("web_app_name") or ""),
        "web_fqdn": str(azure.get("web_fqdn") or ""),
        "worker_app_name": str(azure.get("worker_app_name") or ""),
        "worker_fqdn": str(azure.get("worker_fqdn") or ""),
        "nextauth_url": str(runtime.get("NEXTAUTH_URL") or ""),
        "entra_tenant_id": str(runtime.get("ENTRA_TENANT_ID") or ""),
        "entra_client_id": str(runtime.get("ENTRA_CLIENT_ID") or ""),
        "entra_client_secret": str(runtime.get("ENTRA_CLIENT_SECRET") or ""),
        "admin_group_id": str(runtime.get("ADMIN_GROUP_ID") or ""),
        "user_group_id": str(runtime.get("USER_GROUP_ID") or ""),
        "internal_email_domains": str(runtime.get("INTERNAL_EMAIL_DOMAINS") or ""),
        "dashboard_dormant_lookback_days": str(runtime.get("DASHBOARD_DORMANT_LOOKBACK_DAYS") or ""),
        "worker_api_url": str(runtime.get("WORKER_API_URL") or ""),
        "worker_internal_api_token": str(runtime.get("WORKER_INTERNAL_API_TOKEN") or ""),
        "worker_heartbeat_token": str(runtime.get("WORKER_HEARTBEAT_TOKEN") or ""),
        "worker_heartbeat_url": str(runtime.get("WORKER_HEARTBEAT_URL") or ""),
        "license_public_key_path": str(runtime.get("LICENSE_PUBLIC_KEY_PATH") or ""),
        "license_cache_ttl_seconds": str(runtime.get("LICENSE_CACHE_TTL_SECONDS") or ""),
        "db_connect_timeout_seconds": str(runtime.get("DB_CONNECT_TIMEOUT_SECONDS") or ""),
        "scheduler_poll_seconds": str(runtime.get("SCHEDULER_POLL_SECONDS") or ""),
        "graph_base": str(runtime.get("GRAPH_BASE") or ""),
        "graph_max_concurrency": str(runtime.get("GRAPH_MAX_CONCURRENCY") or ""),
        "graph_max_retries": str(runtime.get("GRAPH_MAX_RETRIES") or ""),
        "graph_connect_timeout": str(runtime.get("GRAPH_CONNECT_TIMEOUT") or ""),
        "graph_read_timeout": str(runtime.get("GRAPH_READ_TIMEOUT") or ""),
        "graph_page_size": str(runtime.get("GRAPH_PAGE_SIZE") or ""),
        "graph_permissions_batch_size": str(runtime.get("GRAPH_PERMISSIONS_BATCH_SIZE") or ""),
        "graph_permissions_stale_after_hours": str(runtime.get("GRAPH_PERMISSIONS_STALE_AFTER_HOURS") or ""),
        "flush_every": str(runtime.get("FLUSH_EVERY") or ""),
        "license_id": str(license_state.get("license_id") or ""),
        "license_type": str(license_state.get("license_type") or ""),
        "license_file_path": str(license_state.get("license_file_path") or ""),
        "license_installed_at_utc": str(license_state.get("installed_at_utc") or ""),
        "web_latest_revision": str(safe_get(results, "web", "latest_revision") or ""),
        "web_ready_revision": str(safe_get(results, "web", "ready_revision") or ""),
        "worker_latest_revision": str(safe_get(results, "worker", "latest_revision") or ""),
        "worker_ready_revision": str(safe_get(results, "worker", "ready_revision") or ""),
        "web_image_matches_expected": str(safe_get(results, "web", "image_matches_expected") or ""),
        "worker_image_matches_expected": str(safe_get(results, "worker", "image_matches_expected") or ""),
        "smoke_check_web": str(smoke_checks.get("web") or ""),
        "smoke_check_worker": str(smoke_checks.get("worker") or ""),
    }
    return {field: str(row.get(field, "")) for field in MASTER_CSV_FIELDS}


def append_master_csv_row(state: dict[str, Any]) -> None:
    DEPLOYMENTS_ROOT.mkdir(parents=True, exist_ok=True)
    existing_ids: set[str] = set()
    if MASTER_CSV_PATH.exists():
        with MASTER_CSV_PATH.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                existing_ids.add(row.get("deployment_id", ""))
    row = csv_row_from_state(state)
    if row["deployment_id"] in existing_ids:
        return
    write_header = not MASTER_CSV_PATH.exists()
    MASTER_CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    with MASTER_CSV_PATH.open("a", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=MASTER_CSV_FIELDS)
        if write_header:
            writer.writeheader()
        writer.writerow(row)
    MASTER_CSV_PATH.chmod(stat.S_IRUSR | stat.S_IWUSR)


@dataclass
class ParsedArgs:
    phase: str
    state_dir: str | None
    dry_run: bool
    resume: bool
    client_slug: str | None


def parse_args(argv: Sequence[str]) -> ParsedArgs:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase")
    parser.add_argument("--state-dir")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--client-slug")
    parsed = parser.parse_args(list(argv))
    return ParsedArgs(
        phase=parsed.phase,
        state_dir=parsed.state_dir,
        dry_run=parsed.dry_run,
        resume=parsed.resume,
        client_slug=parsed.client_slug,
    )


class BaseIO:
    def print(self, message: str) -> None:
        raise NotImplementedError

    def prompt(
        self,
        label: str,
        *,
        default: str | None = None,
        validator: Callable[[str], str] | None = None,
        secret: bool = False,
        allow_empty: bool = False,
    ) -> str:
        raise NotImplementedError

    def confirm(self, label: str, default: bool = True) -> bool:
        raise NotImplementedError


class ConsoleIO(BaseIO):
    def print(self, message: str) -> None:
        print(message)

    def prompt(
        self,
        label: str,
        *,
        default: str | None = None,
        validator: Callable[[str], str] | None = None,
        secret: bool = False,
        allow_empty: bool = False,
    ) -> str:
        suffix = f" [{default}]" if default not in (None, "") else ""
        while True:
            prompt_text = f"{label}{suffix}: "
            value = getpass.getpass(prompt_text) if secret else input(prompt_text)
            if value == "" and default is not None:
                value = default
            if value == "" and allow_empty:
                return ""
            try:
                return validator(value) if validator else value
            except Exception as exc:  # pragma: no cover - interactive path
                self.print(f"Invalid value: {exc}")

    def confirm(self, label: str, default: bool = True) -> bool:
        default_label = "Y/n" if default else "y/N"
        while True:
            raw = input(f"{label} [{default_label}]: ").strip().lower()
            if not raw:
                return default
            if raw in {"y", "yes"}:
                return True
            if raw in {"n", "no"}:
                return False
            self.print("Enter yes or no.")


def write_temp_sql(sql_text: str) -> Path:
    handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".sql")
    handle.write(sql_text)
    handle.flush()
    handle.close()
    return Path(handle.name)
