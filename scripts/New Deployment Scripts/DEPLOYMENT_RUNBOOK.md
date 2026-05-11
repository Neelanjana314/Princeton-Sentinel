# Client Azure Deployment Runbook

This suite creates one Azure client environment at a time and records plaintext deployment metadata in `.local/deployments/`, which is ignored by git.

Database-executing phases require either:

- `psql` available on your PATH, or
- `python3 -m pip install psycopg2-binary`

## Important Defaults

- Uses the current staging workflow version from `.github/workflows/deploy-staging.yml`.
- Uses a client-tenant Azure Container Registry.
- New ACRs created by this suite use ACR admin credentials stored on the Container Apps, matching the staging deployment model.
- Existing ACRs reused by this suite use Container App managed identity and `AcrPull`.
- Runtime configuration is stored in Azure Key Vault and loaded by the web and worker apps at startup through managed identity.
- During init, you can either:
  - reuse an existing client-tenant ACR
  - create a new Basic ACR in the deployment resource group
- Creates one dedicated Azure Database for PostgreSQL Flexible Server per client.
- Uses interactive `az login` and stores Azure CLI session files under `.local/azure-cli/`.
- Stores plaintext secrets in:
  - `.local/deployments/client-deployments-master.csv`
  - `.local/deployments/<client-slug>/<deployment-id>/state.json`
  - `.local/deployments/<client-slug>/<deployment-id>/env-snapshot.json`

## Common Flags

Every numbered script supports:

- `--state-dir /absolute/path/to/.local/deployments/<client-slug>/<deployment-id>`
- `--resume`
- `--dry-run`

Recommended usage:

1. Run `01-init-deployment.sh` with no flags.
2. Copy the emitted state directory path.
3. Pass `--state-dir ...` to every later script.

If a step fails and you want to continue the same deployment, rerun that script with the same `--state-dir`.

## Script Order

### 1. Initialize deployment state

Run:

```bash
./scripts/New\ Deployment\ Scripts/01-init-deployment.sh
```

Prompts for:

- client name
- Azure subscription
- Azure location
- whether to deploy into an existing resource group
- if existing: existing resource group name
- if creating: new resource group name, defaulting to `rg-ps-<client-slug>`
- whether to reuse an existing client-tenant ACR
- if reusing: existing ACR name
- if creating: new ACR name, with a Basic SKU created during provisioning and ACR admin credentials captured for Container App image pulls

Expected output:

- a new state directory under `.local/deployments/<client-slug>/<deployment-id>/`
- `state.json`
- `env-snapshot.json`
- `deployment-summary.md`

### 2. Provision Azure foundation

Run:

```bash
./scripts/New\ Deployment\ Scripts/02-provision-azure-foundation.sh --state-dir /absolute/path/to/state-dir
```

Prompts for:

- your current public IPv4 address for PostgreSQL operator access

Creates or confirms:

- resource group, or validates the existing resource group selected during init
- Azure Key Vault with RBAC enabled
- Log Analytics workspace
- Container Apps environment
- Application Insights component
- PostgreSQL Flexible Server
- PostgreSQL database
- PostgreSQL public access plus firewall rules for Azure services and your operator IP
- placeholder web and worker Container Apps using a simple public image
- creation of a new Basic ACR when selected during init
- for newly created ACRs: admin credentials enabled and stored on the web and worker Container Apps during deployment
- for existing managed-identity ACRs: `AcrPull` role assignment on the selected ACR for the web and worker Container Apps
- `Key Vault Secrets User` role assignment on the Key Vault for the web and worker Container App managed identities

Required Azure access for existing managed-identity ACRs:

- The signed-in identity must be able to create Azure RBAC assignments at the selected ACR scope, resource group scope, or subscription scope.
- Built-in roles that can do this include `Owner` and `User Access Administrator`.
- `Contributor` can create resources, but cannot grant `AcrPull` because it lacks `Microsoft.Authorization/roleAssignments/write`.

Required Azure access for newly created ACRs:

- Resource group `Contributor` is sufficient for the ACR setup path because provisioning enables ACR admin credentials instead of creating Azure RBAC role assignments.

Expected output:

- Azure names and FQDNs saved into state
- generated PostgreSQL admin password and `DATABASE_URL` saved into state
- Key Vault name and URL saved into state

### 3. Bootstrap the database

Run:

```bash
./scripts/New\ Deployment\ Scripts/03-bootstrap-database.sh --state-dir /absolute/path/to/state-dir
```

Applies:

- Azure PostgreSQL extension allow-list updates derived from `db/init/*.sql`
- every file in `db/init/*.sql` in lexical order
- no `db/migrations/*.sql` files

Reason:

- client bootstrap is init-only because `db/init` is kept current with the latest schema changes

Expected output:

- database bootstrap timestamp recorded in state
- bootstrap mode recorded as `init-only`

### 4. Complete manual Entra setup

Run:

```bash
./scripts/New\ Deployment\ Scripts/04-manual-entra-checkpoint.sh --state-dir /absolute/path/to/state-dir
```

Manual portal tasks:

1. Create or reuse one Entra app registration for the client.
2. Add the redirect URI `https://<web-fqdn>/api/auth/callback/azure-ad`.
3. Add the redirect URI `https://<web-fqdn>/api/auth/admin-consent/callback`.
4. Configure the `groups` claim for ID tokens.
5. Add the Graph application permissions listed in [README.md](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/README.md).
6. Grant admin consent.
7. Create a client secret.
8. Collect:
   - tenant ID
   - client ID
   - client secret
   - admin group object ID
   - user group object ID

Expected output:

- confirmation recorded in state

### 5. Capture runtime configuration

Run:

```bash
./scripts/New\ Deployment\ Scripts/05-capture-runtime-config.sh --state-dir /absolute/path/to/state-dir
```

Prompts for:

- Entra values collected in step 4
- group IDs
- `NEXTAUTH_URL`
- worker API and heartbeat URLs
- Application Insights values if auto-creation did not populate them
- local license public/private key paths
- optional runtime tuning overrides

Generated automatically unless you override them:

- `WORKER_INTERNAL_API_TOKEN`
- `WORKER_HEARTBEAT_TOKEN`

Expected output:

- complete runtime env snapshot written to the state directory
- deploy phases write runtime values to Key Vault using names like `DATABASE-URL` for `DATABASE_URL`

### 6. Build and push the web image

Run:

```bash
./scripts/New\ Deployment\ Scripts/06-build-push-web.sh --state-dir /absolute/path/to/state-dir
```

Behavior:

- runs web tests
- builds the Next.js app
- packages the runtime using `scripts/ci/package-web-runtime.sh`
- pushes `sentinel-web:<short-git-sha>` to the configured ACR
- uses `az acr build`

Expected output:

- expected web image recorded in state

### 7. Deploy the web app

Run:

```bash
./scripts/New\ Deployment\ Scripts/07-deploy-web.sh --state-dir /absolute/path/to/state-dir
```

Behavior:

- reuses the staging config sync logic
- writes runtime config values to Key Vault before syncing the web Container App
- the web app generates a fresh boot-scoped auth secret on every startup, invalidating prior sessions after restart or redeploy
- mounts the local license public key into the web Container App as a secret volume
- updates ingress to the real web port `3000`
- points the web Container App at the newly built ACR image
- records latest and ready revisions

Expected output:

- updated web revision metadata in state

### 8. Build and push the worker image

Run:

```bash
./scripts/New\ Deployment\ Scripts/08-build-push-worker.sh --state-dir /absolute/path/to/state-dir
```

Behavior:

- installs worker dependencies
- runs worker tests
- packages the worker runtime using `scripts/ci/package-worker-runtime.sh`
- pushes `sentinel-worker:<short-git-sha>` to the configured ACR
- uses `az acr build`

Expected output:

- expected worker image recorded in state

### 9. Deploy the worker app

Run:

```bash
./scripts/New\ Deployment\ Scripts/09-deploy-worker.sh --state-dir /absolute/path/to/state-dir
```

Behavior:

- reuses the staging worker config sync logic
- writes runtime config values to Key Vault before syncing the worker Container App
- mounts the same public key secret volume for license verification
- updates ingress to the real worker port `5000`
- updates the worker Container App to the newly built image
- records latest and ready revisions

Expected output:

- updated worker revision metadata in state

Manual license generation and installation are no longer part of the numbered deployment suite.

If you need a client license, generate and activate it separately after deployment using the existing license tooling.

### 11. Bootstrap the tenant

Run:

```bash
./scripts/New\ Deployment\ Scripts/11-bootstrap-tenant.sh --state-dir /absolute/path/to/state-dir
```

Prompts for:

- `graph_ingest` cron expression if you want to override the default `0 */6 * * *`

Behavior:

- creates the missing `graph_ingest` schedule if absent
- leaves seeded `mv_refresh` and `copilot_telemetry` schedules alone
- runs smoke checks against:
  - the web app root URL
  - the worker `/health` endpoint using `WORKER_INTERNAL_API_TOKEN`

Expected output:

- smoke-check results saved in state

### 12. Write the deployment report

Run:

```bash
./scripts/New\ Deployment\ Scripts/12-deployment-report.sh --state-dir /absolute/path/to/state-dir
```

Behavior:

- writes the final markdown report
- appends a single row to `.local/deployments/client-deployments-master.csv`

Expected output:

- updated `deployment-summary.md`
- new master CSV row for the deployment

## Resume Instructions

- To continue a known deployment, rerun the desired script with the same `--state-dir`.
- To pick up the latest deployment automatically, use `--resume`.
- To preview commands without mutating Azure or the database, add `--dry-run`.

Example:

```bash
./scripts/New\ Deployment\ Scripts/07-deploy-web.sh --state-dir /absolute/path/to/state-dir --dry-run
```

## Rollback Guidance

If a step fails after Azure resources already exist:

1. Do not start a new deployment directory. Reuse the same `--state-dir`.
2. Fix the cause, then rerun only the failed script.
3. If the issue is a bad image deploy, rebuild and rerun the matching deploy step.
4. If the issue is runtime config, rerun `05-capture-runtime-config.sh` and then the relevant deploy step.
5. If the issue is database bootstrap, fix the SQL or database access and rerun `03-bootstrap-database.sh`.
6. If the issue is license activation, generate and activate the license manually after fixing the underlying problem.

Manual clean-up, if you intentionally abandon a deployment:

- remove the client resource group in Azure
- delete the corresponding state directory under `.local/deployments/`
- remove the appended row from the master CSV if you do not want to retain the abandoned record
