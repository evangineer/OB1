#!/bin/sh
# Usage: wipe-store.sh <dir> <backup.tgz>
# Back up <dir>, then (only if the backup succeeded) delete everything in it
# except .writer.lock, which must keep its inode. Run it while holding the lock.
# POSIX sh; also runs under BusyBox sh.
set -eu
dir="$1"
backup="$2"
tar -czf "$backup" -C "$dir" .
find "$dir" -mindepth 1 ! -name .writer.lock -exec rm -rf {} +
