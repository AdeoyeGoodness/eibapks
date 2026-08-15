#!/usr/bin/env bash
# Copy the initial APKs from the original per-app repos into this site's
# apks/ directory with the filenames the site expects. Run once from the
# repo root before first deploy, then use the /admin uploader thereafter.
#
#   bash deploy/seed-apks.sh /path/to/eibapks   # folder holding cgas/ lock/ vanguard/
set -euo pipefail

SRC="${1:-../eibapks}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/apks"
mkdir -p "$DEST"

copy() {  # copy <src-file> <dest-name>
  if [[ -f "$1" ]]; then cp -v "$1" "$DEST/$2"; else echo "MISSING: $1" >&2; fi
}

copy "$SRC/cgas/CGAS-2.0.apk"   "cgas.apk"
copy "$SRC/lock/bat1203.apk"    "lock.apk"
copy "$SRC/lock/B143.apk"       "lock-legacy.apk"
copy "$SRC/vanguard/vanguard.apk" "vanguard.apk"

echo "Seeded into $DEST"
