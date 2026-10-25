// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The desktop bar (dock-minimizado-isla-dock.md, 2026-10-24): what the folded
// island becomes while no window is in sight (all minimized, or none open):
//   [Papelera] | [ music or date and time | minimized apps ] | [Notificaciones Portapapeles Ajustes]
// The left part of the middle piece plays the song (title and previous / pause /
// next) while a player plays, and goes back to the date and time 3 s after it
// stops; a click on the time opens IslaDock's calendar. The right part has one
// icon per minimized window (5 at most, then "+N" with the rest in a menu); a
// click brings it back. The buttons at the ends are copies of the dock's (they
// count and look alike); a click opens the real one over the open dock.
// Hovering leaves it as it is (it is meant to be used); the wheel over it opens
// the whole dock (isla.js).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {_, fmt} from './i18n.js';
import {dayName, monthName, monthShort} from './dates.js';
import {dockMonitorIndex} from './monitor.js';
import {ms} from './timing.js';

const TILE = 36;
const APP_ICON = 26;
const MAX_MINIMIZED = 5;
const STOP_GRACE = 3000;     // paused for this long: back to the clock
const SWAP_TIME = 220;
// What a person would call "a window" (the window bar counts the same ones).
export const TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY];

const KEYS = {trash: 'mostrar-papelera', notifications: 'centro-notificaciones', clipboard: 'mostrar-portapapeles',
    power: 'mostrar-energia'};

// A window of the active workspace on the dock's monitor that a person would call "a window".
function counts(w) {
    return w && !w.skip_taskbar && TYPES.includes(w.get_window_type()) &&
        w.located_on_workspace(global.workspace_manager.get_active_workspace()) && w.get_monitor() === dockMonitorIndex();
}

// No window in sight: every one minimized, or none at all.
export function desktopShown() {
    return !global.get_window_actors().some(a => {
        const w = a.meta_window;
        return counts(w) && !w.minimized && w.showing_on_its_workspace();
    });
}

export class RestBar {
    // onChange(): the bar changed size (the island animates to it).
    constructor({state, settings, apps, onChange}) {
        this._state = state;
        this._settings = settings;
        this._apps = apps;
        this._onChange = onChange;
        this._signals = [];
        this._windows = new Map();
        this.actor = new St.BoxLayout({style_class: 'isla-barra', y_align: Clutter.ActorAlign.CENTER});

        this._mirrors = {};
        for (const kind of ['trash', 'notifications', 'clipboard', 'power'])
            this._mirrors[kind] = apps.mirror(kind, TILE);
        this._sepStart = this._sep('isla-barra-sep');
        this._sepEnd = this._sep('isla-barra-sep');

        // The middle piece: music or clock | minimized apps.
        this._piece = new St.BoxLayout({style_class: 'isla-barra-pieza', y_align: Clutter.ActorAlign.CENTER});
        this._left = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        this._clock = this._buildClock();
        this._music = this._buildMusic();
        this._left.add_child(this._clock);
        this._left.add_child(this._music);
        this._innerSep = this._sep('isla-barra-sep-interno');
        this._minimized = new St.BoxLayout({style_class: 'isla-barra-minimizadas', y_align: Clutter.ActorAlign.CENTER});
        for (const actor of [this._left, this._innerSep, this._minimized])
            this._piece.add_child(actor);

        for (const actor of [this._mirrors.trash, this._sepStart, this._piece, this._sepEnd,
            this._mirrors.notifications, this._mirrors.clipboard, this._mirrors.power])
            this.actor.add_child(actor);

        this._tip = new St.Label({style_class: 'isla-tooltip', visible: false});
        Main.layoutManager.uiGroup.add_child(this._tip);
        this._menuManager = new PopupMenu.PopupMenuManager(this.actor);

        this._on(state, 'music-info', () => this._updateMusic());
        this._on(state, 'music-changed', () => this._updateMusic());
        for (const key of Object.values(KEYS))
            this._on(settings, `changed::${key}`, () => this._updateEnds());
        this._on(global.display, 'window-created', (_d, w) => {
            this._watch(w);
            this._queueMinimized();
        });
        this._on(global.workspace_manager, 'active-workspace-changed', () => this._queueMinimized());
        global.get_window_actors().forEach(a => a.meta_window && this._watch(a.meta_window));
        this._updateEnds();
        this._showMusic(false, false);
        this._updateMusic();
        this._updateClock();
        this._updateMinimized();
    }

    _on(obj, signal, fn) {
        this._signals.push([obj, obj.connect(signal, fn)]);
    }

    _sep(style) {
        return new St.Widget({style_class: style, y_align: Clutter.ActorAlign.CENTER});
    }

    _updateEnds() {
        for (const [kind, key] of Object.entries(KEYS))
            this._mirrors[kind].visible = this._settings.get_boolean(key);
        this._sepStart.visible = this._mirrors.trash.visible;
        this._sepEnd.visible = ['notifications', 'clipboard', 'power'].some(k => this._mirrors[k].visible);
        this._onChange();
    }

    // ---------- date and time ----------
    _buildClock() {
        const button = new St.Button({style_class: 'isla-barra-reloj', can_focus: true, accessible_name: _('Calendario'),
            y_align: Clutter.ActorAlign.CENTER});
        const box = new St.BoxLayout({style_class: 'isla-barra-reloj-caja'});
        const page = new St.BoxLayout({style_class: 'isla-barra-hoja', orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER});
        this._month = new St.Label({style_class: 'isla-barra-hoja-mes', x_align: Clutter.ActorAlign.CENTER});
        this._day = new St.Label({style_class: 'isla-barra-hoja-dia', x_align: Clutter.ActorAlign.CENTER});
        page.add_child(this._month);
        page.add_child(this._day);
        this._time = new St.Label({style_class: 'isla-barra-hora', y_align: Clutter.ActorAlign.CENTER});
        this._date = new St.Label({style_class: 'isla-barra-fecha', y_align: Clutter.ActorAlign.CENTER});
        for (const actor of [page, this._time, this._date])
            box.add_child(actor);
        button.set_child(box);
        button.connect('clicked', () => this._state.command('calendar-toggle', button));
        return button;
    }

    // Every minute, on the minute.
    _updateClock() {
        const now = GLib.DateTime.new_now_local();
        this._month.text = monthShort(now).toUpperCase();
        this._day.text = String(now.get_day_of_month());
        this._time.text = now.format('%H:%M');
        this._date.text = fmt(_('{dia}, {n} de {mes}'), {dia: dayName(now), n: now.get_day_of_month(), mes: monthName(now)});
        if (this._clockId)
            GLib.source_remove(this._clockId);
        this._clockId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60 - now.get_second(), () => {
            this._clockId = 0;
            this._updateClock();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- music ----------
    _buildMusic() {
        const box = new St.BoxLayout({style_class: 'isla-barra-musica', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(new St.Bin({style_class: 'isla-barra-cuadro', y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 15})}));
        this._song = new St.Label({style_class: 'isla-barra-cancion', y_align: Clutter.ActorAlign.CENTER});
        this._song.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._song);
        const controls = new St.BoxLayout({style_class: 'isla-barra-controles', y_align: Clutter.ActorAlign.CENTER});
        const control = (iconName, what, label) => {
            const b = new St.Button({style_class: 'isla-barra-control', can_focus: true, accessible_name: label,
                child: new St.Icon({icon_name: iconName, icon_size: 12})});
            b.connect('clicked', () => this._state.command('media', what));
            controls.add_child(b);
            return b;
        };
        control('media-skip-backward-symbolic', 'previous', _('Anterior'));
        this._play = control('media-playback-pause-symbolic', 'playpause', _('Pausa'));
        control('media-skip-forward-symbolic', 'next', _('Siguiente'));
        box.add_child(controls);
        return box;
    }

    _updateMusic() {
        const title = this._state.musicTitle;
        const playing = !!title && !!this._state.musicPlaying;
        if (title)
            this._song.text = title.toUpperCase();
        this._play.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._play.accessible_name = playing ? _('Pausa') : _('Reproducir');
        if (playing) {
            this._cancelStop();
            this._showMusic(true, true);
        } else if (this._musicShown && !this._stopId) {
            // A song change pauses for a moment: the clock comes back only if it stays stopped.
            this._stopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, title ? STOP_GRACE : 0, () => {
                this._stopId = 0;
                this._showMusic(false, true);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _cancelStop() {
        if (this._stopId)
            GLib.source_remove(this._stopId);
        this._stopId = 0;
    }

    // Cross-fade between the clock and the music; the island animates the width.
    _showMusic(on, animate) {
        if (on === this._musicShown)
            return;
        this._musicShown = on;
        const [show, hide] = on ? [this._music, this._clock] : [this._clock, this._music];
        for (const actor of [show, hide])
            actor.remove_all_transitions();
        show.show();
        hide.hide();
        if (animate && this.actor.mapped) {
            show.opacity = 0;
            show.ease({opacity: 255, duration: ms(SWAP_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            show.opacity = 255;
        }
        this._onChange();
    }

    // ---------- minimized apps ----------
    _watch(w) {
        if (this._windows.has(w))
            return;
        const ids = [
            w.connect('notify::minimized', () => this._queueMinimized()),
            w.connect('workspace-changed', () => this._queueMinimized()),
            w.connect('unmanaged', () => {
                ids.forEach(id => w.disconnect(id));
                this._windows.delete(w);
                this._queueMinimized();
            }),
        ];
        this._windows.set(w, ids);
    }

    _queueMinimized() {
        if (this._minId)
            return;
        this._minId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._minId = 0;
            this._updateMinimized();
            return GLib.SOURCE_REMOVE;
        });
    }

    _minimizedWindows() {
        return global.display.sort_windows_by_stacking(
            global.get_window_actors().map(a => a.meta_window).filter(w => counts(w) && w.minimized)).reverse();
    }

    _updateMinimized() {
        const windows = this._minimizedWindows();
        const key = windows.map(w => w.get_stable_sequence()).join(',');
        if (key === this._minKey)
            return;
        this._minKey = key;
        this._hideTip();
        this._minimized.destroy_all_children();
        const tracker = Shell.WindowTracker.get_default();
        const shown = windows.length > MAX_MINIMIZED ? windows.slice(0, MAX_MINIMIZED - 1) : windows;
        for (const w of shown) {
            const app = tracker.get_window_app(w);
            const name = app?.get_name() ?? w.get_title() ?? '';
            // Just the icon, no tile behind it; it grows a little under the mouse.
            const tile = new St.Button({style_class: 'isla-barra-app', can_focus: true, accessible_name: name,
                child: app?.create_icon_texture(APP_ICON) ?? new St.Icon({icon_name: 'application-x-executable-symbolic',
                    icon_size: APP_ICON}), track_hover: true, y_align: Clutter.ActorAlign.CENTER});
            tile.set_pivot_point(0.5, 0.5);
            tile.connect('clicked', () => Main.activateWindow(w));
            tile.connect('notify::hover', () => {
                const scale = tile.hover ? 1.12 : 1;
                tile.ease({scale_x: scale, scale_y: scale, duration: ms(120), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                if (tile.hover)
                    this._showTip(tile, name);
                else
                    this._hideTip();
            });
            this._minimized.add_child(tile);
        }
        const rest = windows.slice(shown.length);
        if (rest.length) {
            const more = new St.Button({style_class: 'isla-barra-cuadro isla-barra-mas', label: `+${rest.length}`, can_focus: true,
                accessible_name: fmt(_('{n} ventanas más'), {n: rest.length})});
            more.connect('clicked', () => this._openRest(more, rest));
            this._minimized.add_child(more);
        }
        const any = windows.length > 0;
        this._minimized.visible = this._innerSep.visible = any;
        this._piece[any ? 'remove_style_class_name' : 'add_style_class_name']('sin-minimizadas');
        this._onChange();
    }

    _openRest(anchor, windows) {
        this._menu?.destroy();
        const menu = this._menu = new PopupMenu.PopupMenu(anchor, 0.5, St.Side.BOTTOM);
        menu.actor.add_style_class_name('isla-menu');
        Main.uiGroup.add_child(menu.actor);
        this._menuManager.addMenu(menu);
        const tracker = Shell.WindowTracker.get_default();
        for (const w of windows) {
            const app = tracker.get_window_app(w);
            const title = w.get_title() || app?.get_name() || '';
            const item = menu.addAction(title.length > 50 ? `${title.slice(0, 49)}…` : title, () => Main.activateWindow(w));
            const icon = app?.create_icon_texture(16);
            if (icon)
                item.insert_child_at_index(icon, 1);
        }
        menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _showTip(actor, text) {
        if (!text)
            return;
        this._tip.text = text;
        this._tip.show();
        Main.layoutManager.uiGroup.set_child_above_sibling(this._tip, null);
        const [x, y] = actor.get_transformed_position();
        const [w] = actor.get_transformed_size();
        const [, tw] = this._tip.get_preferred_width(-1);
        const [, th] = this._tip.get_preferred_height(tw);
        this._tip.set_position(Math.round(x + w / 2 - tw / 2), Math.round(y - th - 8));
    }

    _hideTip() {
        this._tip.hide();
    }

    // The island's skin: light (the design's pink) or dark.
    setDark(dark, skinClass) {
        this._tip.style_class = `isla-tooltip ${skinClass ?? ''}${dark ? ' oscura' : ''}`;
    }

    destroy() {
        this._cancelStop();
        for (const id of [this._clockId, this._minId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._clockId = this._minId = 0;
        this._signals.forEach(([obj, id]) => obj.disconnect(id));
        this._signals = [];
        for (const [w, ids] of this._windows)
            ids.forEach(id => w.disconnect(id));
        this._windows.clear();
        this._menu?.destroy();
        this._tip.destroy();
        this.actor.destroy();
    }
}
