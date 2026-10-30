// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The bar (dock-minimizado-isla-dock.md, 2026-10-24): the folded island, always (since
// 2026-10-26 also with windows in sight, in the app grid and in do not disturb):
//   [Papelera] | [ date and time | minimized apps ] | [Notificaciones Portapapeles Ajustes] | [music]
// While a player plays the song (title and previous / pause / next) comes in at the
// very end, after Ajustes (Frank: not right after the search field), and leaves 3 s
// after it stops. The date and time are not there with the top island on (it shows
// them already); a click on the time opens IslaDock's calendar.
// With the top island on and 'musica-lugar' = 'arriba' (the default) the song plays up there, not here.
// The middle piece's right part has one icon per minimized window (5 at most, then "+N" with the rest in a menu); a
// click brings it back. The buttons at the ends are copies of the dock's (they
// count and look alike); a click opens the real one over the open dock.
// With the top island on (dock-opcion-a.html, 2026-10-26) the minimized windows go by
// app: a bigger icon, a small dot under it, and how many when there are several
// (a click on those lists them). After it (dock-opcion-a(1).html) a few pinned
// icons: today's page (the calendar) and the first dock favorites that are not open
// (an open one is already in sight: the next favorite takes its place); and, when more
// than one workspace is in use, a column of dots for them (the active one taller).
// Before the middle piece, the quick search field (2026-10-26, Frank's style B "vidrio
// con teclas"): a click on it opens the same search as Ctrl+Espacio, right there in the dock.
// Hovering leaves it as it is (it is meant to be used); the wheel over it opens
// the whole dock (isla.js).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import {_, fmt} from './i18n.js';
import {shortcutLabel} from './clipboard/panel.js';
import {dayName, monthName, monthShort} from './dates.js';
import {dockMonitorIndex} from './monitor.js';
import {inDock} from './notch/place.js';
import {ms} from './timing.js';
import {workspacesInUse} from './workspaces.js';

const TILE = 36;
const APP_ICON = 26;
const GROUP_ICON = 32;
const PINNED = 2;            // dock favorites after today's page
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

export class RestBar {
    // extras: the island's actors that live in the bar too (the main activity, the status items).
    // onChange(): the bar changed size (the island animates to it).
    constructor({state, settings, apps, extras = [], onChange}) {
        this._state = state;
        this._settings = settings;
        this._onChange = onChange;
        this._signals = [];
        this._windows = new Map();
        this.actor = new St.BoxLayout({style_class: 'isla-barra', y_align: Clutter.ActorAlign.CENTER});
        // When the shell shuts down the stage goes first: nothing queued may touch the bar after that.
        this.actor.connect('destroy', () => this._dropTimers());

        this._mirrors = {};
        for (const kind of ['trash', 'notifications', 'clipboard', 'power'])
            this._mirrors[kind] = apps.mirror(kind, TILE);
        this._sepStart = this._sep('isla-barra-sep');
        this._sepEnd = this._sep('isla-barra-sep');
        this._sepPinned = this._sep('isla-barra-sep');
        this._pinned = new St.BoxLayout({style_class: 'isla-barra-fijas', y_align: Clutter.ActorAlign.CENTER});
        this._spaces = new St.BoxLayout({style_class: 'isla-barra-espacios', orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER, reactive: true});
        this._spaces.connect('scroll-event', (_a, event) => this._scrollSpaces(event));
        this._mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._find = this._buildSearch();

        // The middle piece: clock | minimized apps. The music goes at the end.
        this._piece = new St.BoxLayout({style_class: 'isla-barra-pieza', y_align: Clutter.ActorAlign.CENTER});
        this._left = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        this._clock = this._buildClock();
        this._music = this._buildMusic();
        this._left.add_child(this._clock);
        this._sepMusic = this._sep('isla-barra-sep');
        this._innerSep = this._sep('isla-barra-sep-interno');
        this._minimized = new St.BoxLayout({style_class: 'isla-barra-minimizadas', y_align: Clutter.ActorAlign.CENTER});
        for (const actor of [this._left, this._innerSep, this._minimized])
            this._piece.add_child(actor);

        this._extras = extras;
        for (const actor of [this._mirrors.trash, this._sepStart, this._find, this._piece, ...extras, this._sepPinned, this._pinned, this._sepEnd,
            this._spaces, this._mirrors.notifications, this._mirrors.clipboard, this._mirrors.power, this._sepMusic, this._music])
            this.actor.add_child(actor);

        this._tip = new St.Label({style_class: 'isla-tooltip', visible: false});
        Main.layoutManager.uiGroup.add_child(this._tip);
        this._menuManager = new PopupMenu.PopupMenuManager(this.actor);

        this._on(state, 'music-info', () => this._updateMusic());
        this._on(state, 'music-changed', () => this._updateMusic());
        for (const key of Object.values(KEYS))
            this._on(settings, `changed::${key}`, () => this._updateEnds());
        this._on(settings, 'changed::atajo-busqueda', () => this._updateSearchKey());
        for (const key of ['isla-superior', 'musica-lugar'])
            this._on(settings, `changed::${key}`, () => this._updateMusic());
        this._on(settings, 'changed::isla-superior', () => {
            this._minKey = null;
            this._updateMinimized();
        });
        this._on(global.display, 'window-created', (_d, w) => {
            this._watch(w);
            this._queueMinimized();
        });
        this._on(global.workspace_manager, 'active-workspace-changed', () => {
            this._queueMinimized();
            this._syncPiece();
        });
        this._on(global.workspace_manager, 'notify::n-workspaces', () => this._syncPiece());
        this._on(this._mutter, 'changed::dynamic-workspaces', () => this._syncPiece());
        this._on(AppFavorites.getAppFavorites(), 'changed', () => this._buildPinned());
        this._on(Shell.AppSystem.get_default(), 'app-state-changed', () => this._queuePinned());
        global.get_window_actors().forEach(a => a.meta_window && this._watch(a.meta_window));
        this._buildPinned();
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
        this._syncPiece();
    }

    // With the top island on, the date and time stay up there: the middle piece keeps only
    // the music and the minimized apps, and goes away when it has neither.
    _syncPiece() {
        const top = this._settings.get_boolean('isla-superior');
        const clock = !top;
        const any = this._minimized.get_n_children() > 0;
        this._clock.visible = clock;
        this._left.visible = clock;
        this._music.visible = this._sepMusic.visible = !!this._musicShown;
        this._innerSep.visible = any && this._left.visible;
        this._piece.visible = this._left.visible || any;
        this._pinned.visible = top && this._pinned.get_n_children() > 0;
        this._syncSpaces(top);
        const right = ['notifications', 'clipboard', 'power'].some(k => this._mirrors[k].visible) || this._spaces.visible;
        // The search field is always in the middle.
        this._sepStart.visible = this._mirrors.trash.visible;
        this._sepPinned.visible = this._pinned.visible;
        this._sepEnd.visible = right;
        this._onChange();
    }

    // The main activity or a status item came or went.
    syncExtras() {
        this._onChange();
    }

    // ---------- search field ----------
    _buildSearch() {
        const button = new St.Button({style_class: 'isla-barra-buscar', can_focus: true, accessible_name: _('Buscar'),
            track_hover: true, y_align: Clutter.ActorAlign.CENTER});
        const box = new St.BoxLayout({style_class: 'isla-barra-buscar-caja', x_expand: true});
        box.add_child(new St.Icon({icon_name: 'system-search-symbolic', style_class: 'isla-barra-buscar-lupa',
            y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Label({style_class: 'isla-barra-buscar-texto', text: _('Buscar'), x_expand: true,
            y_align: Clutter.ActorAlign.CENTER}));
        // The shortcut drawn as little keys (Frank's style B, "vidrio con teclas").
        this._searchKey = new St.BoxLayout({style_class: 'isla-barra-buscar-teclas', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._searchKey);
        button.set_child(box);
        button.connect('clicked', () => this._state.command('search-open'));
        this._updateSearchKey();
        return button;
    }

    _updateSearchKey() {
        const accel = this._settings.get_strv('atajo-busqueda')[0] ?? '';
        this._searchKey.destroy_all_children();
        for (const key of shortcutLabel(accel).split('+').filter(Boolean)) {
            const space = /^space$/i.test(key);
            this._searchKey.add_child(new St.Label({style_class: `isla-barra-tecla${space ? ' espacio' : ''}`,
                text: space ? '␣' : key, y_align: Clutter.ActorAlign.CENTER}));
        }
        this._searchKey.visible = !!accel;
    }

    // ---------- pinned: today's page and the first favorites ----------
    _buildPinned() {
        this._hideTip();
        this._pinned.destroy_all_children();
        const page = new St.BoxLayout({style_class: 'isla-barra-hoja isla-barra-hoja-fija', orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER});
        this._pinMonth = new St.Label({style_class: 'isla-barra-hoja-mes', x_align: Clutter.ActorAlign.CENTER});
        this._pinDay = new St.Label({style_class: 'isla-barra-hoja-dia', x_align: Clutter.ActorAlign.CENTER});
        page.add_child(this._pinMonth);
        page.add_child(this._pinDay);
        const today = this._pinnedTile(page, _('Calendario'));
        today.connect('clicked', () => this._state.command('calendar-toggle', today));
        const closed = AppFavorites.getAppFavorites().getFavorites().filter(app => app.get_n_windows() === 0);
        for (const app of closed.slice(0, PINNED)) {
            const tile = this._pinnedTile(app.create_icon_texture(GROUP_ICON), app.get_name());
            tile.connect('clicked', () => app.activate());
        }
        if (this._month)
            this._updateClock();
        this._syncPiece();
    }

    // Apps open and close in bursts (a window, its dialogs): once per burst.
    _queuePinned() {
        if (this._pinId)
            return;
        this._pinId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pinId = 0;
            this._buildPinned();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Like a minimized app's tile, with room for the dot but no dot: they sit level.
    _pinnedTile(face, name) {
        const tile = new St.Button({style_class: 'isla-barra-grupo', can_focus: true, accessible_name: name, track_hover: true,
            y_align: Clutter.ActorAlign.CENTER});
        const column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'isla-barra-grupo-caja'});
        column.add_child(face);
        column.add_child(new St.Widget({style_class: 'isla-barra-grupo-linea sin-linea', x_align: Clutter.ActorAlign.CENTER}));
        tile.set_child(column);
        tile.connect('notify::hover', () => {
            face.ease({translation_y: tile.hover ? -2 : 0, duration: ms(150), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            if (tile.hover)
                this._showTip(tile, name);
            else
                this._hideTip();
        });
        this._pinned.add_child(tile);
        return tile;
    }

    // ---------- workspaces: a dot each, the active one taller ----------
    _syncSpaces(top) {
        const n = top ? workspacesInUse(this._mutter) : 0;
        this._spaces.visible = n > 1;
        if (n < 2)
            return;
        const box = this._spaces;
        while (box.get_n_children() > n)
            box.get_last_child().destroy();
        while (box.get_n_children() < n) {
            const i = box.get_n_children();
            const b = new St.Button({style_class: 'isla-barra-espacio-boton', can_focus: true, x_align: Clutter.ActorAlign.CENTER,
                accessible_name: fmt(_('Espacio de trabajo {n}'), {n: i + 1}),
                child: new St.Widget({style_class: 'isla-barra-espacio'})});
            b.connect('clicked', () => global.workspace_manager.get_workspace_by_index(i)?.activate(global.get_current_time()));
            box.add_child(b);
        }
        const active = global.workspace_manager.get_active_workspace_index();
        box.get_children().forEach((b, i) => b.child[i === active ? 'add_style_class_name' : 'remove_style_class_name']('activo'));
    }

    _scrollSpaces(event) {
        const dir = event.get_scroll_direction();
        const step = dir === Clutter.ScrollDirection.UP ? -1 : dir === Clutter.ScrollDirection.DOWN ? 1 : 0;
        const at = global.workspace_manager.get_active_workspace_index();
        const to = Math.max(0, Math.min(workspacesInUse(this._mutter) - 1, at + step));
        if (to !== at)
            global.workspace_manager.get_workspace_by_index(to)?.activate(global.get_current_time());
        return Clutter.EVENT_STOP;
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
        if (this._pinMonth) {
            this._pinMonth.text = this._month.text;
            this._pinDay.text = this._day.text;
        }
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
        // With the top island on, the song may live only up there ('musica-lugar').
        const playing = !!title && !!this._state.musicPlaying && inDock(this._settings, 'musica-lugar');
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

    // The music at the end comes in fading; the island animates the width.
    _showMusic(on, animate) {
        if (on === this._musicShown)
            return;
        this._musicShown = on;
        this._music.remove_all_transitions();
        if (on && animate && this.actor.mapped) {
            this._music.opacity = 0;
            this._music.ease({opacity: 255, duration: ms(SWAP_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            this._music.opacity = 255;
        }
        this._syncPiece();
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
        // The list of a group is open: its tile stays until it closes (rebuilt, the tile
        // would take the list with it and an × could close only one window).
        if (this._menu?.isOpen) {
            this._minLater = true;
            return;
        }
        const windows = this._minimizedWindows();
        const key = windows.map(w => w.get_stable_sequence()).join(',');
        if (key === this._minKey)
            return;
        this._minKey = key;
        this._hideTip();
        this._minimized.destroy_all_children();
        const tracker = Shell.WindowTracker.get_default();
        const byApp = this._settings.get_boolean('isla-superior');
        this._minimized[byApp ? 'add_style_class_name' : 'remove_style_class_name']('por-app');
        this._piece[byApp ? 'add_style_class_name' : 'remove_style_class_name']('por-app');
        // One entry per window, or per app (its windows, newest first) with the top island on.
        const entries = [];
        for (const w of windows) {
            const app = tracker.get_window_app(w);
            const same = byApp && app && entries.find(e => e.app === app);
            if (same)
                same.windows.push(w);
            else
                entries.push({app, windows: [w]});
        }
        // All of them, never a "+N" (Frank, 2026-10-26).
        for (const {app, windows: mine} of entries) {
            const w = mine[0];
            const name = app?.get_name() ?? w.get_title() ?? '';
            const icon = size => app?.create_icon_texture(size) ?? new St.Icon({icon_name: 'application-x-executable-symbolic',
                icon_size: size});
            const tile = new St.Button({style_class: byApp ? 'isla-barra-grupo' : 'isla-barra-app', can_focus: true,
                accessible_name: name, track_hover: true, y_align: Clutter.ActorAlign.CENTER});
            let lift = null;
            if (byApp) {
                // The icon over a small dot; the count on its corner.
                const column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'isla-barra-grupo-caja'});
                lift = icon(GROUP_ICON);
                column.add_child(lift);
                column.add_child(new St.Widget({style_class: 'isla-barra-grupo-linea', x_align: Clutter.ActorAlign.CENTER}));
                const box = new St.Widget();
                box.add_child(column);
                if (mine.length > 1) {
                    // Over the icon's top right corner, a little outside it.
                    const count = new St.Label({style_class: 'isla-barra-grupo-cuenta', text: String(mine.length)});
                    box.add_child(count);
                    tile._count = count;
                    const place = () => count.set_position(Math.round(column.width - count.width + 4), -3);
                    column.connect('notify::width', place);
                    count.connect('notify::width', place);
                }
                tile.set_child(box);
            } else {
                // Just the icon, no tile behind it; it grows a little under the mouse.
                tile.set_child(icon(APP_ICON));
            }
            tile.set_pivot_point(0.5, 0.5);
            tile.connect('clicked', () => mine.length > 1 ? this._openRest(tile, mine) : Main.activateWindow(w));
            tile.connect('notify::hover', () => {
                if (lift) {
                    lift.ease({translation_y: tile.hover ? -2 : 0, duration: ms(150), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                } else {
                    const scale = tile.hover ? 1.12 : 1;
                    tile.ease({scale_x: scale, scale_y: scale, duration: ms(120), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                }
                if (tile.hover)
                    this._showTip(tile, mine.length > 1 ? fmt(_('{app} ({n} ventanas)'), {app: name, n: mine.length}) : name);
                else
                    this._hideTip();
            });
            this._minimized.add_child(tile);
        }
        const any = windows.length > 0;
        this._minimized.visible = any;
        this._piece[any ? 'remove_style_class_name' : 'add_style_class_name']('sin-minimizadas');
        this._syncPiece();
    }

    _openRest(anchor, windows) {
        this._menu?.destroy();
        const menu = this._menu = new PopupMenu.PopupMenu(anchor, 0.5, St.Side.BOTTOM);
        menu.actor.add_style_class_name('isla-menu');
        Main.uiGroup.add_child(menu.actor);
        this._menuManager.addMenu(menu);
        menu.connect('open-state-changed', (_m, open) => {
            if (!open && this._minLater) {
                this._minLater = false;
                this._queueMinimized();
            }
        });
        const tracker = Shell.WindowTracker.get_default();
        for (const w of windows) {
            const app = tracker.get_window_app(w);
            const title = w.get_title() || app?.get_name() || '';
            const item = menu.addAction(title.length > 50 ? `${title.slice(0, 49)}…` : title, () => Main.activateWindow(w));
            const icon = app?.create_icon_texture(16);
            if (icon)
                item.insert_child_at_index(icon, 1);
            // An × at the end closes that window without opening it (Frank, 2026-10-30).
            const close = new St.Button({style_class: 'isla-menu-cerrar', can_focus: true, accessible_name: _('Cerrar ventana'),
                x_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14})});
            close.connect('clicked', () => {
                w.delete(global.get_current_time());
                item.destroy();
                const left = menu.numMenuItems;
                if (anchor._count) {
                    anchor._count.text = String(left);
                    anchor._count.visible = left > 1;
                }
                if (!left)
                    menu.close(BoxPointer.PopupAnimation.FULL);
            });
            item.add_child(close);
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

    // The island's skin: light (the dock's white) or dark.
    setDark(dark, skinClass) {
        this._tip.style_class = `isla-tooltip ${skinClass ?? ''}${dark ? ' oscura' : ''}`;
    }

    _dropTimers() {
        this._cancelStop();
        for (const id of [this._clockId, this._minId, this._pinId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._clockId = this._minId = this._pinId = 0;
    }

    destroy() {
        this._dropTimers();
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
