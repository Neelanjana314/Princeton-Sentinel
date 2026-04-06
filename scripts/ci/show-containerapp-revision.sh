#!/usr/bin/env bash

set -euo pipefail

app_name="${1:-}"
expected_image="${2:-}"
poll_timeout_seconds="${POLL_TIMEOUT_SECONDS:-300}"
poll_interval_seconds="${POLL_INTERVAL_SECONDS:-10}"

if [[ -z "${app_name}" ]]; then
  echo "Usage: show-containerapp-revision.sh <app_name> [expected_image]" >&2
  exit 1
fi

fetch_app_state() {
  az containerapp show \
    --name "${app_name}" \
    --resource-group "${AZ_RESOURCE_GROUP}" \
    --query "[name, properties.latestRevisionName, properties.latestReadyRevisionName, properties.template.containers[0].image, properties.configuration.ingress.fqdn]" \
    --output tsv
}

app_state="$(fetch_app_state)"
IFS=$'\t' read -r resolved_app_name latest_revision ready_revision image fqdn <<< "${app_state}"

image_matches_expected=false
if [[ -n "${expected_image}" && "${image}" == "${expected_image}" ]]; then
  image_matches_expected=true
fi

deadline=$((SECONDS + poll_timeout_seconds))
while [[ "${latest_revision}" != "${ready_revision}" || ("${expected_image}" != "" && "${image_matches_expected}" != "true") ]]; do
  if (( SECONDS >= deadline )); then
    break
  fi

  sleep "${poll_interval_seconds}"
  app_state="$(fetch_app_state)"
  IFS=$'\t' read -r resolved_app_name latest_revision ready_revision image fqdn <<< "${app_state}"

  image_matches_expected=false
  if [[ -n "${expected_image}" && "${image}" == "${expected_image}" ]]; then
    image_matches_expected=true
  fi
done

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "app_name=${resolved_app_name}"
    echo "latest_revision=${latest_revision}"
    echo "ready_revision=${ready_revision}"
    echo "image=${image}"
    echo "expected_image=${expected_image}"
    echo "fqdn=${fqdn}"
    echo "image_matches_expected=${image_matches_expected}"
  } >> "${GITHUB_OUTPUT}"
fi

az containerapp show \
  --name "${app_name}" \
  --resource-group "${AZ_RESOURCE_GROUP}" \
  --query "{app:name,latestRevision:properties.latestRevisionName,readyRevision:properties.latestReadyRevisionName,image:properties.template.containers[0].image,ingressFqdn:properties.configuration.ingress.fqdn}" \
  --output table

if [[ "${latest_revision}" != "${ready_revision}" ]]; then
  echo "Timed out waiting for ${app_name} latest revision ${latest_revision:-<none>} to become ready; ready revision is ${ready_revision:-<none>}." >&2
  exit 1
fi

if [[ -n "${expected_image}" && "${image_matches_expected}" != "true" ]]; then
  echo "Timed out waiting for ${app_name} to report expected image ${expected_image}; current image is ${image:-<none>}." >&2
  exit 1
fi
