#!/bin/sh
# Usage: wipe-store.sh <dir> <backup.tgz>
# Back up <dir>, then (only if the backup succeeded) delete everything in it
# except .writer.lock, which must keep its inode. Run it while holding the lock.
# Refuses (nothing archived or deleted) if the backup path is inside <dir>.
# POSIX sh; also runs under BusyBox sh.
set -eu
dir="$1"
backup="$2"

absdir=$(cd "$dir" && pwd -P)
bdir=$(cd "$(dirname "$backup")" && pwd -P) || {
  echo "wipe-store: backup directory for $backup does not exist" >&2
  exit 1
}
absbackup="${bdir%/}/$(basename "$backup")"
case "$absbackup/" in
  "${absdir%/}"/*)
    echo "wipe-store: backup path $absbackup is inside $absdir; refusing to wipe" >&2
    exit 1
    ;;
esac

tar -czf "$backup" -C "$dir" .
find "$dir" -mindepth 1 -maxdepth 1 ! -name .writer.lock -exec rm -rf {} +
