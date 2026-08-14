import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const DEFAULT_CONFIG = {
    refreshSeconds: 300,
    position: 'top-right',
    margin: 28,
};

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, Number(value) || 0));
}

function box(vertical = false, styleClass = '') {
    return new St.BoxLayout({vertical, style_class: styleClass});
}

function label(text, styleClass = '') {
    return new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
}

export default class AiUsageWidgetExtension extends Extension {
    enable() {
        this._config = this._readConfig();
        this._buildUi();

        // The background group sits above the wallpaper and below application
        // windows. Non-reactive actors never steal clicks or keyboard focus.
        Main.layoutManager._backgroundGroup.add_child(this._card);
        this._monitorSignal = Main.layoutManager.connect('monitors-changed',
            () => this._placeWidget());
        this._placeWidget();
        this._refresh();

        const seconds = clamp(this._config.refreshSeconds, 60, 3600);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._monitorSignal) {
            Main.layoutManager.disconnect(this._monitorSignal);
            this._monitorSignal = null;
        }
        if (this._process)
            this._process.force_exit();
        this._process = null;
        this._card?.destroy();
        this._card = null;
    }

    _readConfig() {
        try {
            const [ok, bytes] = GLib.file_get_contents(`${this.path}/config.json`);
            if (ok)
                return {...DEFAULT_CONFIG, ...JSON.parse(new TextDecoder().decode(bytes))};
        } catch (error) {
            console.warn(`[AI Usage Widget] Invalid config.json: ${error.message}`);
        }
        return {...DEFAULT_CONFIG};
    }

    _buildUi() {
        this._card = box(true, 'ai-usage-card');
        this._card.reactive = false;
        this._card.can_focus = false;
        this._card.visible = false;

        const header = box(false, 'ai-usage-header');
        const title = label('AI usage', 'ai-usage-title');
        this._updated = label('updating…', 'ai-usage-updated');
        header.add_child(title);
        header.add_child(new St.Widget({x_expand: true}));
        header.add_child(this._updated);
        this._card.add_child(header);

        this._providers = {
            claude: this._makeProvider('Claude', 'claude'),
            codex: this._makeProvider('Codex', 'codex'),
        };
        this._card.add_child(this._providers.claude.container);
        this._divider = new St.Widget({style_class: 'ai-usage-divider'});
        this._card.add_child(this._divider);
        this._card.add_child(this._providers.codex.container);
    }

    _makeProvider(name, colorClass) {
        const container = box(true);
        container.visible = false;
        const heading = box(false, 'ai-usage-provider');
        heading.add_child(label(name, 'ai-usage-provider-name'));
        heading.add_child(new St.Widget({x_expand: true}));
        const status = label('waiting', 'ai-usage-provider-status');
        heading.add_child(status);
        container.add_child(heading);

        const rows = box(true);
        container.add_child(rows);
        return {container, rows, status, colorClass};
    }

    _placeWidget() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._card)
            return;

        const margin = clamp(this._config.margin, 0, 200);
        const width = this._card.width > 0 ? this._card.width : 370;
        const height = this._card.height > 0 ? this._card.height : 260;
        let x = monitor.x + monitor.width - width - margin;
        let y = monitor.y + Main.panel.height + margin;

        if (this._config.position.includes('left'))
            x = monitor.x + margin;
        if (this._config.position.includes('bottom'))
            y = monitor.y + monitor.height - height - margin;
        this._card.set_position(Math.round(x), Math.round(y));
    }

    _refresh() {
        if (this._process)
            return;
        this._updated.text = 'updating…';

        try {
            this._process = Gio.Subprocess.new(
                [`${this.path}/collector`],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            this._process.communicate_utf8_async(null, null, (process, result) => {
                try {
                    const [, stdout, stderr] = process.communicate_utf8_finish(result);
                    if (!process.get_successful())
                        throw new Error(stderr.trim() || 'collector failed');
                    this._render(JSON.parse(stdout));
                } catch (error) {
                    this._renderFailure(error.message);
                } finally {
                    this._process = null;
                }
            });
        } catch (error) {
            this._process = null;
            this._renderFailure(error.message);
        }
    }

    _render(data) {
        let visibleProviders = 0;
        for (const name of ['claude', 'codex']) {
            const provider = data.providers?.[name] ?? {};
            if (this._renderProvider(this._providers[name], provider))
                visibleProviders++;
        }
        this._divider.visible = visibleProviders === 2;
        this._card.visible = visibleProviders > 0;
        const time = new Date((data.updatedAt ?? Date.now() / 1000) * 1000);
        this._updated.text = time.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
        this._placeWidget();
    }

    _renderProvider(view, provider) {
        view.rows.destroy_all_children();
        const windows = provider.windows ?? [];
        const visible = provider.configured === true || windows.length > 0;
        view.container.visible = visible;
        if (!visible)
            return false;
        view.status.text = provider.status === 'ok'
            ? 'connected'
            : provider.status === 'stale' ? 'cached' : 'attention';

        for (const window of windows)
            view.rows.add_child(this._makeUsageRow(window, view.colorClass));

        if (windows.length === 0) {
            view.rows.add_child(label(provider.message || 'No usage window available',
                'ai-usage-error'));
        }
        return true;
    }

    _makeUsageRow(window, colorClass) {
        const usedPercent = Math.round(clamp(window.usedPercent, 0, 100));
        const container = box(true, 'ai-usage-row');
        const line = box(false);
        line.add_child(label(window.label, 'ai-usage-row-label'));
        line.add_child(new St.Widget({x_expand: true}));
        line.add_child(label(`${usedPercent}%`, 'ai-usage-row-value'));
        container.add_child(line);

        const track = new St.Widget({style_class: 'ai-usage-bar'});
        const fill = new St.Widget({
            style_class: `ai-usage-bar-fill ${colorClass}`,
        });
        track.add_child(fill);
        const updateFillWidth = () => {
            fill.width = Math.round(track.width * usedPercent / 100);
        };
        track.connect('notify::width', updateFillWidth);
        updateFillWidth();
        container.add_child(track);

        if (window.resetLabel)
            container.add_child(label(window.resetLabel, 'ai-usage-provider-status'));
        return container;
    }

    _renderFailure(message) {
        const safeMessage = String(message).slice(0, 120);
        this._updated.text = 'offline';
        let visibleProviders = 0;
        for (const provider of Object.values(this._providers)) {
            if (!provider.container.visible)
                continue;
            visibleProviders++;
            provider.rows.destroy_all_children();
            provider.rows.add_child(label(safeMessage, 'ai-usage-error'));
            provider.status.text = 'attention';
        }
        this._divider.visible = visibleProviders === 2;
        this._card.visible = visibleProviders > 0;
        this._placeWidget();
    }
}
