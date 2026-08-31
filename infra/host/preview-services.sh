#!/usr/bin/env bash
# Declarative supervision for the vektor.phibkro.org apex preview services.
#
# Installs and controls systemd user units for PostgreSQL, the native
# backend, and the dedicated cloudflared tunnel, in dependency order:
#   postgres (5434, existing PGDATA) -> backend (8790) -> tunnel
#
# Usage:
#   preview-services.sh install   render + install units, enable at boot
#   preview-services.sh up        start the chain in dependency order
#   preview-services.sh down      stop the chain in reverse order
#   preview-services.sh status    unit states + loopback probes
#   preview-services.sh restart   restart the full chain
#
# Data safety: this script never deletes or reinitializes PGDATA, never
# touches tunnel ingress file contents, DNS, or Cloudflare state. Teardown
# with data deletion remains owned by teardown.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${VEKTOR_PREVIEW_STATE_DIR:-$HOME/.local/state/vektor-preview}"
CONFIG_DIR="${VEKTOR_PREVIEW_CONFIG_DIR:-$HOME/.config/vektor-preview}"
BIN_DIR="$STATE_DIR/bin"
UNIT_DIR="${VEKTOR_PREVIEW_UNIT_DIR:-$HOME/.config/systemd/user}"
PG_PORT="${VEKTOR_PREVIEW_PG_PORT:-5434}"
UNITS=(vektor-preview-postgres.service vektor-preview-backend.service vektor-preview-tunnel.service)

log() { printf '[preview-services] %s\n' "$*" >&2; }

# Pin a resolved store path with an indirect Nix GC root under $BIN_DIR so a
# nix garbage collection cannot remove the binary the units depend on.
# `ln -s` alone would dangle after GC; the indirect root keeps it alive.
pin_store_path() {
  local name="$1" resolved="$2"
  mkdir -p "$BIN_DIR"
  local current
  current="$(readlink -f "$resolved" 2>/dev/null || true)"
  if [[ -z "$current" || ! -e "$current" ]]; then
    log "cannot resolve $name from $resolved" >&2
    return 1
  fi
  # Follow the wrapper chain to the real store path (e.g. profile -> store).
  while [[ -L "$current" ]]; do current="$(readlink -f "$current")"; done
  local root="$BIN_DIR/.gcroot-$name"
  if [[ -e "$root" && "$(readlink -f "$root")" == "$current" ]]; then
    ln -sfn "$current" "$BIN_DIR/$name"
    return 0
  fi
  nix-store --add-root "$root" --indirect -r "$current" >/dev/null \
    || { log "failed to pin $name at $current"; return 1; }
  ln -sfn "$current" "$BIN_DIR/$name"
  log "pinned $name -> $current (GC root at $root)"
}

render_unit() {
  local unit="$1"
  sed -e "s|__STATE_DIR__|$STATE_DIR|g" \
      -e "s|__PG_PORT__|$PG_PORT|g" \
      "$REPO_ROOT/infra/host/units/$unit" > "$UNIT_DIR/$unit"
  log "installed $UNIT_DIR/$unit"
}

ensure_env_file() {
  local env_file="$CONFIG_DIR/backend.env"
  mkdir -p "$CONFIG_DIR"
  if [[ -s "$env_file" ]]; then
    chmod 600 "$env_file"
    log "using existing $env_file"
    return 0
  fi
  local secret_file="$CONFIG_DIR/better-auth-secret"
  [[ -s "$secret_file" ]] || { log "missing $secret_file — run bootstrap.sh first"; return 1; }
  umask 077
  printf 'BETTER_AUTH_SECRET=%s\n' "$(cat "$secret_file")" > "$env_file"
  chmod 600 "$env_file"
  log "generated $env_file from $secret_file (0600)"
}

cmd_install() {
  mkdir -p "$UNIT_DIR"
  # Durable runtime: the backend worktree lives on /srv/share, referenced
  # through a stable symlink in the state dir; the binaries are pinned as
  # indirect Nix GC roots so garbage collection cannot remove them.
  local runtime_dir="$STATE_DIR/runtime"
  mkdir -p "$(dirname "$runtime_dir")"
  ln -sfn "$REPO_ROOT" "$runtime_dir"
  log "runtime symlink: $runtime_dir -> $REPO_ROOT"
  pin_store_path bun "$HOME/.nix-profile/bin/bun" \
    || pin_store_path bun /run/current-system/sw/bin/bun \
    || log "warning: bun not found; backend unit will fail until pinned"
  # cloudflared may not be on PATH; fall back to the existing GC root, which
  # pins the build the preview tunnel currently runs.
  pin_store_path cloudflared "$(command -v cloudflared)" \
    || pin_store_path cloudflared /run/current-system/sw/bin/cloudflared \
    || pin_store_path cloudflared "$BIN_DIR/.gcroot-cloudflared/bin/cloudflared" \
    || log "warning: cloudflared not found; tunnel unit will fail until pinned"
  ensure_env_file
  local unit
  for unit in "${UNITS[@]}"; do
    render_unit "$unit"
  done
  systemctl --user daemon-reload
  local unit
  for unit in "${UNITS[@]}"; do
    systemctl --user enable "$unit"
  done
  # User units must start at boot without an active login session.
  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
    loginctl enable-linger "$USER" && log "enabled linger for $USER"
  fi
  log "install complete — run: preview-services.sh up"
}

start_unit() {
  local unit="$1"
  if systemctl --user is-active --quiet "$unit"; then
    log "$unit already active"
  else
    log "starting $unit"
    systemctl --user start "$unit"
  fi
}

cmd_up() {
  # Dependency order: postgres must accept connections before the backend,
  # and the backend before the tunnel (the tunnel proxies to it).
  start_unit vektor-preview-postgres.service
  # Type=simple start returns before postgres accepts connections; poll.
  for _ in $(seq 1 60); do
    /run/current-system/sw/bin/pg_isready -h 127.0.0.1 -p "$PG_PORT" -t 2 -q && break
    sleep 0.5
  done
  /run/current-system/sw/bin/pg_isready -h 127.0.0.1 -p "$PG_PORT" -t 2 -q \
    || { log "postgres not ready on $PG_PORT"; return 1; }
  start_unit vektor-preview-backend.service
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null http://127.0.0.1:8790/health && break
    sleep 0.5
  done
  curl -fsS -o /dev/null http://127.0.0.1:8790/health \
    || { log "backend health check failed"; systemctl --user status vektor-preview-backend.service --no-pager >&2 || true; return 1; }
  start_unit vektor-preview-tunnel.service
  # Tunnel registration takes a few seconds; wait for apex recovery.
  local apex_ok=0
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null --max-time 10 https://vektor.phibkro.org/api/health; then
      apex_ok=1
      break
    fi
    sleep 1
  done
  [[ "$apex_ok" == 1 ]] || { log "apex did not recover after tunnel start"; return 1; }
  log "preview chain is up"
}

stop_unit() {
  local unit="$1"
  if systemctl --user is-active --quiet "$unit"; then
    log "stopping $unit"
    systemctl --user stop "$unit"
  else
    log "$unit already inactive"
  fi
}

cmd_down() {
  # Reverse order: tunnel first so no new requests hit a stopping backend.
  stop_unit vektor-preview-tunnel.service
  stop_unit vektor-preview-backend.service
  stop_unit vektor-preview-postgres.service
}

cmd_status() {
  local rc=0
  local unit
  for unit in "${UNITS[@]}"; do
    printf '%-36s %s\n' "$unit" "$(systemctl --user is-active "$unit" 2>/dev/null || echo unknown)"
  done
  /run/current-system/sw/bin/pg_isready -h 127.0.0.1 -p "$PG_PORT" -q \
    && log "postgres ready on $PG_PORT" || { log "postgres NOT ready on $PG_PORT"; rc=1; }
  curl -fsS -o /dev/null http://127.0.0.1:8790/health \
    && log "backend health 200" || { log "backend health FAILED"; rc=1; }
  curl -fsS -o /dev/null --max-time 15 https://vektor.phibkro.org/api/health \
    && log "apex health 200" || { log "apex health FAILED"; rc=1; }
  return "$rc"
}

cmd_restart() {
  cmd_down
  cmd_up
}

case "${1:-}" in
  install) cmd_install ;;
  up)      cmd_up ;;
  down)    cmd_down ;;
  status)  cmd_status ;;
  restart) cmd_restart ;;
  *)
    printf 'usage: %s {install|up|down|status|restart}\n' "$0" >&2
    exit 2
    ;;
esac
