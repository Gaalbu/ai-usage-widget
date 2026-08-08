#!/usr/bin/env bash
set -euo pipefail

readonly UUID='ai-usage-widget@gaalbu.github.io'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly DEST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

mkdir -p "$(dirname -- "$DEST_DIR")"
if [[ -d "$DEST_DIR" ]]; then
    backup_dir="${DEST_DIR}.backup.$(date +%Y%m%d%H%M%S)"
    mv -- "$DEST_DIR" "$backup_dir"
    echo "Previous installation moved to $backup_dir"
fi
cp -a -- "$PROJECT_DIR/$UUID" "$DEST_DIR"
chmod 700 "$DEST_DIR/collector.py"

echo "Installed $UUID"
if [[ ${XDG_SESSION_TYPE:-} == wayland ]]; then
    echo "Wayland detected: log out and back in once, then run:"
    echo "  gnome-extensions enable $UUID"
else
    gnome-extensions enable "$UUID" || true
    echo "If it is not visible yet, restart GNOME Shell and enable $UUID."
fi
