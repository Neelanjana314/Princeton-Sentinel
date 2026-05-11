import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "New Deployment Scripts" / "deployment_lib.py"
SPEC = importlib.util.spec_from_file_location("deployment_lib", MODULE_PATH)
deployment_lib = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = deployment_lib
SPEC.loader.exec_module(deployment_lib)

DEPLOY_MODULE_PATH = ROOT / "scripts" / "New Deployment Scripts" / "deploy_client_environment.py"
DEPLOY_SPEC = importlib.util.spec_from_file_location("deploy_client_environment", DEPLOY_MODULE_PATH)
deploy_client_environment = importlib.util.module_from_spec(DEPLOY_SPEC)
assert DEPLOY_SPEC and DEPLOY_SPEC.loader
sys.modules[DEPLOY_SPEC.name] = deploy_client_environment
DEPLOY_SPEC.loader.exec_module(deploy_client_environment)


class FakeIO(deployment_lib.BaseIO):
    def __init__(self, prompts: list[str] | None = None):
        self.prompts = list(prompts or [])
        self.messages: list[str] = []
        self.prompt_labels: list[str] = []

    def print(self, message: str) -> None:
        self.messages.append(message)

    def prompt(
        self,
        label: str,
        *,
        default: str | None = None,
        validator=None,
        secret: bool = False,
        allow_empty: bool = False,
    ) -> str:
        self.prompt_labels.append(label)
        if self.prompts:
            value = self.prompts.pop(0)
        elif default is not None:
            value = default
        elif allow_empty:
            value = ""
        else:
            raise AssertionError(f"Unexpected prompt: {label}")
        return validator(value) if validator else value

    def confirm(self, label: str, default: bool = True) -> bool:
        return default


class DeployClientEnvironmentTests(unittest.TestCase):
    def test_staging_version_matches_semver(self):
        version = deployment_lib.compute_source_metadata()["app_version"]
        self.assertRegex(version, r"^\d+\.\d+\.\d+$")

    def test_compute_source_metadata_marks_dirty_worktrees_in_image_tag(self):
        with patch.object(
            deployment_lib,
            "run_and_capture",
            side_effect=[
                "3.3.0",
                "main",
                "abcdef1234567890",
                " M scripts/ci/package-worker-runtime.sh\n",
            ],
        ):
            metadata = deployment_lib.compute_source_metadata()

        self.assertEqual(metadata["git_commit_sha"], "abcdef1234567890")
        self.assertEqual(metadata["image_tag"], "abcdef123456-dirty-fd69d991")

    def test_resource_name_normalization_matches_azure_constraints(self):
        self.assertEqual(deployment_lib.normalize_resource_name("Client ACR!!", max_length=16), "client-acr")
        self.assertEqual(deployment_lib.normalize_resource_name("123 Princeton Sentinel", max_length=14), "s123-princeton")

    def test_acr_name_normalization_matches_acr_constraints(self):
        self.assertEqual(deployment_lib.normalize_acr_name("Client ACR!!"), "clientacr")
        self.assertEqual(deployment_lib.normalize_acr_name("123"), "a1230")

    def test_resource_group_name_validation_allows_existing_azure_names(self):
        self.assertEqual(deployment_lib.validate_resource_group_name("rg.prod_(client_1)"), "rg.prod_(client_1)")
        with self.assertRaisesRegex(ValueError, "unsupported characters"):
            deployment_lib.validate_resource_group_name("rg/client")
        with self.assertRaisesRegex(ValueError, "must not end with a period"):
            deployment_lib.validate_resource_group_name("rg-client.")

    def test_command_rendering_masks_secrets(self):
        rendered = deployment_lib.render_command(
            ["az", "rest", "--method", "PATCH", "--body", '{"password":"super-secret","name":"demo"}'],
            secrets_to_mask=["super-secret"],
        )
        self.assertIn("az rest --method PATCH --body", rendered)
        self.assertIn("***", rendered)
        self.assertNotIn("super-secret", rendered)

    def test_database_url_building_embeds_schema_search_path(self):
        url = deployment_lib.build_database_url(
            username="sentinel_app",
            password="pw!",
            host="db.example.com",
            port=5432,
            database="sentinel",
            schema="client_schema",
        )
        self.assertIn("sslmode=require", url)
        self.assertIn("options=-c+search_path%3Dclient_schema%2Cpublic", url)

    def test_database_url_schema_augmentation_preserves_existing_query_items(self):
        url = deployment_lib.augment_database_url_schema(
            "postgresql://app:pw@db.example.com:5432/sentinel?sslmode=require&application_name=worker",
            "tenant_one",
        )
        self.assertIn("application_name=worker", url)
        self.assertIn("options=-c+search_path%3Dtenant_one%2Cpublic", url)

    def test_run_and_capture_or_default_returns_default_on_non_zero_exit(self):
        output = deployment_lib.run_and_capture_or_default(
            ["python3", "-c", "import sys; sys.exit(1)"],
            default="missing",
        )
        self.assertEqual(output, "missing")

    def test_sql_dependency_detection_helpers_return_booleans(self):
        self.assertIsInstance(deployment_lib.command_exists("python3"), bool)
        self.assertIsInstance(deployment_lib.psycopg2_available(), bool)

    def test_discovers_init_sql_files_in_lexical_order(self):
        files = deployment_lib.discover_init_sql_files()
        names = [path.name for path in files]
        self.assertEqual(
            names[:5],
            [
                "001_schema.sql",
                "002_jobs.sql",
                "003_materialized_views.sql",
                "004_audit.sql",
                "005_revoke_permission_logs.sql",
            ],
        )

    def test_discovers_required_extensions_from_init_sql(self):
        extensions = deploy_client_environment.discover_required_extensions(
            deployment_lib.discover_init_sql_files()
        )
        self.assertIn("pgcrypto", extensions)

    def test_required_web_public_assets_exist(self):
        deploy_client_environment.ensure_required_web_public_assets()

    def test_state_save_and_load_round_trip(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state("Acme District", source, "sub-123", "eastus", "sharedacr")
        with tempfile.TemporaryDirectory() as tmp_dir:
            state["state_dir"] = str(Path(tmp_dir))
            state["runtime"]["ENTRA_TENANT_ID"] = "tenant"
            state["database"]["database_url"] = "postgresql://example"
            deployment_lib.save_state(state)
            loaded = deployment_lib.load_state_from_dir(Path(tmp_dir))
            self.assertEqual(loaded["client_name"], "Acme District")
            self.assertEqual(loaded["runtime"]["ENTRA_TENANT_ID"], "tenant")
            self.assertEqual(loaded["database"]["database_url"], "postgresql://example")
            self.assertEqual(loaded["azure"]["postgres_location"], "eastus")

    def test_master_csv_row_contains_expected_fields(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state("Acme District", source, "sub-123", "eastus", "sharedacr")
        state["database"]["database_url"] = "postgresql://example"
        state["runtime"]["ENTRA_TENANT_ID"] = "tenant"
        state["runtime"]["ENTRA_CLIENT_ID"] = "client"
        state["runtime"]["ENTRA_CLIENT_SECRET"] = "secret"
        state["runtime"]["ADMIN_GROUP_ID"] = "admins"
        state["runtime"]["USER_GROUP_ID"] = "users"
        state["runtime"]["DATAVERSE_BASE_URL"] = "https://org.crm.dynamics.com"
        state["runtime"]["POWER_PLATFORM_ENVIRONMENT_ID"] = "env-123"
        state["runtime"]["DATAVERSE_TABLE_URL"] = "https://org.crm.dynamics.com/api/data/v9.2/cr6c3_table11s"
        state["runtime"]["DATAVERSE_COLUMN_PREFIX"] = "cr6c3"
        state["runtime"]["DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL"] = (
            "https://org.crm.dynamics.com/api/data/v9.2/cr6c3_agentsecuritygroupmappings"
        )
        row = deployment_lib.csv_row_from_state(state)
        self.assertEqual(row["client_name"], "Acme District")
        self.assertEqual(row["acr_name"], "sharedacr")
        self.assertEqual(row["database_url"], "postgresql://example")
        self.assertEqual(row["dataverse_base_url"], "https://org.crm.dynamics.com")
        self.assertEqual(row["power_platform_environment_id"], "env-123")
        self.assertEqual(row["dataverse_table_url"], "https://org.crm.dynamics.com/api/data/v9.2/cr6c3_table11s")
        self.assertEqual(row["dataverse_column_prefix"], "cr6c3")
        self.assertEqual(
            row["dataverse_agent_security_group_mapping_table_url"],
            "https://org.crm.dynamics.com/api/data/v9.2/cr6c3_agentsecuritygroupmappings",
        )
        self.assertEqual(row["entra_client_secret"], "secret")
        self.assertEqual(row["postgres_location"], "eastus")

    def test_default_state_captures_existing_resource_group_choice(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state(
            "Acme District",
            source,
            "sub-123",
            "eastus",
            "sharedacr",
            resource_group="rg.shared_(prod)",
            resource_group_provisioning_mode="existing",
        )
        self.assertEqual(state["azure"]["resource_group"], "rg.shared_(prod)")
        self.assertEqual(state["azure"]["resource_group_provisioning_mode"], "existing")
        row = deployment_lib.csv_row_from_state(state)
        self.assertEqual(row["resource_group"], "rg.shared_(prod)")
        self.assertEqual(row["resource_group_provisioning_mode"], "existing")

    def test_ensure_resource_group_creates_new_group_by_default(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state("Acme District", source, "sub-123", "eastus", "sharedacr")
        io = MagicMock()

        with patch.object(deploy_client_environment, "run_command") as run_command_mock:
            deploy_client_environment.ensure_resource_group(state, dry_run=False, io=io)

        command = run_command_mock.call_args.args[0]
        self.assertEqual(command[:3], ["az", "group", "create"])
        self.assertIn(state["azure"]["resource_group"], command)
        self.assertIn("eastus", command)

    def test_ensure_resource_group_validates_existing_group_without_creating(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state(
            "Acme District",
            source,
            "sub-123",
            "eastus",
            "sharedacr",
            resource_group="rg-existing",
            resource_group_provisioning_mode="existing",
        )
        io = MagicMock()

        with (
            patch.object(deploy_client_environment, "run_and_capture_or_default", return_value="rg-existing") as capture_mock,
            patch.object(deploy_client_environment, "run_command") as run_command_mock,
        ):
            deploy_client_environment.ensure_resource_group(state, dry_run=False, io=io)

        command = capture_mock.call_args.args[0]
        self.assertEqual(command[:3], ["az", "group", "show"])
        self.assertIn("rg-existing", command)
        run_command_mock.assert_not_called()

    def test_ensure_resource_group_fails_when_existing_group_is_missing(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state(
            "Acme District",
            source,
            "sub-123",
            "eastus",
            "sharedacr",
            resource_group="rg-missing",
            resource_group_provisioning_mode="existing",
        )
        io = MagicMock()

        with patch.object(deploy_client_environment, "run_and_capture_or_default", return_value=""):
            with self.assertRaisesRegex(deploy_client_environment.DeploymentError, "Resource group does not exist"):
                deploy_client_environment.ensure_resource_group(state, dry_run=False, io=io)

    def test_external_acr_state_and_csv_row_capture_registry_credentials(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state(
            "Acme District",
            source,
            "sub-123",
            "eastus",
            "sharedacr",
            acr_access_mode="registry-credentials",
            acr_login_server="sharedacr.azurecr.io",
            acr_username="00000000-0000-0000-0000-000000000000",
            acr_password="pull-secret",
        )
        row = deployment_lib.csv_row_from_state(state)
        self.assertEqual(row["acr_access_mode"], "registry-credentials")
        self.assertEqual(row["acr_login_server"], "sharedacr.azurecr.io")
        self.assertEqual(row["acr_username"], "00000000-0000-0000-0000-000000000000")
        self.assertEqual(row["acr_password"], "pull-secret")

    def test_new_basic_acr_state_captures_provisioning_mode(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state(
            "Acme District",
            source,
            "sub-123",
            "eastus",
            "acmedistrictacr",
            acr_access_mode="managed-identity",
            acr_provisioning_mode="create-basic",
            acr_sku="Basic",
        )
        row = deployment_lib.csv_row_from_state(state)
        self.assertEqual(row["acr_access_mode"], "managed-identity")
        self.assertEqual(row["acr_provisioning_mode"], "create-basic")
        self.assertEqual(row["acr_sku"], "Basic")
        self.assertEqual(row["acr_name"], "acmedistrictacr")

    def test_create_basic_acr_defaults_to_registry_credentials(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state(
            "Acme District",
            source,
            "sub-123",
            "eastus",
            "acmedistrictacr",
            acr_access_mode="managed-identity",
            acr_provisioning_mode="create-basic",
            acr_sku="Basic",
        )
        deploy_client_environment.ensure_acr_defaults(state)
        self.assertEqual(state["azure"]["acr_access_mode"], "registry-credentials")

    def test_ensure_acr_created_with_registry_credentials_captures_admin_credentials(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state(
            "Acme District",
            source,
            "sub-123",
            "eastus",
            "acmedistrictacr",
            acr_access_mode="registry-credentials",
            acr_provisioning_mode="create-basic",
            acr_sku="Basic",
        )
        io = MagicMock()

        with (
            patch.object(deploy_client_environment, "run_command") as run_command_mock,
            patch.object(deploy_client_environment, "run_and_capture_or_default", return_value=""),
            patch.object(
                deploy_client_environment,
                "run_and_capture",
                side_effect=[
                    "acmedistrictacr.azurecr.io",
                    json.dumps({"username": "acmedistrictacr", "passwords": [{"value": "admin-secret"}]}),
                ],
            ),
        ):
            deploy_client_environment.ensure_acr(state, dry_run=False, io=io)

        commands = [call.args[0] for call in run_command_mock.call_args_list]
        self.assertIn(
            [
                "az",
                "acr",
                "create",
                "--name",
                "acmedistrictacr",
                "--resource-group",
                state["azure"]["resource_group"],
                "--location",
                "eastus",
                "--sku",
                "Basic",
            ],
            commands,
        )
        self.assertIn(
            [
                "az",
                "acr",
                "update",
                "--name",
                "acmedistrictacr",
                "--resource-group",
                state["azure"]["resource_group"],
                "--admin-enabled",
                "true",
            ],
            commands,
        )
        self.assertEqual(state["azure"]["acr_login_server"], "acmedistrictacr.azurecr.io")
        self.assertEqual(state["azure"]["acr_username"], "acmedistrictacr")
        self.assertEqual(state["azure"]["acr_password"], "admin-secret")

    def test_parse_args_supports_resume_and_state_dir(self):
        parsed = deployment_lib.parse_args(["deploy-web", "--state-dir", "/tmp/example", "--dry-run", "--resume"])
        self.assertEqual(parsed.phase, "deploy-web")
        self.assertEqual(parsed.state_dir, "/tmp/example")
        self.assertTrue(parsed.dry_run)
        self.assertTrue(parsed.resume)

    def test_runtime_snapshot_includes_acr_mode_and_login_server(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state(
            "Acme District",
            source,
            "sub-123",
            "eastus",
            "sharedacr",
            acr_access_mode="registry-credentials",
            acr_login_server="sharedacr.azurecr.io",
        )
        snapshot = deployment_lib.build_runtime_env_snapshot(state)
        self.assertEqual(snapshot["AZ_ACR_ACCESS_MODE"], "registry-credentials")
        self.assertEqual(snapshot["AZ_ACR_LOGIN_SERVER"], "sharedacr.azurecr.io")

    def test_runtime_snapshot_includes_acr_provisioning_mode(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state(
            "Acme District",
            source,
            "sub-123",
            "eastus",
            "acmedistrictacr",
            acr_access_mode="managed-identity",
            acr_provisioning_mode="create-basic",
            acr_sku="Basic",
        )
        snapshot = deployment_lib.build_runtime_env_snapshot(state)
        self.assertEqual(snapshot["AZ_ACR_ACCESS_MODE"], "managed-identity")
        self.assertEqual(snapshot["AZ_ACR_PROVISIONING_MODE"], "create-basic")

    def test_runtime_env_for_scripts_includes_key_vault_contract(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state("Acme District", source, "sub-123", "eastus", "sharedacr")
        state["runtime"]["DATABASE_URL"] = "postgresql://example"
        state["runtime"]["DATAVERSE_BASE_URL"] = "https://org.crm.dynamics.com"
        state["runtime"]["POWER_PLATFORM_ENVIRONMENT_ID"] = "env-123"
        state["runtime"]["DATAVERSE_TABLE_URL"] = "https://org.crm.dynamics.com/api/data/v9.2/cr6c3_table11s"
        state["runtime"]["DATAVERSE_COLUMN_PREFIX"] = "cr6c3"
        state["runtime"]["DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL"] = (
            "https://org.crm.dynamics.com/api/data/v9.2/cr6c3_agentsecuritygroupmappings"
        )
        state["runtime"]["ENTRA_TENANT_ID"] = "tenant"
        state["runtime"]["ENTRA_CLIENT_ID"] = "client"
        state["runtime"]["ENTRA_CLIENT_SECRET"] = "secret"
        state["runtime"]["ADMIN_GROUP_ID"] = "admins"
        state["runtime"]["USER_GROUP_ID"] = "users"
        state["runtime"]["NEXTAUTH_URL"] = "https://web.example.com"
        state["runtime"]["WORKER_API_URL"] = "https://worker.example.com"
        state["runtime"]["WORKER_INTERNAL_API_TOKEN"] = "worker-token"
        state["runtime"]["WORKER_HEARTBEAT_TOKEN"] = "heartbeat-token"
        state["runtime"]["WORKER_HEARTBEAT_URL"] = "https://web.example.com/api/internal/worker-heartbeat"

        env = deploy_client_environment.runtime_env_for_scripts(state)

        self.assertEqual(env["AZ_KEY_VAULT_URL"], state["azure"]["key_vault_url"])
        self.assertEqual(env["NEXTAUTH_URL"], "https://web.example.com")
        self.assertEqual(env["WORKER_API_URL"], "https://worker.example.com")
        self.assertEqual(env["WORKER_HEARTBEAT_URL"], "https://web.example.com/api/internal/worker-heartbeat")
        self.assertFalse(any(key.startswith("STG_") for key in env))

    def test_deploy_staging_workflow_uses_key_vault_instead_of_stg_runtime_config(self):
        workflow = (ROOT / ".github" / "workflows" / "deploy-staging.yml").read_text()

        validate_block = workflow.split("      - name: Validate web staging runtime config", maxsplit=1)[1].split(
            "      - name: Sync web staging runtime config",
            maxsplit=1,
        )[0]
        self.assertIn("AZ_KEY_VAULT_URL", validate_block)
        self.assertNotIn("STG_", validate_block)

        sync_block = workflow.split("      - name: Sync web staging runtime config", maxsplit=1)[1].split(
            "      - name: Build and push web image to ACR",
            maxsplit=1,
        )[0]
        self.assertIn("sync-staging-web-config.sh", sync_block)
        self.assertNotIn("STG_", sync_block)

    def test_package_web_runtime_entrypoint_does_not_export_auth_secret_env(self):
        package_script = (ROOT / "scripts" / "ci" / "package-web-runtime.sh").read_text()
        removed_runtime_secret = "NEXTAUTH" + "_SECRET"

        self.assertIn('cat > "${runtime_dir}/entrypoint.sh"', package_script)
        self.assertIn('CMD ["./entrypoint.sh"]', package_script)
        self.assertIn('exec node key-vault-entrypoint.cjs', package_script)
        self.assertNotIn(removed_runtime_secret, package_script)

    def test_sync_key_vault_runtime_config_writes_runtime_values_as_secrets(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state("Acme District", source, "sub-123", "eastus", "sharedacr")
        state["runtime"]["DATABASE_URL"] = "postgresql://example"
        state["runtime"]["DATAVERSE_BASE_URL"] = "https://org.crm.dynamics.com"
        state["runtime"]["DATAVERSE_TABLE_URL"] = "https://org.crm.dynamics.com/api/data/v9.2/cr6c3_table11s"
        state["runtime"]["DATAVERSE_COLUMN_PREFIX"] = "cr6c3"
        state["runtime"]["ENTRA_TENANT_ID"] = "tenant"
        state["runtime"]["ENTRA_CLIENT_ID"] = "client"
        state["runtime"]["ENTRA_CLIENT_SECRET"] = "secret"
        state["runtime"]["ADMIN_GROUP_ID"] = "admins"
        state["runtime"]["USER_GROUP_ID"] = "users"
        state["runtime"]["INTERNAL_EMAIL_DOMAINS"] = "example.com"
        state["runtime"]["NEXTAUTH_URL"] = "https://web.example.com"
        state["runtime"]["WORKER_API_URL"] = "https://worker.example.com"
        state["runtime"]["WORKER_INTERNAL_API_TOKEN"] = "worker-token"
        state["runtime"]["WORKER_HEARTBEAT_TOKEN"] = "heartbeat-token"
        state["runtime"]["WORKER_HEARTBEAT_URL"] = "https://web.example.com/api/internal/worker-heartbeat"

        with patch.object(deploy_client_environment, "run_command") as run_command_mock:
            deploy_client_environment.sync_key_vault_runtime_config(state, dry_run=True, io=MagicMock())

        commands = [call.args[0] for call in run_command_mock.call_args_list]
        self.assertTrue(
            any(
                command[:4] == ["az", "keyvault", "secret", "set"]
                and "DATABASE-URL" in command
                and "postgresql://example" in command
                for command in commands
            )
        )
        self.assertTrue(
            any(
                command[:4] == ["az", "keyvault", "secret", "set"]
                and "ENTRA-CLIENT-SECRET" in command
                and "secret" in command
                for command in commands
            )
        )
        self.assertTrue(
            any(
                command[:4] == ["az", "keyvault", "secret", "set"]
                and "DATAVERSE-AGENT-SECURITY-GROUP-MAPPING-TABLE-URL" in command
                and deploy_client_environment.KEY_VAULT_UNSET_VALUE in command
                for command in commands
            )
        )

    def test_staging_sync_scripts_do_not_ignore_legacy_cleanup_failures(self):
        web_script = (ROOT / "scripts" / "ci" / "sync-staging-web-config.sh").read_text()
        worker_script = (ROOT / "scripts" / "ci" / "sync-staging-worker-config.sh").read_text()

        self.assertNotIn("|| true", web_script)
        self.assertNotIn("|| true", worker_script)
        self.assertIn("remove_existing_env_vars", web_script)
        self.assertIn("remove_existing_env_vars", worker_script)

    def test_build_summary_markdown_mentions_smoke_checks(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state("Acme District", source, "sub-123", "eastus", "sharedacr")
        state["results"]["smoke_checks"] = {"web": "ok", "worker": "ok"}
        summary = deployment_lib.build_summary_markdown(state)
        self.assertIn("Smoke check web", summary)
        self.assertIn("Smoke check worker", summary)

    def test_app_insights_uses_existing_log_analytics_workspace(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state("Acme District", source, "sub-123", "eastus", "sharedacr")
        io = MagicMock()

        with (
            patch.object(deploy_client_environment, "run_and_capture_or_default", return_value=""),
            patch.object(
                deploy_client_environment,
                "run_and_capture",
                side_effect=["app-id", "api-key", '{"value":[]}', "[]"],
            ),
            patch.object(deploy_client_environment, "run_command") as run_command_mock,
        ):
            deploy_client_environment.ensure_app_insights(state, dry_run=False, io=io)

        create_command = next(
            command
            for command in (call.args[0] for call in run_command_mock.call_args_list)
            if command[:4] == ["az", "monitor", "app-insights", "component"]
        )
        self.assertIn("--workspace", create_command)
        self.assertIn(state["azure"]["log_analytics_workspace"], create_command)

    def test_disable_app_insights_smart_detection_disables_proactive_configs_and_rules(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state("Acme District", source, "sub-123", "eastus", "sharedacr")
        io = MagicMock()
        component_id = deploy_client_environment.app_insights_component_id(state)

        with (
            patch.object(
                deploy_client_environment,
                "run_and_capture",
                side_effect=[
                    json.dumps({"value": [{"name": "slowpageloadtime"}, {"name": "longdependencyduration"}]}),
                    json.dumps(
                        [
                            {
                                "id": "/subscriptions/sub-123/resourceGroups/rg-ps-acme-district/providers/Microsoft.AlertsManagement/smartDetectorAlertRules/failure-anomalies",
                                "properties": {"scope": [component_id]},
                            },
                            {
                                "id": "/subscriptions/sub-123/resourceGroups/rg-ps-acme-district/providers/Microsoft.AlertsManagement/smartDetectorAlertRules/unrelated",
                                "properties": {"scope": ["/subscriptions/sub-123/resourceGroups/rg-other/providers/Microsoft.Insights/components/other"]},
                            },
                        ]
                    ),
                ],
            ),
            patch.object(deploy_client_environment, "run_command") as run_command_mock,
        ):
            deploy_client_environment.disable_app_insights_smart_detection(state, dry_run=False, io=io)

        commands = [call.args[0] for call in run_command_mock.call_args_list]
        proactive_updates = [command for command in commands if command[:3] == ["az", "rest", "PUT"] or command[:4] == ["az", "rest", "--method", "PUT"]]
        self.assertEqual(len(proactive_updates), 2)
        self.assertTrue(
            any(
                command[:3] == ["az", "resource", "update"] and "properties.state=Disabled" in command
                for command in commands
            )
        )

    def test_disable_app_insights_smart_detection_accepts_list_response_for_proactive_configs(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state("Acme District", source, "sub-123", "eastus", "sharedacr")
        io = MagicMock()

        with (
            patch.object(
                deploy_client_environment,
                "run_and_capture",
                side_effect=[
                    json.dumps([{"name": "slowpageloadtime"}]),
                    "[]",
                ],
            ),
            patch.object(deploy_client_environment, "run_command") as run_command_mock,
        ):
            deploy_client_environment.disable_app_insights_smart_detection(state, dry_run=False, io=io)

        commands = [call.args[0] for call in run_command_mock.call_args_list]
        self.assertTrue(
            any(command[:4] == ["az", "rest", "--method", "PUT"] for command in commands)
        )

    def test_phase_build_worker_uses_shared_python_bin_for_runtime_packaging(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state("Acme District", source, "sub-123", "eastus", "sharedacr")
        io = MagicMock()

        with (
            patch.dict(deploy_client_environment.os.environ, {"PYTHON_BIN": "/custom/python3.11"}, clear=True),
            patch.object(
                deploy_client_environment,
                "compute_source_metadata",
                return_value={
                    "app_version": "3.3.1",
                    "staging_version_source": ".github/workflows/deploy-staging.yml",
                    "git_branch": "main",
                    "git_commit_sha": "fedcba0987654321",
                    "image_tag": "fedcba098765-dirty-12345678",
                },
            ),
            patch.object(deploy_client_environment, "run_and_capture", return_value="3.11"),
            patch.object(deploy_client_environment, "run_command") as run_command_mock,
            patch.object(deploy_client_environment, "cleanup_runtime_dir"),
            patch.object(deploy_client_environment, "persist"),
        ):
            deploy_client_environment.phase_build_worker(state, dry_run=True, io=io)

        commands = [call.args[0] for call in run_command_mock.call_args_list]
        self.assertIn(["/custom/python3.11", "-m", "pip", "install", "--upgrade", "pip"], commands)
        self.assertIn(["/custom/python3.11", "-m", "pip", "install", "-r", "worker/requirements.txt"], commands)
        self.assertIn(
            ["/custom/python3.11", "-m", "unittest", "discover", "-s", "worker/tests", "-p", "test_*.py"],
            commands,
        )
        self.assertFalse(any(command[:3] == ["/custom/python3.11", "-m", "compileall"] for command in commands))

        package_call = next(
            call for call in run_command_mock.call_args_list if call.args[0] == ["scripts/ci/package-worker-runtime.sh"]
        )
        self.assertEqual(package_call.kwargs["env"], {"PYTHON_BIN": "/custom/python3.11"})
        self.assertEqual(state["source"]["image_tag"], "fedcba098765-dirty-12345678")
        self.assertTrue(
            any(
                command[:4] == ["az", "acr", "build", "--registry"]
                and "sentinel-worker:fedcba098765-dirty-12345678" in command
                for command in commands
            )
        )

    def test_phase_build_worker_requires_python_311(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state("Acme District", source, "sub-123", "eastus", "sharedacr")
        io = MagicMock()

        with (
            patch.dict(deploy_client_environment.os.environ, {"PYTHON_BIN": "/custom/python3.10"}, clear=True),
            patch.object(deploy_client_environment, "compute_source_metadata", return_value=source),
            patch.object(deploy_client_environment, "run_and_capture", return_value="3.10"),
            patch.object(deploy_client_environment, "run_command") as run_command_mock,
        ):
            with self.assertRaisesRegex(deploy_client_environment.DeploymentError, "requires Python 3.11"):
                deploy_client_environment.phase_build_worker(state, dry_run=True, io=io)

        run_command_mock.assert_not_called()

    def test_update_containerapp_image_uses_plain_update_without_startup_override(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state("Acme District", source, "sub-123", "eastus", "sharedacr")
        io = MagicMock()

        with (
            patch.object(
                deploy_client_environment,
                "run_and_capture",
                return_value=json.dumps(
                    {
                        "properties": {
                            "template": {
                                "containers": [
                                    {
                                        "image": "sharedacr.azurecr.io/sentinel-worker:old",
                                    }
                                ]
                            }
                        }
                    }
                ),
            ),
            patch.object(deploy_client_environment, "run_command") as run_command_mock,
        ):
            deploy_client_environment.update_containerapp_image(
                state,
                state["azure"]["worker_app_name"],
                "sharedacr.azurecr.io/sentinel-worker:abcdef123456",
                dry_run=False,
                io=io,
            )

        update_command = run_command_mock.call_args.args[0]
        self.assertEqual(update_command[:3], ["az", "containerapp", "update"])
        self.assertIn("--image", update_command)
        self.assertNotIn("--yaml", update_command)

    def test_update_containerapp_image_clears_startup_override_via_cli_flags(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state("Acme District", source, "sub-123", "eastus", "sharedacr")
        io = MagicMock()

        with (
            patch.object(
                deploy_client_environment,
                "run_and_capture",
                return_value=json.dumps(
                    {
                        "properties": {
                            "template": {
                                "containers": [
                                    {
                                        "image": "sharedacr.azurecr.io/sentinel-worker:old",
                                        "command": [""],
                                        "args": [""],
                                    }
                                ]
                            }
                        }
                    }
                ),
            ),
            patch.object(deploy_client_environment, "run_command") as run_command_mock,
        ):
            deploy_client_environment.update_containerapp_image(
                state,
                state["azure"]["worker_app_name"],
                "sharedacr.azurecr.io/sentinel-worker:abcdef123456",
                dry_run=False,
                io=io,
            )

        update_command = run_command_mock.call_args.args[0]
        self.assertEqual(update_command[:3], ["az", "containerapp", "update"])
        self.assertIn("--image", update_command)
        self.assertIn("sharedacr.azurecr.io/sentinel-worker:abcdef123456", update_command)
        self.assertIn("--command", update_command)
        self.assertIn("--args", update_command)
        self.assertNotIn("--yaml", update_command)

    def test_phase_deploy_worker_fails_when_expected_image_is_not_active(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state("Acme District", source, "sub-123", "eastus", "sharedacr")
        state.setdefault("results", {}).setdefault("worker", {})["expected_image"] = "sharedacr.azurecr.io/sentinel-worker:new"
        io = MagicMock()

        with (
            patch.object(deploy_client_environment, "configure_registry"),
            patch.object(deploy_client_environment, "sync_worker_config"),
            patch.object(deploy_client_environment, "mount_license_public_key"),
            patch.object(deploy_client_environment, "run_command"),
            patch.object(deploy_client_environment, "update_containerapp_image"),
            patch.object(
                deploy_client_environment,
                "show_containerapp_details",
                return_value={
                    "app_name": state["azure"]["worker_app_name"],
                    "latest_revision": "worker--rev07",
                    "ready_revision": "worker--rev01",
                    "image": "sharedacr.azurecr.io/sentinel-worker:old",
                    "expected_image": "sharedacr.azurecr.io/sentinel-worker:new",
                    "fqdn": "worker.example.com",
                    "image_matches_expected": "false",
                },
            ),
            patch.object(deploy_client_environment, "persist") as persist_mock,
        ):
            with self.assertRaisesRegex(deploy_client_environment.DeploymentError, "not ready|still serving image"):
                deploy_client_environment.phase_deploy_worker(state, dry_run=False, io=io)

        persist_mock.assert_not_called()

    def test_suggest_postgres_location_override_prefers_alternate_region(self):
        self.assertEqual(
            deploy_client_environment.suggest_postgres_location_override("centralus", "centralus"),
            "eastus2",
        )
        self.assertEqual(
            deploy_client_environment.suggest_postgres_location_override("eastus2", "centralus"),
            "centralus",
        )
        self.assertEqual(
            deploy_client_environment.suggest_postgres_location_override("eastus", "westus3"),
            "westus3",
        )

    def test_ensure_postgres_server_prompts_for_location_override_after_repeated_internal_errors(self):
        source = {
            "app_version": "3.3.0",
            "staging_version_source": ".github/workflows/deploy-staging.yml",
            "git_branch": "main",
            "git_commit_sha": "abcdef1234567890",
            "image_tag": "abcdef123456",
        }
        state = deployment_lib.build_default_state("Acme District", source, "sub-123", "centralus", "sharedacr")
        state["runtime"]["OPERATOR_PUBLIC_IP"] = "173.70.232.215"
        io = FakeIO(prompts=["eastus2"])
        create_commands: list[list[str]] = []
        internal_error = subprocess.CalledProcessError(
            1,
            ["az", "postgres", "flexible-server", "create"],
            stderr=(
                "ERROR: (InternalServerError) An unexpected error occured while processing the request. "
                "Tracking ID: 'test-tracking-id'"
            ),
        )

        def fake_run_command(command, **kwargs):
            if command[:4] == ["az", "postgres", "flexible-server", "create"]:
                create_commands.append(list(command))
                if len(create_commands) <= deploy_client_environment.POSTGRES_CREATE_RETRY_ATTEMPTS:
                    raise internal_error
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with (
            patch.object(deploy_client_environment, "run_and_capture_or_default", return_value=""),
            patch.object(deploy_client_environment, "run_command", side_effect=fake_run_command),
            patch.object(deploy_client_environment, "ensure_postgres_public_access"),
            patch.object(deploy_client_environment, "ensure_postgres_firewall_rule"),
            patch.object(deploy_client_environment, "save_state") as save_state_mock,
            patch.object(deploy_client_environment.time, "sleep"),
        ):
            deploy_client_environment.ensure_postgres_server(state, dry_run=False, io=io)

        self.assertEqual(len(create_commands), deploy_client_environment.POSTGRES_CREATE_RETRY_ATTEMPTS + 1)
        self.assertEqual(state["azure"]["postgres_location"], "eastus2")
        self.assertIn("PostgreSQL location override", io.prompt_labels)
        self.assertIn("eastus2", create_commands[-1])
        save_state_mock.assert_called_once()


if __name__ == "__main__":
    unittest.main()
