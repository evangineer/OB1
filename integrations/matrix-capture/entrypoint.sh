#!/bin/sh
# G4: take an exclusive kernel lock on the store volume, then exec the bot.
# node inherits fd 9 (and so the lock) across exec; the lock dies with it.
set -eu
dir="${MATRIX_INDEXEDDB_PATH:-/data/indexeddb}"
mkdir -p "$dir"
exec 9>>"$dir/.writer.lock"
flock -n 9 || { echo "refusing to start: G4 another writer holds $dir/.writer.lock" >&2; exit 75; }
exec "$@"
