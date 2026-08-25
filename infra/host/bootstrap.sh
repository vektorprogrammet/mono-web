#!/usr/bin/env bash
# Idempotent bootstrap for the vektor.phibkro.org apex preview authority.
#
# Run inside the infra/host dev-shell:
#   nix develop /srv/share/projects/vektorprogrammet/infra/host -c bash bootstrap.sh
#
# What it does (safe to re-run):
#   1. initdb into $VEKTOR_PREVIEW_PGDATA if missing
#   2. start postgres on 127.0.0.1:$VEKTOR_PREVIEW_PG_PORT (default 5434)
#   3. create database vektor_preview
#   4. apply all schema migrations through the repo's own runner
#   5. seed demo persons incl. one global-admin account; the admin password is
#      printed ONCE to stderr on first creation only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${VEKTOR_PREVIEW_STATE_DIR:-$HOME/.local/state/vektor-preview}"
CONFIG_DIR="${VEKTOR_PREVIEW_CONFIG_DIR:-$HOME/.config/vektor-preview}"
PGDATA="$STATE_DIR/pgdata"
PG_PORT="${VEKTOR_PREVIEW_PG_PORT:-5434}"
DB_NAME="vektor_preview"
SOCKET_DIR="$STATE_DIR/pgsocket"

mkdir -p "$STATE_DIR" "$CONFIG_DIR" "$SOCKET_DIR"

log() { printf '[apex-preview] %s\n' "$*" >&2; }

# --- secret -----------------------------------------------------------------
SECRET_FILE="$CONFIG_DIR/better-auth-secret"
if [[ ! -s "$SECRET_FILE" ]]; then
  umask 077
  openssl rand -hex 48 >"$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  log "generated new BETTER_AUTH_SECRET at $SECRET_FILE"
fi
chmod 600 "$SECRET_FILE" 2>/dev/null || true

# --- postgres ---------------------------------------------------------------
if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
  log "initializing PostgreSQL cluster at $PGDATA"
  initdb -D "$PGDATA" -A trust -U postgres --no-locale --encoding=UTF8 >/dev/null
fi

if ! pg_isready -h 127.0.0.1 -p "$PG_PORT" -q; then
  log "starting postgres on 127.0.0.1:$PG_PORT"
  postgres -D "$PGDATA" \
    -p "$PG_PORT" -h 127.0.0.1 -k "$SOCKET_DIR" \
    -c listen_addresses=127.0.0.1 \
    >>"$STATE_DIR/postgres.log" 2>&1 &
  PG_PID=$!
  disown "$PG_PID" || true
  for _ in $(seq 1 60); do
    pg_isready -h 127.0.0.1 -p "$PG_PORT" -q && break
    sleep 0.5
  done
  pg_isready -h 127.0.0.1 -p "$PG_PORT" -q || { log "postgres failed to start"; tail -20 "$STATE_DIR/postgres.log" >&2; exit 1; }
fi

PSQL=(psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1)
if ! "${PSQL[@]}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  createdb -h 127.0.0.1 -p "$PG_PORT" -U postgres "$DB_NAME"
  log "created database $DB_NAME"
fi

DATABASE_URL="postgresql://postgres@127.0.0.1:$PG_PORT/$DB_NAME"

# --- migrations + seed via the repo's own runtime ---------------------------
export DATABASE_URL BETTER_AUTH_SECRET="$(cat "$SECRET_FILE")"
BETTER_AUTH_URL="https://vektor.phibkro.org"

DEMO_ADMIN_EMAIL="admin.apex@example.invalid"
DEMO_ADMIN_PASSWORD="apex-preview-admin-pass-2026"

if [[ ! -f "$STATE_DIR/.seeded" ]]; then
  log "applying migrations and seeding demo data (first run)"
  SEED_OUT="$(cd "$REPO_ROOT/packages/database" && bun run identity:seed 2>/dev/null)" || {
    log "identity seed failed"; exit 1;
  }
  printf '%s\n' "$SEED_OUT" >"$STATE_DIR/identity-seed.json"
  printf '%s\n' "$DATABASE_URL" >"$STATE_DIR/db-url.txt"
  : >"$STATE_DIR/.seeded"
  log ""
  log "============================================================"
  log " DEMO ADMIN ACCOUNT (printed once, not stored anywhere)"
  log "   email:    $DEMO_ADMIN_EMAIL"
  log "   password: $DEMO_ADMIN_PASSWORD"
  log "============================================================"
else
  log "database already seeded; skipping (delete $STATE_DIR/.seeded to force)"
fi
