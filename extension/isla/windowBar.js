// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The window bar (dock-con-ventanas-isla-dock.md, option C, 2026-10-24): what the
// folded island shows while windows are in sight, in place of the dots:
//   [icon of the app in front] Name / window title (+N) | microphone  equalizer  bell
// The orange pill shows while the microphone, camera, location or screen sharing is in use. +N counts the other windows of the workspace that are not minimized; a click
// lists them. The equalizer shows only while music plays (a click pauses it); the
// bell carries a red dot with unread notices and opens their panel. With nothing
// focused (a click on the desktop) the last app in front stays.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {_, fmt} from './i18n.js';
import {dockMonitorIndex} from './monitor.js';
import {TYPES} from './restBar.js';
import {ms} from './timing.js';

const ICON = 30;
const SWAP_TIME = 150;
const BARS = 3;
const BAR_REST = 0.35;
const BEAT = 280;

// A window of the active workspace on the dock's monitor, not minimized. Dialogs count too (IslaDock's own
// Preferences is a modal dialog): the same kinds that hide the desktop bar, so one of the two bars always shows.
function inSight(w) {
    return w && !w.skip_taskbar && !w.minimized && TYPES.includes(w.get_window_type()) &&
        w.located_on_workspace(global.workspace_manager.get_active_workspace()) && w.get_monitor() === dockMonitorIndex();
}

function windowsInSight() {
    return global.display.sort_windows_by_stacking(
        global.get_window_actors().map(a => a.meta_window).filter(inSight)).reverse();
}

export class WindowBar {
    // onChange(): the bar changed size (the island animates to it).
    constructor({state, settings, onChange}) {
        this._state = state;
        this._settings = settings;
        this._onChange = onChange;
        this._signals = [];
        this._windows = new Map();
        this._tracker = Shell.WindowTracker.get_default();
        this._app = null;
        this.actor = new St.BoxLayout({style_class: 'isla-ventanas', y_align: Clutter.ActorAlign.CENTER});
        this._menuManager = new PopupMenu.PopupMenuManager(this.actor);

        // The app in front: its icon and name.
        this._appButton = new St.Button({style_class: 'isla-ventanas-app', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        const appBox = new St.BoxLayout({style_class: 'isla-ventanas-app-caja'});
        this._icon = new St.Bin({style_class: 'isla-ventanas-icono', y_align: Clutter.ActorAlign.CENTER});
        // Variant E (dock-con-ventanas-E.md): the app's name, and under it the title of its window.
        const lines = new St.BoxLayout({style_class: 'isla-ventanas-textos', orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER});
        this._name = new St.Label({style_class: 'isla-ventanas-nombre'});
        this._title = new St.Label({style_class: 'isla-ventanas-titulo', visible: false});
        for (const line of [this._name, this._title]) {
            line.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            lines.add_child(line);
        }
        appBox.add_child(this._icon);
        appBox.add_child(lines);
        this._appButton.set_child(appBox);
        this._appButton.connect('clicked', () => this._openAppWindows());

        this._count = new St.Button({style_class: 'isla-ventanas-cuenta', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        this._count.connect('clicked', () => this._openOthers());

        this._sep = new St.Widget({style_class: 'isla-ventanas-sep', y_align: Clutter.ActorAlign.CENTER});

        // Microphone, camera… in use: GNOME's privacy orange, as in the old pill (privacy.js publishes it).
        this._privacy = new St.BoxLayout({style_class: 'isla-privacidad isla-ventanas-privacidad', y_align: Clutter.ActorAlign.CENTER,
            visible: false});

        // Music: equalizer bars that jump while it plays.
        this._eq = new St.Button({style_class: 'isla-ventanas-eq', can_focus: true, accessible_name: _('Pausa'),
            y_align: Clutter.ActorAlign.CENTER});
        const bars = new St.BoxLayout({style_class: 'isla-onda', y_align: Clutter.ActorAlign.CENTER});
        this._bars = [];
        for (let i = 0; i < BARS; i++) {
            const bar = new St.Widget({style_class: 'isla-onda-barra isla-ventanas-barra', y_align: Clutter.ActorAlign.CENTER});
            bar.set_pivot_point(0.5, 0.5);
            bar.scale_y = BAR_REST;
            bars.add_child(bar);
            this._bars.push(bar);
        }
        this._eq.set_child(bars);
        this._eq.connect('clicked', () => this._state.command('media', 'playpause'));
        this._eq.connect('notify::mapped', () => this._updateWave());

        // The bell with its red dot.
        this._bell = new St.Button({style_class: 'isla-ventanas-campana', can_focus: true, accessible_name: _('Notificaciones'),
            y_align: Clutter.ActorAlign.CENTER});
        // The dot sits on the circle's corner, not over the bell.
        const bellBox = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'isla-ventanas-campana-caja'});
        bellBox.add_child(new St.Icon({icon_name: 'preferences-system-notifications-symbolic', icon_size: 17,
            style_class: 'isla-ventanas-campana-icono', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
        this._dot = new St.Widget({style_class: 'isla-ventanas-punto', x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START});
        bellBox.add_child(this._dot);
        this._bell.set_child(bellBox);
        this._bell.connect('clicked', () => this._state.command('notifications-open'));

        for (const actor of [this._appButton, this._count, this._sep, this._privacy, this._eq, this._bell])
            this.actor.add_child(actor);

        this._on(this._tracker, 'notify::focus-app', () => this._queue());
        this._on(global.display, 'notify::focus-window', () => this._queue());
        this._on(global.display, 'window-created', (_d, w) => {
            this._watch(w);
            this._queue();
        });
        this._on(global.workspace_manager, 'active-workspace-changed', () => this._queue());
        this._on(state, 'music-changed', () => this._updateEnd());
        this._on(state, 'command', (_s, name) => {
            if (name === 'notifications-count')
                this._updateEnd();
            else if (name === 'privacy-changed')
                this._updatePrivacy();
        });
        this._on(settings, 'changed::centro-notificaciones', () => this._updateEnd());
        global.get_window_actors().forEach(a => a.meta_window && this._watch(a.meta_window));
        this._update();
        this._updatePrivacy();
    }

    _on(obj, signal, fn) {
        this._signals.push([obj, obj.connect(signal, fn)]);
    }

    // There is an app to show: the island uses the bar only then.
    get ready() {
        return !!this._app;
    }

    _watch(w) {
        if (this._windows.has(w))
            return;
        const ids = [
            w.connect('notify::minimized', () => this._queue()),
            w.connect('workspace-changed', () => this._queue()),
            w.connect('unmanaged', () => {
                ids.forEach(id => w.disconnect(id));
                this._windows.delete(w);
                this._queue();
            }),
        ];
        this._windows.set(w, ids);
    }

    _queue() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The app in front (or the last one that was, while it has windows in sight) and how many others.
    _update() {
        const windows = windowsInSight();
        const appOf = w => this._tracker.get_window_app(w);
        const focus = this._tracker.focus_app;
        let app = focus && windows.some(w => appOf(w) === focus) ? focus : null;
        if (!app && this._app && windows.some(w => appOf(w) === this._app))
            app = this._app;
        if (!app)
            app = windows.map(appOf).find(Boolean) ?? null;
        // The window whose title shows: the focused one, else the app's topmost.
        const focused = global.display.focus_window;
        this._followWindow(focused && appOf(focused) === app && windows.includes(focused) ? focused
            : windows.find(w => appOf(w) === app) ?? null);
        const others = windows.filter(w => appOf(w) !== app);
        this._others = others;
        const changed = app !== this._app;
        this._app = app;
        if (changed && app) {
            this._icon.set_child(app.create_icon_texture(ICON));
            this._name.text = app.get_name();
            this._appButton.accessible_name = app.get_name();
            if (this.actor.mapped) {
                this._appButton.opacity = 0;
                this._appButton.ease({opacity: 255, duration: ms(SWAP_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
        }
        const label = others.length ? `+${others.length}` : '';
        const countChanged = this._count.label !== label;
        this._count.label = label;
        this._count.accessible_name = fmt(_('{n} ventanas más'), {n: others.length});
        this._count.visible = others.length > 0;
        const titleChanged = this._updateTitle(changed);
        if (changed || countChanged || titleChanged)
            this._onChange();
    }

    // The title is watched only on the window it comes from.
    _followWindow(w) {
        if (w === this._titleWindow)
            return;
        if (this._titleWindow && this._titleId)
            this._titleWindow.disconnect(this._titleId);
        this._titleWindow = w;
        this._titleId = w?.connect('notify::title', () => {
            if (this._updateTitle(false))
                this._onChange();
        }) ?? 0;
    }

    // "Informe.odt — LibreOffice Writer" → "Informe.odt"; nothing when it only repeats the app's name.
    _cleanTitle() {
        const name = this._app?.get_name() ?? '';
        let title = (this._titleWindow?.get_title() ?? '').replace(/\s+/g, ' ').trim();
        const low = s => s.toLocaleLowerCase();
        for (const sep of [' — ', ' – ', ' - ', ' | ']) {
            const at = title.lastIndexOf(sep);
            if (at > 0 && name && low(title.slice(at + sep.length)).includes(low(name.split(' ')[0])))
                title = title.slice(0, at).trim();
        }
        return !title || low(title) === low(name) ? '' : title;
    }

    // Returns whether the text changed; fades it in unless the whole app just did.
    _updateTitle(appChanged) {
        const title = this._cleanTitle();
        if (title === (this._title.visible ? this._title.text : ''))
            return false;
        this._title.text = title;
        this._title.visible = !!title;
        if (!appChanged && this.actor.mapped) {
            this._title.opacity = 0;
            this._title.ease({opacity: 255, duration: ms(SWAP_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        return true;
    }

    _updatePrivacy() {
        const icons = this._state.privacyIcons ?? [];
        this._privacy.destroy_all_children();
        for (const icon of icons)
            this._privacy.add_child(new St.Icon({style_class: 'isla-privacidad-icono', icon_name: icon, y_align: Clutter.ActorAlign.CENTER}));
        this._privacy.visible = icons.length > 0;
        this._privacy.accessible_name = this._state.privacySummary ?? '';
        this._updateEnd();
    }

    // Equalizer while music plays; the bell with the notification center; the line if any shows.
    _updateEnd() {
        const playing = !!this._state.musicPlaying;
        this._eq.visible = playing;
        this._bell.visible = this._settings.get_boolean('centro-notificaciones');
        this._dot.visible = (this._state.notifUnread ?? 0) > 0;
        this._sep.visible = this._eq.visible || this._bell.visible || this._privacy.visible;
        this._updateWave();
        this._onChange();
    }

    // Every beat each bar takes a new height. A timer, not a chain of eases: right after the
    // bar shows up Clutter sets values at once, and a chain ending there would stop for good.
    _updateWave() {
        const on = this._eq.visible && this._eq.mapped && St.Settings.get().enable_animations;
        if (on === !!this._waveId)
            return;
        if (on) {
            this._waveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BEAT, () => {
                for (const bar of this._bars)
                    bar.ease({scale_y: 0.3 + Math.random() * 0.7, duration: BEAT, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD});
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            GLib.source_remove(this._waveId);
            this._waveId = 0;
            this._bars.forEach(bar => {
                bar.remove_transition('scale-y');
                bar.scale_y = BAR_REST;
            });
        }
    }

    // ---------- lists ----------
    _openList(anchor, windows) {
        this._menu?.destroy();
        const menu = this._menu = new PopupMenu.PopupMenu(anchor, 0.5, St.Side.BOTTOM);
        menu.actor.add_style_class_name('isla-menu');
        Main.uiGroup.add_child(menu.actor);
        this._menuManager.addMenu(menu);
        for (const w of windows) {
            const app = this._tracker.get_window_app(w);
            const title = w.get_title() || app?.get_name() || '';
            const item = menu.addAction(title.length > 50 ? `${title.slice(0, 49)}…` : title, () => Main.activateWindow(w));
            const icon = app?.create_icon_texture(16);
            if (icon)
                item.insert_child_at_index(icon, 1);
        }
        menu.open(BoxPointer.PopupAnimation.FULL);
    }

    // The app in front with several windows: they come up to choose.
    _openAppWindows() {
        const mine = windowsInSight().filter(w => this._tracker.get_window_app(w) === this._app);
        if (mine.length > 1)
            this._openList(this._appButton, mine);
        else if (mine.length === 1 && !mine[0].has_focus())
            Main.activateWindow(mine[0]);
    }

    _openOthers() {
        if (this._others?.length)
            this._openList(this._count, this._others);
    }

    destroy() {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        if (this._waveId)
            GLib.source_remove(this._waveId);
        this._waveId = 0;
        this._followWindow(null);
        this._signals.forEach(([obj, id]) => obj.disconnect(id));
        this._signals = [];
        for (const [w, ids] of this._windows)
            ids.forEach(id => w.disconnect(id));
        this._windows.clear();
        this._menu?.destroy();
        this.actor.destroy();
    }
}
