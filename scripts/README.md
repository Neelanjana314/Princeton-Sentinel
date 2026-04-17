# Scripts

## `New Deployment Scripts/`

Interactive local deployment suite for provisioning a client Azure environment, bootstrapping the database, deploying web and worker images, installing a license, and writing a plaintext deployment record under `.local/deployments/`.

The runtime-capture phase records the shared Dataverse web settings used by staging deployment as well:

- required Dataverse app settings: `DATAVERSE_BASE_URL`, `DATAVERSE_TABLE_URL`, `DATAVERSE_COLUMN_PREFIX`
- optional Copilot quarantine settings: `POWER_PLATFORM_ENVIRONMENT_ID`, `DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL`

The suite uses a client-tenant ACR wired with Container App managed identity plus `AcrPull`.

During init, you can either:

- reuse an existing client-tenant ACR
- create a new Basic ACR and let provisioning wire it up

Start with:

```bash
./scripts/New\ Deployment\ Scripts/01-init-deployment.sh
```

Runbook:

- [`scripts/New Deployment Scripts/DEPLOYMENT_RUNBOOK.md`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/scripts/New%20Deployment%20Scripts/DEPLOYMENT_RUNBOOK.md)

## `db_migrations.py`

Run one SQL migration file from `db/migrations` against a target Postgres database.

### Usage

```bash
python3 scripts/db_migrations.py db/migrations/<migration_name>.sql
```

### Behavior

- Accepts exactly one SQL file path.
- Rejects files outside `db/migrations`.
- Prompts for `DATABASE_URL` interactively.
- Prompts for explicit confirmation (`yes`) before execution.
- Executes the SQL in a single transaction (commit on success, rollback on failure).

### Requirements

- Python 3.10+ (3.11 preferred)
- `psycopg2-binary` installed locally

Install dependency example:

```bash
python3 -m pip install psycopg2-binary
```

## `generate-license.mjs`

Generate a signed license artifact into `.local/licenses/` using a local private key that is not committed to VCS.

### Usage

```bash
node scripts/generate-license.mjs \
  --license-type enterprise \
  --tenant-id 00000000-0000-0000-0000-000000000000 \
  --expires-at 2026-12-31T23:59:59Z \
  --preset enterprise
```
