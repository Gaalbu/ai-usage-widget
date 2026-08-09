# AI Usage Widget

A quiet, click-through desktop widget that shows the current Claude Code and
Codex usage windows on Ubuntu GNOME.

It is built as a GNOME Shell extension, so it stays on the wallpaper layer on
Wayland: no taskbar icon, no focus stealing, and no always-on-top window.

![Ubuntu](https://img.shields.io/badge/Ubuntu-24.04%20LTS-E95420?logo=ubuntu&logoColor=white)
![GNOME](https://img.shields.io/badge/GNOME-45--48-4A86CF?logo=gnome&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

## What it shows

- Claude's 5-hour and 7-day utilization, plus reset times when available.
- Every limit window returned by the official Codex app-server.
- Independent connection state, so one provider can keep working if the other
  is unavailable.

The widget refreshes every five minutes by default. It never prints, stores, or
sends your tokens anywhere except to the provider that issued them. A sanitized
usage-only fallback cache is kept for up to 30 minutes so temporary rate limits
do not blank the widget.

## Requirements

- Ubuntu 24.04 LTS or another GNOME 45–48 distribution.
- Python 3 (already installed by Ubuntu).
- Claude Code logged in with OAuth: `claude auth login`.
- Codex CLI logged in with ChatGPT: `codex login`.

API-key Claude accounts do not have a subscription utilization bar; use
Claude Code's `/cost` command for per-session API spend instead.

## Install

```bash
git clone https://github.com/Gaalbu/ai-usage-widget.git
cd ai-usage-widget
./scripts/install.sh
```

On Wayland, log out and back in once after the first installation, then run:

```bash
gnome-extensions enable ai-usage-widget@gaalbu.github.io
```

To remove it:

```bash
make uninstall
```

The uninstaller moves the extension to your user trash instead of deleting it
permanently.

## Configure

Edit `config.json` in the installed extension directory:

```text
~/.local/share/gnome-shell/extensions/ai-usage-widget@gaalbu.github.io/config.json
```

Available values:

```json
{
  "refreshSeconds": 300,
  "position": "top-right",
  "margin": 28
}
```

`position` accepts `top-right`, `top-left`, `bottom-right`, or `bottom-left`.
Disable and re-enable the extension after changing the file.

## Privacy and data sources

Codex is queried through its documented local `codex app-server` JSON-RPC
method, `account/rateLimits/read`. The widget never opens Codex's auth file.

Claude Code currently exposes `/usage` interactively but does not document a
non-interactive equivalent. The collector therefore reads the OAuth access
token from Claude Code's local credentials and calls the same read-only usage
endpoint used by Claude Code. That endpoint is not a public Anthropic API and
may change. Requests are deliberately limited to once every five minutes.
Tokens are kept in memory, never included in logs, and never written by this
project.

## Development

Run parser tests and a live collector check:

```bash
python3 -m unittest discover -s tests -v
python3 ai-usage-widget@gaalbu.github.io/collector.py --pretty
```

Package the extension:

```bash
make package
```

## Troubleshooting

- `Claude login expired`: open Claude Code once or run `claude auth login`.
- `Codex CLI not found`: ensure `codex` is on `PATH`, or set `CODEX_BIN`.
- Widget missing on first install under Wayland: log out and back in. GNOME
  Shell cannot be restarted in place in a Wayland session.
- Extension errors: inspect `journalctl --user -f -o cat /usr/bin/gnome-shell`.

## License

MIT
