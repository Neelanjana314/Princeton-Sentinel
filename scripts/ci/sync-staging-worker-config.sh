#!/usr/bin/env bash

set -euo pipefail

vault_host="${AZ_KEY_VAULT_URL#https://}"
vault_name="${vault_host%%.*}"

ensure_key_vault_access() {
  local app_name="$1"
  local principal_id
  principal_id="$(az containerapp show \
    --name "${app_name}" \
    --resource-group "${AZ_RESOURCE_GROUP}" \
    --query "identity.principalId" \
    --output tsv)"

  if [[ -z "${principal_id}" ]]; then
    principal_id="$(az containerapp identity assign \
      --name "${app_name}" \
      --resource-group "${AZ_RESOURCE_GROUP}" \
      --system-assigned \
      --query "principalId" \
      --output tsv)"
  fi

  local vault_id
  vault_id="$(az keyvault show --name "${vault_name}" --query "id" --output tsv)"

  local existing
  existing="$(az role assignment list \
    --scope "${vault_id}" \
    --query "[?principalId=='${principal_id}' && roleDefinitionName=='Key Vault Secrets User'] | length(@)" \
    --output tsv)"

  if [[ "${existing}" == "0" ]]; then
    az role assignment create \
      --assignee-object-id "${principal_id}" \
      --assignee-principal-type ServicePrincipal \
      --role "Key Vault Secrets User" \
      --scope "${vault_id}"
  fi
}

remove_existing_env_vars() {
  local app_name="$1"
  shift

  local existing
  existing="$(az containerapp show \
    --name "${app_name}" \
    --resource-group "${AZ_RESOURCE_GROUP}" \
    --query "properties.template.containers[0].env[].name" \
    --output tsv)"

  local names=()
  local name
  for name in "$@"; do
    if grep -Fxq "${name}" <<< "${existing}"; then
      names+=("${name}")
    fi
  done

  if [[ "${#names[@]}" -gt 0 ]]; then
    az containerapp update \
      --name "${app_name}" \
      --resource-group "${AZ_RESOURCE_GROUP}" \
      --remove-env-vars "${names[@]}"
  fi
}

remove_existing_secrets() {
  local app_name="$1"
  shift

  local existing
  existing="$(az containerapp show \
    --name "${app_name}" \
    --resource-group "${AZ_RESOURCE_GROUP}" \
    --query "properties.configuration.secrets[].name" \
    --output tsv)"

  local names=()
  local name
  for name in "$@"; do
    if grep -Fxq "${name}" <<< "${existing}"; then
      names+=("${name}")
    fi
  done

  if [[ "${#names[@]}" -gt 0 ]]; then
    az containerapp secret remove \
      --name "${app_name}" \
      --resource-group "${AZ_RESOURCE_GROUP}" \
      --secret-names "${names[@]}"
  fi
}

WEB_FQDN="$(az containerapp show \
  --name "${AZ_WEB_APP_NAME}" \
  --resource-group "${AZ_RESOURCE_GROUP}" \
  --query "properties.configuration.ingress.fqdn" \
  --output tsv)"

WORKER_HEARTBEAT_URL="${WORKER_HEARTBEAT_URL:-https://${WEB_FQDN}/api/internal/worker-heartbeat}"

ensure_key_vault_access "${AZ_WORKER_APP_NAME}"

remove_existing_env_vars "${AZ_WORKER_APP_NAME}" \
  APPINSIGHTS_API_KEY \
  APPINSIGHTS_APP_ID \
  ADMIN_GROUP_ID \
  COPILOT_APP_ID \
  DATABASE_URL \
  DB_CONNECT_TIMEOUT_SECONDS \
  DB_WRITE_MAX_RETRIES \
  DB_WRITE_RETRY_BASE_MS \
  DB_WRITE_RETRY_JITTER_MS \
  DB_WRITE_RETRY_MAX_MS \
  ENTRA_CLIENT_ID \
  ENTRA_CLIENT_SECRET \
  ENTRA_TENANT_ID \
  FLUSH_EVERY \
  GRAPH_BASE \
  GRAPH_CONNECT_TIMEOUT \
  GRAPH_MAX_CONCURRENCY \
  GRAPH_MAX_RETRIES \
  GRAPH_PAGE_SIZE \
  GRAPH_PERMISSIONS_BATCH_SIZE \
  GRAPH_PERMISSIONS_STALE_AFTER_HOURS \
  GRAPH_READ_TIMEOUT \
  GRAPH_SYNC_GROUP_MEMBERSHIPS \
  GRAPH_SYNC_GROUP_MEMBERSHIPS_USERS_ONLY \
  GRAPH_SYNC_PULL_PERMISSIONS \
  GRAPH_SYNC_SKIP_STAGES \
  GRAPH_SYNC_STAGES \
  GRAPH_SYNC_TEST_MODE_GROUP_ID \
  INTERNAL_EMAIL_DOMAINS \
  LICENSE_CACHE_TTL_SECONDS \
  LICENSE_PUBLIC_KEY_PATH \
  MV_REFRESH_MAX_VIEWS_PER_RUN \
  RECOVER_INTERRUPTED_RUNS_ON_STARTUP \
  SCHEDULER_POLL_SECONDS \
  USER_GROUP_ID \
  WORKER_API_AUDIENCE \
  WORKER_ENABLE_BACKGROUND_THREADS \
  WORKER_HEARTBEAT_FAIL_THRESHOLD \
  WORKER_HEARTBEAT_INTERVAL_SECONDS \
  WORKER_HEARTBEAT_TIMEOUT_SECONDS \
  WORKER_HEARTBEAT_URL \
  WORKER_HEARTBEAT_TOKEN \
  WORKER_INTERNAL_API_TOKEN

remove_existing_secrets "${AZ_WORKER_APP_NAME}" \
  appinsightsapikey \
  dburl \
  entrasecret \
  workerinternaltoken \
  workerheartbeattoken

az containerapp update \
  --name "${AZ_WORKER_APP_NAME}" \
  --resource-group "${AZ_RESOURCE_GROUP}" \
  --set-env-vars \
    APP_VERSION="${APP_VERSION}" \
    AZ_KEY_VAULT_URL="${AZ_KEY_VAULT_URL}" \
    WORKER_HEARTBEAT_URL="${WORKER_HEARTBEAT_URL}"
