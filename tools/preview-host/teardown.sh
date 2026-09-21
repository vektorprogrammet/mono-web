#!/usr/bin/env bash
# Stop the apex preview PostgreSQL cluster (and optionally wipe its data).
#   teardown.sh           stop postgres, keep data
#   teardown.sh --delete  stop postgres AND delete the data directory
set -euo pipefail

STATE_DIR="${VEKTOR_PREVIEW_STATE_DIR:-$HOME/.local/state/vektor-preview}"
PGDATA="$STATE_DIR/pgdata"
PG_PORT="${VEKTOR_PREVIEW_PG_PORT:-5434}"

if pg_isready -h 127.0.0.1 -p "$PG_PORT" -q; then
  echo "stopping postgres on 127.0.0.1:$PG_PORT" >&2
  # Only ever signal OUR cluster: match the exact datadir.
  pkill -TERM -f "postgres -D $PGDATA( |$)" || true
  for _ in $(seq 1 40); do
    pg_isready -h 127.0.0.1 -p "$PG_PORT" -q || break
    sleep 0.5
  done
else
  echo "no postgres listening on 127.0.0.1:$PG_PORT" >&2
fi

if [[ "${1:-}" == "--delete" ]]; then
  rm -rf "$PGDATA" "$STATE_DIR/.seeded"
  echo "deleted $PGDATA and seed marker" >&2
fi
