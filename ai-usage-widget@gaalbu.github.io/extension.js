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
    scale: 1,
    minScale: 0.65,
    maxScale: 1.75,
    scaleStep: 0.1,
    theme: 'dark',
};

const DEFAULT_STATE = {
    minimized: false,
};

const THEME_ORDER = ['dark', 'light', 'glass'];
const THEME_LABELS = new Map([
    ['dark', 'Dark'],
    ['light', 'Light'],
    ['glass', 'Glass'],
]);
const THEME_ALIASES = new Map([
    ['dark', 'dark'],
    ['light', 'light'],
    ['glass', 'glass'],
    ['transparent', 'glass'],
]);

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, Number(value) || 0));
}

function box(vertical = false, styleClass = '') {
    return new St.BoxLayout({vertical, style_class: styleClass});
}

function label(text, styleClass = '') {
    return new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
}

function iconButton(iconName, styleClass, accessibleName) {
    const button = new St.Button({
        style_class: styleClass,
        can_focus: false,
        reactive: true,
        track_hover: true,
        accessible_name: accessibleName,
    });
    button.set_child(new St.Icon({icon_name: iconName, style_class: 'ai-usage-icon'}));
    return button;
}

export default class AiUsageWidgetExtension extends Extension {
    enable() {
        this._config = this._readConfig();
        this._layoutStatePath = GLib.build_filenamev([
            GLib.get_user_config_dir(), 'ai-usage-widget', 'layout.json',
        ]);
        this._uiStatePath = GLib.build_filenamev([
            GLib.get_user_config_dir(), 'ai-usage-widget', 'state.json',
        ]);
        this._layoutState = this._readLayoutState();
        this._state = this._readState();
        this._menuOpen = false;
        this._buildUi();

        // Registered as Shell chrome (not the click-through background layer)
        // so the minimize button and drag handle receive real pointer input.
        Main.layoutManager.addChrome(this._card, {
            affectsInputRegion: true,
            trackFullscreen: true,
        });
        this._monitorSignal = Main.layoutManager.connect('monitors-changed',
            () => this._placeWidget());
        this._outsideClickSignal = global.stage.connect('button-press-event',
            (_actor, event) => this._onStageButtonPress(event));
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
        if (this._outsideClickSignal) {
            global.stage.disconnect(this._outsideClickSignal);
            this._outsideClickSignal = null;
        }
        this._endDrag();
        if (this._stateSaveTimer) {
            GLib.source_remove(this._stateSaveTimer);
            this._stateSaveTimer = null;
            this._writeLayoutState();
        }
        if (this._process)
            this._process.force_exit();
        this._process = null;
        if (this._card) {
            Main.layoutManager.removeChrome(this._card);
            this._card.destroy();
        }
        this._card = null;
        this._menu = null;
    }

    _readConfig() {
        try {
            const [ok, bytes] = GLib.file_get_contents(`${this.path}/config.json`);
            if (ok) {
                const config = {
                    ...DEFAULT_CONFIG,
                    ...JSON.parse(new TextDecoder().decode(bytes)),
                };
                const requestedTheme = typeof config.theme === 'string'
                    ? config.theme.trim().toLowerCase() : '';
                config.theme = THEME_ALIASES.get(requestedTheme) ?? DEFAULT_CONFIG.theme;
                return config;
            }
        } catch (error) {
            console.warn(`[AI Usage Widget] Invalid config.json: ${error.message}`);
        }
        return {...DEFAULT_CONFIG};
    }

    _readState() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._uiStatePath);
            if (ok) {
                const state = JSON.parse(new TextDecoder().decode(bytes));
                return {
                    ...DEFAULT_STATE,
                    minimized: state.minimized === true,
                    theme: THEME_ALIASES.get(state.theme) ?? this._config.theme,
                };
            }
        } catch (error) {
            if (!error.matches?.(GLib.FileError, GLib.FileError.NOENT))
                console.warn(`[AI Usage Widget] Invalid user state: ${error.message}`);
        }
        return {...DEFAULT_STATE, theme: this._config.theme};
    }

    _writeState() {
        try {
            const directory = GLib.path_get_dirname(this._uiStatePath);
            GLib.mkdir_with_parents(directory, 0o700);
            GLib.chmod(directory, 0o700);
            const contents = `${JSON.stringify(this._state)}\n`;
            GLib.file_set_contents(this._uiStatePath, contents);
            GLib.chmod(this._uiStatePath, 0o600);
        } catch (error) {
            console.warn(`[AI Usage Widget] Could not save user state: ${error.message}`);
        }
    }

    _readLayoutState() {
        const fallback = {version: 1, monitorIndex: -1, xRatio: null, yRatio: null,
            scale: clamp(this._config.scale, this._minimumScale(), this._maximumScale())};
        try {
            const [ok, bytes] = GLib.file_get_contents(this._layoutStatePath);
            if (!ok)
                return fallback;
            const saved = JSON.parse(new TextDecoder().decode(bytes));
            return {
                ...fallback,
                monitorIndex: Number.isInteger(saved.monitorIndex) ? saved.monitorIndex : -1,
                xRatio: Number.isFinite(saved.xRatio) ? clamp(saved.xRatio, 0, 1) : null,
                yRatio: Number.isFinite(saved.yRatio) ? clamp(saved.yRatio, 0, 1) : null,
                scale: Number.isFinite(saved.scale)
                    ? clamp(saved.scale, this._minimumScale(), this._maximumScale())
                    : fallback.scale,
            };
        } catch (error) {
            console.warn(`[AI Usage Widget] Invalid layout state: ${error.message}`);
            return fallback;
        }
    }

    _scheduleStateSave() {
        if (this._stateSaveTimer)
            GLib.source_remove(this._stateSaveTimer);
        this._stateSaveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._stateSaveTimer = null;
            this._writeLayoutState();
            return GLib.SOURCE_REMOVE;
        });
    }

    _writeLayoutState() {
        try {
            const directory = GLib.path_get_dirname(this._layoutStatePath);
            GLib.mkdir_with_parents(directory, 0o700);
            GLib.chmod(directory, 0o700);
            const contents = JSON.stringify({
                version: 1,
                monitorIndex: this._layoutState.monitorIndex,
                xRatio: this._layoutState.xRatio,
                yRatio: this._layoutState.yRatio,
                scale: this._layoutState.scale,
            }, null, 2);
            GLib.file_set_contents(this._layoutStatePath, `${contents}\n`);
            GLib.chmod(this._layoutStatePath, 0o600);
        } catch (error) {
            console.warn(`[AI Usage Widget] Cannot save layout state: ${error.message}`);
        }
    }

    _minimumScale() {
        return clamp(this._config.minScale, 0.35, 1);
    }

    _maximumScale() {
        return clamp(this._config.maxScale, 1, 3);
    }

    _buildUi() {
        this._card = box(true, `ai-usage-card theme-${this._state.theme}`);
        this._card.reactive = true;
        this._card.track_hover = true;
        this._card.can_focus = false;
        this._card.set_pivot_point(0, 0);
        this._card.set_scale(this._layoutState.scale, this._layoutState.scale);
        this._card.connect('notify::width', () => this._placeWidget());
        this._card.connect('notify::height', () => this._placeWidget());
        this._card.connect('scroll-event', (_actor, event) => this._onScroll(event));
        this._card.connect('button-press-event', (_actor, event) => this._onCardButtonPress(event));

        this._expandedView = box(true, 'ai-usage-expanded');

        const header = box(false, 'ai-usage-header');
        header.reactive = true;
        header.track_hover = true;
        header.connect('button-press-event', (_actor, event) => this._onHeaderButtonPress(event));
        const title = label('AI usage', 'ai-usage-title');
        this._updated = label('updating…', 'ai-usage-updated');
        header.add_child(title);
        header.add_child(new St.Widget({x_expand: true}));
        header.add_child(this._updated);
        this._minimizeButton = iconButton('window-minimize-symbolic',
            'ai-usage-window-button', 'Minimize AI usage widget');
        this._minimizeButton.connect('clicked', () => this._setMinimized(true));
        header.add_child(this._minimizeButton);
        this._expandedView.add_child(header);

        this._providers = {
            claude: this._makeProvider('Claude', 'claude'),
            codex: this._makeProvider('Codex', 'codex'),
        };
        this._expandedView.add_child(this._providers.claude.container);
        this._divider = new St.Widget({style_class: 'ai-usage-divider'});
        this._expandedView.add_child(this._providers.codex.container);
        this._expandedView.insert_child_below(this._divider, this._providers.codex.container);
        this._card.add_child(this._expandedView);

        this._restoreButton = iconButton('window-restore-symbolic',
            'ai-usage-restore-button', 'Restore AI usage widget');
        this._restoreButton.connect('clicked', () => this._setMinimized(false));
        this._card.add_child(this._restoreButton);

        this._buildMenu();
        this._syncPresentation();
    }

    _buildMenu() {
        this._menu = box(true, 'ai-usage-menu');
        this._menu.visible = false;
        this._menu.reactive = true;

        const themeRow = box(false, 'ai-usage-menu-row');
        themeRow.add_child(label('Theme', 'ai-usage-menu-label'));
        themeRow.add_child(new St.Widget({x_expand: true}));
        this._themeValue = label(THEME_LABELS.get(this._state.theme), 'ai-usage-menu-value');
        themeRow.add_child(this._themeValue);
        const themeButton = new St.Button({style_class: 'ai-usage-menu-item', can_focus: false});
        themeButton.set_child(themeRow);
        themeButton.connect('clicked', () => this._cycleTheme());
        this._menu.add_child(themeButton);

        const resetButton = new St.Button({style_class: 'ai-usage-menu-item', can_focus: false});
        resetButton.set_child(label('Reset position && size', 'ai-usage-menu-label'));
        resetButton.connect('clicked', () => this._resetLayout());
        this._menu.add_child(resetButton);

        const refreshButton = new St.Button({style_class: 'ai-usage-menu-item', can_focus: false});
        refreshButton.set_child(label('Refresh now', 'ai-usage-menu-label'));
        refreshButton.connect('clicked', () => {
            this._closeMenu();
            this._refresh();
        });
        this._menu.add_child(refreshButton);

        this._card.add_child(this._menu);
    }

    _cycleTheme() {
        const index = THEME_ORDER.indexOf(this._state.theme);
        const next = THEME_ORDER[(index + 1) % THEME_ORDER.length];
        this._state.theme = next;
        this._card.remove_style_class_name(`theme-${THEME_ORDER[index]}`);
        this._card.add_style_class_name(`theme-${next}`);
        this._themeValue.text = THEME_LABELS.get(next);
        this._writeState();
    }

    _resetLayout() {
        this._layoutState.xRatio = null;
        this._layoutState.yRatio = null;
        this._layoutState.scale = clamp(this._config.scale, this._minimumScale(), this._maximumScale());
        this._card.set_scale(this._layoutState.scale, this._layoutState.scale);
        this._placeWidget();
        this._writeLayoutState();
        this._closeMenu();
    }

    _toggleMenu() {
        this._menuOpen = !this._menuOpen;
        this._menu.visible = this._menuOpen;
        if (this._menuOpen)
            this._card.set_child_above_sibling(this._menu, null);
    }

    _closeMenu() {
        if (!this._menuOpen)
            return;
        this._menuOpen = false;
        this._menu.visible = false;
    }

    _makeProvider(name, colorClass) {
        const container = box(true);
        container.visible = false;
        const heading = box(false, 'ai-usage-provider');
        heading.add_child(label(name, 'ai-usage-provider-name'));
        heading.add_child(new St.Widget({x_expand: true}));
        const status = new St.Widget({style_class: `ai-usage-status-dot ${colorClass}`});
        const statusLabel = label('waiting', 'ai-usage-provider-status');
        heading.add_child(status);
        heading.add_child(statusLabel);
        container.add_child(heading);

        const rows = box(true);
        container.add_child(rows);
        return {container, rows, status, statusLabel, colorClass};
    }

    _placeWidget() {
        const monitorIndex = this._validMonitorIndex(this._layoutState.monitorIndex);
        const monitor = (Main.layoutManager.monitors ?? [])[monitorIndex] ??
            Main.layoutManager.primaryMonitor;
        if (!monitor || !this._card)
            return;

        const margin = clamp(this._config.margin, 0, 200);
        const area = this._workArea(monitorIndex, monitor);
        const [width, height] = this._scaledCardSize();
        const travelX = Math.max(0, area.width - width);
        const travelY = Math.max(0, area.height - height);
        let xRatio = this._layoutState.xRatio;
        let yRatio = this._layoutState.yRatio;

        if (xRatio === null)
            xRatio = this._config.position.includes('left')
                ? Math.min(1, margin / Math.max(1, travelX))
                : Math.max(0, 1 - margin / Math.max(1, travelX));
        if (yRatio === null)
            yRatio = this._config.position.includes('bottom')
                ? Math.max(0, 1 - margin / Math.max(1, travelY))
                : Math.min(1, margin / Math.max(1, travelY));

        this._layoutState.monitorIndex = monitorIndex;
        this._layoutState.xRatio = clamp(xRatio, 0, 1);
        this._layoutState.yRatio = clamp(yRatio, 0, 1);
        this._card.set_position(
            Math.round(area.x + travelX * this._layoutState.xRatio),
            Math.round(area.y + travelY * this._layoutState.yRatio)
        );
    }

    _validMonitorIndex(index) {
        const monitors = Main.layoutManager.monitors ?? [];
        if (index >= 0 && index < monitors.length)
            return index;
        const primaryIndex = monitors.indexOf(Main.layoutManager.primaryMonitor);
        return primaryIndex >= 0 ? primaryIndex : 0;
    }

    _workArea(index, monitor) {
        try {
            return Main.layoutManager.getWorkAreaForMonitor(index);
        } catch (_error) {
            return monitor;
        }
    }

    _scaledCardSize() {
        const scale = this._layoutState.scale;
        const fallbackWidth = this._state.minimized ? 42 : 370;
        const fallbackHeight = this._state.minimized ? 42 : 260;
        return [
            Math.max(1, (this._card.width > 0 ? this._card.width : fallbackWidth) * scale),
            Math.max(1, (this._card.height > 0 ? this._card.height : fallbackHeight) * scale),
        ];
    }

    _monitorAt(x, y) {
        const monitors = Main.layoutManager.monitors ?? [];
        const index = monitors.findIndex(monitor =>
            x >= monitor.x && x < monitor.x + monitor.width &&
            y >= monitor.y && y < monitor.y + monitor.height);
        return index >= 0 ? index : this._validMonitorIndex(this._layoutState.monitorIndex);
    }

    _onHeaderButtonPress(event) {
        if (event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;
        this._closeMenu();
        const [x, y] = event.get_coords();
        this._drag = {
            pointerX: x,
            pointerY: y,
            cardX: this._card.x,
            cardY: this._card.y,
            moved: false,
        };
        this._dragMotionId = global.stage.connect('motion-event',
            (_actor, motionEvent) => this._onDragMotion(motionEvent));
        this._dragReleaseId = global.stage.connect('button-release-event',
            () => this._endDrag());
        return Clutter.EVENT_STOP;
    }

    _onDragMotion(event) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const dx = x - this._drag.pointerX;
        const dy = y - this._drag.pointerY;
        if (!this._drag.moved && Math.hypot(dx, dy) < 4)
            return Clutter.EVENT_PROPAGATE;
        this._drag.moved = true;
        this._moveTo(this._drag.cardX + dx, this._drag.cardY + dy, x, y);
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        if (this._dragMotionId) {
            global.stage.disconnect(this._dragMotionId);
            this._dragMotionId = null;
        }
        if (this._dragReleaseId) {
            global.stage.disconnect(this._dragReleaseId);
            this._dragReleaseId = null;
        }
        if (this._drag?.moved)
            this._scheduleStateSave();
        this._drag = null;
    }

    _moveTo(x, y, pointerX, pointerY) {
        const monitorIndex = this._monitorAt(pointerX, pointerY);
        const monitor = (Main.layoutManager.monitors ?? [])[monitorIndex] ??
            Main.layoutManager.primaryMonitor;
        const area = this._workArea(monitorIndex, monitor);
        const [width, height] = this._scaledCardSize();
        const travelX = Math.max(0, area.width - width);
        const travelY = Math.max(0, area.height - height);
        const boundedX = clamp(x, area.x, area.x + travelX);
        const boundedY = clamp(y, area.y, area.y + travelY);
        this._layoutState.monitorIndex = monitorIndex;
        this._layoutState.xRatio = travelX > 0 ? (boundedX - area.x) / travelX : 0;
        this._layoutState.yRatio = travelY > 0 ? (boundedY - area.y) / travelY : 0;
        this._card.set_position(Math.round(boundedX), Math.round(boundedY));
    }

    _onScroll(event) {
        const direction = event.get_scroll_direction();
        let amount = 0;
        if (direction === Clutter.ScrollDirection.UP)
            amount = 1;
        else if (direction === Clutter.ScrollDirection.DOWN)
            amount = -1;
        else if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [, deltaY] = event.get_scroll_delta();
            amount = -Math.sign(deltaY);
        }
        if (amount === 0)
            return Clutter.EVENT_PROPAGATE;
        this._setScale(this._layoutState.scale + amount *
            clamp(this._config.scaleStep, 0.02, 0.5));
        return Clutter.EVENT_STOP;
    }

    _setScale(scale) {
        this._layoutState.scale = clamp(scale, this._minimumScale(), this._maximumScale());
        this._card.set_scale(this._layoutState.scale, this._layoutState.scale);
        this._placeWidget();
        this._scheduleStateSave();
    }

    _onCardButtonPress(event) {
        if (event.get_button() === 3) {
            this._toggleMenu();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onStageButtonPress(event) {
        if (!this._menuOpen || !this._card)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const [menuX, menuY] = this._menu.get_transformed_position();
        const [menuWidth, menuHeight] = this._menu.get_transformed_size();
        const inside = x >= menuX && x <= menuX + menuWidth &&
            y >= menuY && y <= menuY + menuHeight;
        if (!inside)
            this._closeMenu();
        return Clutter.EVENT_PROPAGATE;
    }

    _setMinimized(minimized) {
        if (this._state.minimized === minimized)
            return;
        this._state.minimized = minimized;
        this._writeState();
        this._syncPresentation();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._placeWidget();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncPresentation() {
        const minimized = this._state.minimized;
        this._expandedView.visible = !minimized;
        this._restoreButton.visible = minimized;
        if (minimized) {
            this._closeMenu();
            this._card.add_style_class_name('minimized');
            this._card.visible = true;
        } else {
            this._card.remove_style_class_name('minimized');
            this._card.visible = this._hasVisibleProviders === true;
        }
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
        this._hasVisibleProviders = visibleProviders > 0;
        this._syncPresentation();
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
        const status = provider.status === 'ok'
            ? 'ok' : provider.status === 'stale' ? 'stale' : 'attention';
        view.status.style_class = `ai-usage-status-dot ${view.colorClass} ${status}`;
        view.statusLabel.text = status === 'ok'
            ? 'connected' : status === 'stale' ? 'cached' : 'attention';

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
            provider.status.style_class = `ai-usage-status-dot ${provider.colorClass} attention`;
            provider.statusLabel.text = 'attention';
        }
        this._divider.visible = visibleProviders === 2;
        this._hasVisibleProviders = visibleProviders > 0;
        this._syncPresentation();
        this._placeWidget();
    }
}
