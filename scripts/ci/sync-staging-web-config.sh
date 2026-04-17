#!/usr/bin/env bash

set -euo pipefail

WEB_FQDN="$(az containerapp show \
  --name "${AZ_WEB_APP_NAME}" \
  --resource-group "${AZ_RESOURCE_GROUP}" \
  --query "properties.configuration.ingress.fqdn" \
  --output tsv)"

NEXTAUTH_URL="${STG_NEXTAUTH_URL:-https://${WEB_FQDN}}"
WORKER_API_URL="${STG_WORKER_API_URL:-http://${AZ_WORKER_APP_NAME}}"

az containerapp secret set \
  --name "${AZ_WEB_APP_NAME}" \
  --resource-group "${AZ_RESOURCE_GROUP}" \
  --secrets \
    dburl="${STG_DATABASE_URL}" \
    entrasecret="${STG_ENTRA_CLIENT_SECRET}" \
    workerinternaltoken="${STG_WORKER_INTERNAL_API_TOKEN}" \
    workerheartbeattoken="${STG_WORKER_HEARTBEAT_TOKEN}"

az containerapp update \
  --name "${AZ_WEB_APP_NAME}" \
  --resource-group "${AZ_RESOURCE_GROUP}" \
  --set-env-vars \
    APP_VERSION="${APP_VERSION}" \
    DATABASE_URL=secretref:dburl \
    DATAVERSE_BASE_URL="${STG_DATAVERSE_BASE_URL}" \
    POWER_PLATFORM_ENVIRONMENT_ID="${STG_POWER_PLATFORM_ENVIRONMENT_ID}" \
    DATAVERSE_TABLE_URL="${STG_DATAVERSE_TABLE_URL}" \
    DATAVERSE_COLUMN_PREFIX="${STG_DATAVERSE_COLUMN_PREFIX}" \
    DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL="${STG_DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL}" \
    WORKER_API_URL="${WORKER_API_URL}" \
    WORKER_INTERNAL_API_TOKEN=secretref:workerinternaltoken \
    WORKER_HEARTBEAT_TOKEN=secretref:workerheartbeattoken \
    NEXTAUTH_URL="${NEXTAUTH_URL}" \
    ENTRA_TENANT_ID="${STG_ENTRA_TENANT_ID}" \
    ENTRA_CLIENT_ID="${STG_ENTRA_CLIENT_ID}" \
    ENTRA_CLIENT_SECRET=secretref:entrasecret \
    ADMIN_GROUP_ID="${STG_ADMIN_GROUP_ID}" \
    USER_GROUP_ID="${STG_USER_GROUP_ID}" \
    INTERNAL_EMAIL_DOMAINS="${STG_INTERNAL_EMAIL_DOMAINS}" \
    DASHBOARD_DORMANT_LOOKBACK_DAYS="${STG_DASHBOARD_DORMANT_LOOKBACK_DAYS}" \
    LICENSE_PUBLIC_KEY_PATH="${STG_LICENSE_PUBLIC_KEY_PATH}" \
    LICENSE_CACHE_TTL_SECONDS="${STG_LICENSE_CACHE_TTL_SECONDS}"
