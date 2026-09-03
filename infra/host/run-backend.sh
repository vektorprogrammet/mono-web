#!/usr/bin/env bash
# Start the native backend (apps/backend) for the apex preview.
# Runs INSIDE the infra/host dev-shell; bootstrap.sh must have run once.
set -euo pipefail
unset BETTER_AUTH_URL BETTER_AUTH_TRUSTED_ORIGINS

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${VEKTOR_PREVIEW_STATE_DIR:-$HOME/.local/state/vektor-preview}"
CONFIG_DIR="${VEKTOR_PREVIEW_CONFIG_DIR:-$HOME/.config/vektor-preview}"
SECRET_FILE="$CONFIG_DIR/better-auth-secret"
PG_PORT="${VEKTOR_PREVIEW_PG_PORT:-5434}"

[[ -s "$SECRET_FILE" ]] || { echo "missing $SECRET_FILE — run bootstrap.sh first" >&2; exit 1; }
export BETTER_AUTH_SECRET="$(cat "$SECRET_FILE")"

export BACKEND_HOST="127.0.0.1"
export BACKEND_PORT="${BACKEND_PORT:-8790}"
export BACKEND_PG_URL="postgresql://postgres@127.0.0.1:$PG_PORT/vektor_preview"
# Native identity policy for the browser-facing apex preview.
export NATIVE_IDENTITY_DEPLOYMENT=preview
export NATIVE_IDENTITY_TRUSTED_ORIGINS='["https://vektor.phibkro.org"]'
export OAUTH_CANONICAL_ORIGIN=https://vektor.phibkro.org
export OAUTH_DASHBOARD_ORIGIN=https://vektor.phibkro.org
export OAUTH_NATIVE_API_RESOURCE=urn:vektorprogrammet:native-api
export PUBLIC_APPLICATION_EFFECT_MODE=disabled
export ADMISSION_AUTH_TOKENS='{}'
export RECEIPT_AUTH_TOKENS='{}'
export ORGANIZATION_AUTH_TOKENS='{}'

cd "$REPO_ROOT/apps/backend"

exec bun run src/main.ts
