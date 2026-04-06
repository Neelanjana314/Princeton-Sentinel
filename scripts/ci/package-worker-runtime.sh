#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
python_bin="${PYTHON_BIN:-python3}"

runtime_dir="${repo_root}/.dist/worker-runtime"
vendor_dir="${runtime_dir}/python"
app_dir="${runtime_dir}/app"

rm -rf "${runtime_dir}"
mkdir -p "${vendor_dir}" "${app_dir}"

"${python_bin}" -m pip install --no-compile --target "${vendor_dir}" -r "${repo_root}/worker/requirements.txt"
cp -R "${repo_root}/worker/app/." "${app_dir}/"

"${python_bin}" -m compileall -b "${app_dir}"
find "${app_dir}" -type f -name '*.py' -delete
find "${app_dir}" -type d -name '__pycache__' -prune -exec rm -rf {} +

cat > "${runtime_dir}/Dockerfile" <<'EOF'
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app/python:/app

COPY python ./python
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

WORKER_ENABLE_BACKGROUND_THREADS=false \
PYTHONPATH="${vendor_dir}:${runtime_dir}" \
"${python_bin}" -c 'from app.main import app; print(app.name)'

WORKER_ENABLE_BACKGROUND_THREADS=false \
PYTHONPATH="${vendor_dir}:${runtime_dir}" \
"${python_bin}" -m gunicorn \
  --check-config \
  --bind 0.0.0.0:5000 \
  --workers 1 \
  --threads 4 \
  app.main:app

echo "Packaged worker runtime at ${runtime_dir}"
