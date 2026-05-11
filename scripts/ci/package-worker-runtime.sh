#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
python_bin="${PYTHON_BIN:-python3}"
python_version="$("${python_bin}" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"

if [[ "${python_version}" != "3.11" ]]; then
  echo "Worker packaging requires Python 3.11; got ${python_version} from ${python_bin}" >&2
  exit 1
fi

runtime_dir="${repo_root}/.dist/worker-runtime"
app_dir="${runtime_dir}/app"
requirements_file="${runtime_dir}/requirements.txt"
manifest_file="${repo_root}/runtime-env-manifest.json"
validation_dir="$(mktemp -d)"
validation_vendor_dir="${validation_dir}/python"

cleanup() {
  rm -rf "${validation_dir}"
}
trap cleanup EXIT

rm -rf "${runtime_dir}"
mkdir -p "${app_dir}" "${validation_vendor_dir}"

cp "${repo_root}/worker/requirements.txt" "${requirements_file}"
"${python_bin}" -m pip install --no-compile --target "${validation_vendor_dir}" -r "${repo_root}/worker/requirements.txt"
cp -R "${repo_root}/worker/app/." "${app_dir}/"
cp "${manifest_file}" "${app_dir}/runtime-env-manifest.json"

"${python_bin}" -m compileall -b "${app_dir}"
find "${app_dir}" -type f -name '*.py' -delete
find "${app_dir}" -type d -name '__pycache__' -prune -exec rm -rf {} +

cat > "${runtime_dir}/Dockerfile" <<'EOF'
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY requirements.txt ./
RUN pip install --no-cache-dir --no-compile -r requirements.txt

COPY app ./app

EXPOSE 5000

CMD ["python", "-m", "gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "4", "app.main:app"]
EOF

if find "${app_dir}" -type f -name '*.py' | grep -q .; then
  echo "Packaged worker runtime still contains .py source files" >&2
  exit 1
fi

if [[ ! -f "${app_dir}/main.pyc" ]]; then
  echo "Packaged worker runtime is missing app/main.pyc" >&2
  exit 1
fi

if [[ ! -f "${app_dir}/key_vault_env.pyc" ]]; then
  echo "Packaged worker runtime is missing app/key_vault_env.pyc" >&2
  exit 1
fi

if [[ ! -f "${app_dir}/runtime-env-manifest.json" ]]; then
  echo "Packaged worker runtime is missing app/runtime-env-manifest.json" >&2
  exit 1
fi

if [[ ! -f "${requirements_file}" ]]; then
  echo "Packaged worker runtime is missing requirements.txt" >&2
  exit 1
fi

WORKER_ENABLE_BACKGROUND_THREADS=false \
AZ_KEY_VAULT_URL="" \
PYTHONPATH="${validation_vendor_dir}:${runtime_dir}" \
"${python_bin}" -c 'from app.main import app; print(app.name)'

WORKER_ENABLE_BACKGROUND_THREADS=false \
AZ_KEY_VAULT_URL="" \
PYTHONPATH="${validation_vendor_dir}:${runtime_dir}" \
"${python_bin}" -m gunicorn \
  --check-config \
  --bind 0.0.0.0:5000 \
  --workers 1 \
  --threads 4 \
  app.main:app

echo "Packaged worker runtime at ${runtime_dir}"
