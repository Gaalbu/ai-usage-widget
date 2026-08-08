#!/usr/bin/env bash
set -euo pipefail

readonly UUID='ai-usage-widget@gaalbu.github.io'
readonly DEST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

gnome-extensions disable "$UUID" 2>/dev/null || true
if [[ -d "$DEST_DIR" ]]; then
    trash_dir="${XDG_DATA_HOME:-$HOME/.local/share}/Trash/files"
    mkdir -p "$trash_dir"
    mv -- "$DEST_DIR" "$trash_dir/${UUID}.$(date +%Y%m%d%H%M%S)"
    echo "Moved the extension to the user trash."
else
    echo "AI Usage Widget is not installed."
fi
