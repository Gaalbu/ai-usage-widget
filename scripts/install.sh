#!/usr/bin/env bash
set -euo pipefail

readonly UUID='ai-usage-widget@gaalbu.github.io'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly SOURCE_DIR="$PROJECT_DIR/$UUID"
readonly DEST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
readonly BACKUP_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/ai-usage-widget/backups"
readonly EXTENSION_FILES=(
    metadata.json
    extension.js
    stylesheet.css
    collector.py
    config.json
)

mkdir -p "$(dirname -- "$DEST_DIR")"
if [[ -d "$DEST_DIR" ]]; then
    mkdir -p "$BACKUP_ROOT"
    chmod 700 "$BACKUP_ROOT"
    backup_dir="$BACKUP_ROOT/${UUID}.$(date +%Y%m%d%H%M%S)"
    mv -- "$DEST_DIR" "$backup_dir"
    echo "Previous installation moved to $backup_dir"
fi
mkdir -p "$DEST_DIR"
chmod 755 "$DEST_DIR"
for file in "${EXTENSION_FILES[@]}"; do
    cp -a -- "$SOURCE_DIR/$file" "$DEST_DIR/$file"
    chmod 644 "$DEST_DIR/$file"
done
chmod 700 "$DEST_DIR/collector.py"

echo "Installed $UUID"
if [[ ${XDG_SESSION_TYPE:-} == wayland ]]; then
    echo "Wayland detected: log out and back in once, then run:"
    echo "  gnome-extensions enable $UUID"
else
    gnome-extensions enable "$UUID" || true
    echo "If it is not visible yet, restart GNOME Shell and enable $UUID."
fi
