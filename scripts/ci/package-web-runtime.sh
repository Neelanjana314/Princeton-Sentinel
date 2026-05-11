#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

standalone_dir="${repo_root}/web/.next/standalone"
static_dir="${repo_root}/web/.next/static"
public_dir="${repo_root}/web/public"
key_vault_runtime_dir="${repo_root}/web/runtime"
manifest_file="${repo_root}/runtime-env-manifest.json"
runtime_dir="${repo_root}/.dist/web-runtime"
required_public_assets=(
  "pis-logo.png"
  "pits-white-logo.png"
)

if [[ ! -f "${standalone_dir}/server.js" ]]; then
  echo "Missing standalone server output at ${standalone_dir}/server.js" >&2
  exit 1
fi

if [[ ! -d "${static_dir}" ]]; then
  echo "Missing Next static output at ${static_dir}" >&2
  exit 1
fi

if [[ ! -d "${public_dir}" ]]; then
  echo "Missing web public assets directory at ${public_dir}" >&2
  exit 1
fi

if [[ ! -f "${key_vault_runtime_dir}/key-vault-env.cjs" || ! -f "${key_vault_runtime_dir}/key-vault-entrypoint.cjs" ]]; then
  echo "Missing web Key Vault runtime bootstrap files under ${key_vault_runtime_dir}" >&2
  exit 1
fi

if [[ ! -f "${manifest_file}" ]]; then
  echo "Missing runtime env manifest at ${manifest_file}" >&2
  exit 1
fi

for asset in "${required_public_assets[@]}"; do
  if [[ ! -f "${public_dir}/${asset}" ]]; then
    echo "Missing required web public asset at ${public_dir}/${asset}" >&2
    exit 1
  fi
done

rm -rf "${runtime_dir}"
mkdir -p "${runtime_dir}/.next"

cp -R "${standalone_dir}/." "${runtime_dir}/"
cp -R "${static_dir}" "${runtime_dir}/.next/static"
cp "${key_vault_runtime_dir}/key-vault-env.cjs" "${runtime_dir}/key-vault-env.cjs"
cp "${key_vault_runtime_dir}/key-vault-entrypoint.cjs" "${runtime_dir}/key-vault-entrypoint.cjs"
cp "${manifest_file}" "${runtime_dir}/runtime-env-manifest.json"

if [[ -d "${public_dir}" ]]; then
  cp -R "${public_dir}" "${runtime_dir}/public"
fi

cat > "${runtime_dir}/Dockerfile" <<'EOF'
FROM node:24-alpine

WORKDIR /app

ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY . ./

EXPOSE 3000

CMD ["./entrypoint.sh"]
EOF

cat > "${runtime_dir}/entrypoint.sh" <<'EOF'
#!/bin/sh

set -eu

exec node key-vault-entrypoint.cjs
EOF

chmod +x "${runtime_dir}/entrypoint.sh"

if [[ ! -f "${runtime_dir}/server.js" ]]; then
  echo "Packaged web runtime is missing server.js" >&2
  exit 1
fi

if [[ ! -d "${runtime_dir}/.next/static" ]]; then
  echo "Packaged web runtime is missing .next/static" >&2
  exit 1
fi

if [[ ! -d "${runtime_dir}/public" ]]; then
  echo "Packaged web runtime is missing public assets" >&2
  exit 1
fi

if [[ ! -f "${runtime_dir}/key-vault-env.cjs" || ! -f "${runtime_dir}/key-vault-entrypoint.cjs" ]]; then
  echo "Packaged web runtime is missing Key Vault bootstrap files" >&2
  exit 1
fi

if [[ ! -f "${runtime_dir}/runtime-env-manifest.json" ]]; then
  echo "Packaged web runtime is missing runtime env manifest" >&2
  exit 1
fi

if [[ ! -x "${runtime_dir}/entrypoint.sh" ]]; then
  echo "Packaged web runtime is missing executable entrypoint.sh" >&2
  exit 1
fi

for asset in "${required_public_assets[@]}"; do
  if [[ ! -f "${runtime_dir}/public/${asset}" ]]; then
    echo "Packaged web runtime is missing required public asset ${asset}" >&2
    exit 1
  fi
done

for disallowed_dir in app components tests; do
  if [[ -e "${runtime_dir}/${disallowed_dir}" ]]; then
    echo "Packaged web runtime should not include ${disallowed_dir}/" >&2
    exit 1
  fi
done

echo "Packaged web runtime at ${runtime_dir}"
