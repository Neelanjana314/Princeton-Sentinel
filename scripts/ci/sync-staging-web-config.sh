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

NEXTAUTH_URL="${NEXTAUTH_URL:-https://${WEB_FQDN}}"
WORKER_API_URL="${WORKER_API_URL:-http://${AZ_WORKER_APP_NAME}}"

ensure_key_vault_access "${AZ_WEB_APP_NAME}"

remove_existing_env_vars "${AZ_WEB_APP_NAME}" \
  ADMIN_GROUP_ID \
  DASHBOARD_DORMANT_LOOKBACK_DAYS \
  DATABASE_URL \
  DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL \
  DATAVERSE_BASE_URL \
  DATAVERSE_COLUMN_PREFIX \
  DATAVERSE_TABLE_URL \
  ENTRA_CLIENT_ID \
  ENTRA_CLIENT_SECRET \
  ENTRA_TENANT_ID \
  INTERNAL_EMAIL_DOMAINS \
  LICENSE_CACHE_TTL_SECONDS \
  LICENSE_PUBLIC_KEY_PATH \
  POWER_PLATFORM_ENVIRONMENT_ID \
  USER_GROUP_ID \
  WORKER_HEARTBEAT_TOKEN \
  WORKER_INTERNAL_API_TOKEN

remove_existing_secrets "${AZ_WEB_APP_NAME}" \
  dburl \
  entrasecret \
  workerinternaltoken \
  workerheartbeattoken

az containerapp update \
  --name "${AZ_WEB_APP_NAME}" \
  --resource-group "${AZ_RESOURCE_GROUP}" \
  --set-env-vars \
    APP_VERSION="${APP_VERSION}" \
    AZ_KEY_VAULT_URL="${AZ_KEY_VAULT_URL}" \
    WORKER_API_URL="${WORKER_API_URL}" \
    NEXTAUTH_URL="${NEXTAUTH_URL}"
