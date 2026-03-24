#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/scripts/deploy.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}"
  echo "Copy scripts/deploy.example.env to scripts/deploy.env and fill in your server settings."
  exit 1
fi

# shellcheck disable=SC1090
source "${ENV_FILE}"

: "${DEPLOY_HOST:?DEPLOY_HOST is required}"
: "${DEPLOY_USER:?DEPLOY_USER is required}"
: "${DEPLOY_PATH:?DEPLOY_PATH is required}"

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"

echo "Deploying to ${REMOTE}:${DEPLOY_PATH}"

ssh "${REMOTE}" "bash -lc '
  set -euo pipefail
  cd \"${DEPLOY_PATH}\"
  git pull
  npm install
  npm run build
  pm2 restart ecosystem.config.cjs --update-env
  pm2 save
'"

echo "Deploy completed."
