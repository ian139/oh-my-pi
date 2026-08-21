#!/usr/bin/env bash
set -euo pipefail

# Set strict umask
umask 077

CONFIG_PATH="${OMP_FORK_SYNC_CONFIG:-/home/ian/.config/omp-fork-sync/config.json}"
STATE_DIR="${OMP_FORK_SYNC_STATE_DIR:-/home/ian/.local/state/omp-fork-sync}"
STATE_PATH="${STATE_DIR}/state.json"
LOCK_PATH="${STATE_DIR}/sync.lock"
CONTENTION_LOG="${STATE_DIR}/contention.log"
SYNC_BIN="${OMP_FORK_SYNC_BIN:-/home/ian/.local/libexec/omp-fork-sync/sync.ts}"

mkdir -p "${STATE_DIR}"

# Open lockfile on descriptor 9
exec 9>>"${LOCK_PATH}"

# Perform nonblocking lock
if ! flock -n 9; then
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") [LOCK_CONTENTION] Another sync job is currently running." >> "${CONTENTION_LOG}"
  exit 10
fi

# Run sync.ts under timeout (3h15m = 11700s) with 30s kill-after
timeout --signal=TERM --kill-after=30s 11700 bun "${SYNC_BIN}" run --config "${CONFIG_PATH}" --state "${STATE_PATH}" --source cron
