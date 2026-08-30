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
#   5. seed demo persons and rotate their credentials from an operator-only file
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

# --- synthetic preview credentials ------------------------------------------
CREDENTIAL_FILE="$CONFIG_DIR/preview-credentials.json"
if [[ ! -s "$CREDENTIAL_FILE" ]]; then
  umask 077
  bun -e '
    import { randomBytes } from "node:crypto";
    const password = () => randomBytes(36).toString("base64url");
    console.log(JSON.stringify([
      {
        personId: "apex-preview-administrator",
        email: "admin.apex@example.invalid",
        password: password(),
        role: "admin",
      },
      {
        personId: "apex-preview-member",
        email: "member.apex@example.invalid",
        password: password(),
        role: "member",
      },
    ], null, 2));
  ' >"$CREDENTIAL_FILE"
  chmod 600 "$CREDENTIAL_FILE"
  log "generated synthetic preview credentials at $CREDENTIAL_FILE"
fi
chmod 600 "$CREDENTIAL_FILE"

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

# Persons are seeded through the repo's identity runner. Password values are
# read from the protected credential file and are never embedded in source.
IDENTITY_SEED_PERSONS="$(
  PREVIEW_CREDENTIAL_FILE="$CREDENTIAL_FILE" bun -e '
    const credentials = await Bun.file(process.env.PREVIEW_CREDENTIAL_FILE).json();
    console.log(JSON.stringify(credentials.map((credential) => ({
      personId: credential.personId,
      firstName: credential.role === "admin" ? "Astrid" : "Mons",
      lastName: credential.role === "admin" ? "Apex" : "Medlem",
      email: credential.email,
      password: credential.password,
    }))));
  '
)"


if [[ ! -f "$STATE_DIR/.seeded" ]]; then
  log "applying migrations and seeding demo data (first run)"
  SEED_OUT="$(cd "$REPO_ROOT/packages/database" && \
    IDENTITY_SEED_PG_URL="$DATABASE_URL" \
    BETTER_AUTH_URL="$BETTER_AUTH_URL" \
    IDENTITY_SEED_PERSONS="$IDENTITY_SEED_PERSONS" \
    bun run identity:seed)" || {
    log "identity seed failed"; exit 1;
  }
  # Global-administrator grant so the demo admin passes the unscoped
  # management authority check (same shape as the schools e2e seed).
  "${PSQL[@]}" -d "$DB_NAME" -q <<-'SQL'
  INSERT INTO public.person_contact_profiles (person_id, email, phone, revision)
  VALUES ('apex-preview-administrator', 'admin.apex@example.invalid', '+47 906 10 001', 0)
  ON CONFLICT (person_id) DO UPDATE SET email = EXCLUDED.email;
  INSERT INTO organization_global_administrator_grants (grant_id, person_id, start_at, end_at, revision)
  VALUES ('apex-preview-administrator-grant', 'apex-preview-administrator', '2020-01-01T00:00:00.000Z', NULL, 0)
  ON CONFLICT (grant_id) DO NOTHING;
SQL
  printf '%s\n' "$SEED_OUT" >"$STATE_DIR/identity-seed.json"
  printf '%s\n' "$DATABASE_URL" >"$STATE_DIR/db-url.txt"
  : >"$STATE_DIR/.seeded"
else
  log "database already seeded; skipping (delete $STATE_DIR/.seeded to force)"
fi

CREDENTIAL_DIGEST="$(sha256sum "$CREDENTIAL_FILE")"
CREDENTIAL_DIGEST="${CREDENTIAL_DIGEST%% *}"
CREDENTIAL_MARKER="$CONFIG_DIR/preview-credentials.sha256"
if [[ ! -f "$CREDENTIAL_MARKER" ]] || [[ "$(cat "$CREDENTIAL_MARKER")" != "$CREDENTIAL_DIGEST" ]]; then
  log "rotating synthetic preview credentials and invalidating prior sessions"
  PREVIEW_CREDENTIAL_FILE="$CREDENTIAL_FILE" \
    BACKEND_PG_URL="$DATABASE_URL" \
    BETTER_AUTH_URL="$BETTER_AUTH_URL" \
    bun run "$REPO_ROOT/infra/host/rotate-preview-credentials.ts"
  printf '%s\n' "$CREDENTIAL_DIGEST" >"$CREDENTIAL_MARKER"
  chmod 600 "$CREDENTIAL_MARKER"
fi
