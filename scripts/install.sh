#!/usr/bin/env bash
set -euo pipefail

readonly UUID='ai-usage-widget@gaalbu.github.io'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly SOURCE_DIR="$PROJECT_DIR/$UUID"
readonly DEST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
readonly BACKUP_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/ai-usage-widget/backups"
readonly EXTENSION_FILES=(metadata.json extension.js stylesheet.css config.json)

enable_extension() {
    if gnome-extensions enable "$UUID" 2>/dev/null; then
        return
    fi

    # GNOME Shell does not discover newly installed extensions until the next
    # login on Wayland. Register the UUID directly so that login loads it
    # without requiring a second command from the user.
    local current next
    current="$(gsettings get org.gnome.shell enabled-extensions)"
    if [[ "$current" == *"'$UUID'"* ]]; then
        return
    fi
    if [[ "$current" == '[]' || "$current" == '@as []' ]]; then
        next="['$UUID']"
    else
        next="${current%]}, '$UUID']"
    fi
    gsettings set org.gnome.shell enabled-extensions "$next"
}

collector_source="${AI_USAGE_COLLECTOR:-}"
if [[ -z "$collector_source" && -x "$SOURCE_DIR/collector" ]]; then
    collector_source="$SOURCE_DIR/collector"
fi
if [[ -z "$collector_source" && -x "$PROJECT_DIR/target/ai-usage-widget" ]]; then
    collector_source="$PROJECT_DIR/target/ai-usage-widget"
fi
if [[ -z "$collector_source" || ! -x "$collector_source" ]]; then
    echo "Native collector not found." >&2
    echo "Use a Linux release archive, run 'make native', or set AI_USAGE_COLLECTOR." >&2
    exit 1
fi

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
cp -a -- "$collector_source" "$DEST_DIR/collector"
chmod 700 "$DEST_DIR/collector"

echo "Installed $UUID with the native Java collector"
enable_extension
if [[ ${XDG_SESSION_TYPE:-} == wayland ]]; then
    echo "Wayland detected: log out and back in once; the widget will start automatically."
else
    echo "The widget is enabled. Restart GNOME Shell if it is not visible yet."
fi
