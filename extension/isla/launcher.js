// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Lanzador Isla, "Minimal+" (~/Descargas/lanzador-isla-minimal-spec.md, 2026-10-27; the
// first "vidrio" design is kept in ~/IslaDock/disenos/lanzador-1-vidrio): IslaDock's own
// app drawer, in place of GNOME's app grid. The Aplicaciones button of the dock or
// Super+Space (key 'atajo-lanzador'; Ctrl+Space stays with the quick search) opens it.
// One floating panel (860 px; the desktop and windows stay in sight around it, 2026-10-27)
// that comes up out of the dock like the calendar, just above it with the time and date and the Bloquear / Suspender / Apagar
// buttons, a pill search field, the text tabs of the categories, the four apps used last,
// every app in six columns (just its own icon, no square behind it), and a bar with
// the selected app and its actions (Nueva ventana, Fijar/Quitar del dock, Abrir).
// While a search finds files the panel widens and the selected app or file shows its
// preview on the right, the same card as the quick search (filePreview.js).
// No live blur behind it (it left dark stripes on X11 with NVIDIA); light when the dock is light.
// Typing filters live (GNOME's own app search: names, generic names, keywords); with no
// app found, Enter hands the text to the quick search (files, folders, sums).
// Right click on an app: the same actions. Dragging one onto the dock pins it there
// (apps.js accepts it).
// GNOME uses Super+Space to switch the keyboard layout ('switch-input-source'): while
// this runs that binding gives it up and gets it back after ('lanzador-liberado').
// 'lanzador-isla' off: the button opens GNOME's app grid again.
//
// Commands it listens to: 'launcher-toggle'.
// Commands it sends: 'panel-open' ('apps', open), 'search-open' (text), 'hide-tooltip'.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import {accentRGB} from './accent.js';
import {N_, _, fmt, localName, ngettext} from './i18n.js';
import {FilePreview} from './filePreview.js';
import {dockLook, dressFrame, islandLook} from './look.js';
import {dockMonitor} from './monitor.js';
import {candidates, fileInfo, folderLabel, highlight, indexedFiles, rank, recentFiles, relativeDate} from './searchFiles.js';
import {Mode} from './state.js';
import {ms} from './timing.js';

const KEY = 'atajo-lanzador';
const KEPT = 'lanzador-liberado';
const LAYOUT_SCHEMA = 'org.gnome.desktop.wm.keybindings';
const LAYOUT_KEYS = ['switch-input-source', 'switch-input-source-backward'];

const WIDTH = 860;              // the panel
const DOCK_GAP = 10;            // between the dock and the panel (as the calendar)
const MARGIN = 16;              // kept free at the top of the monitor
const PADDING = 28;
const RADIUS = 32;               // the panel's corners (stylesheet)
const MAX_HEIGHT = 0.8;         // of the monitor
const COLUMNS = 6;
const FOLLOW_TIME = 500;       // ms the panel follows the dock while it opens
const COLUMN_GAP = 8;
const ROW_GAP = 18;
const RECENTS = 4;
const FILES = 5;                // file rows under the apps while searching
const FILE_LOOKUPS = 40;        // files looked up on disk for one search, at most
const FILE_DELAY = 150;         // ms after the last key
const PREVIEW = 330;            // the preview card (stylesheet .isla-vp: 302 + 2 × 14)
const PREVIEW_GAP = 22;
// It comes up out of the dock like the calendar: from 0.82 and 28 px lower, with a small bounce.
const RISE = 28;
const SMALL = 0.82;
const SELECTED_SCALE = 1.12;
const IN_TIME = 240;
const OUT_TIME = 120;

// [id, name, GNOME categories of the .desktop].
const CATEGORIES = [
    ['todas', N_('Todas'), null],
    ['favoritas', N_('Favoritas'), null],
    ['desarrollo', N_('Desarrollo'), ['Development']],
    ['internet', N_('Internet'), ['Network']],
    ['multimedia', N_('Multimedia'), ['AudioVideo', 'Graphics']],
    ['oficina', N_('Oficina'), ['Office']],
    ['sistema', N_('Sistema'), ['System', 'Settings', 'Utility']],
];

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// The whole screen drawn again: on X11 with NVIDIA the panel's big shadow, while it grows out of
// the dock, could leave a stale patch next to it until the pointer passed over it.
const repaintAll = () => global.stage.queue_redraw();

// '<Super>space' -> 'Super ␣' for the little key of the search field.
export function shortcutText(accel) {
    if (!accel)
        return '';
    const mods = [...accel.matchAll(/<(\w+)>/g)].map(m => ({Primary: 'Ctrl', Control: 'Ctrl'}[m[1]] ?? m[1]));
    const key = accel.replace(/<\w+>/g, '');
    return [...mods, key === 'space' ? '␣' : key.length === 1 ? key.toUpperCase() : key].join(' ');
}

// When each app was last used (seconds), from GNOME's own usage file. It is written
// every few minutes, so a very recent use may still show the one before.
function lastSeen() {
    const seen = new Map();
    try {
        const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'application_state']);
        const [, bytes] = GLib.file_get_contents(path);
        const text = new TextDecoder().decode(bytes);
        for (const m of text.matchAll(/<application id="([^"]+)"[^>]*last-seen="(\d+)"/g))
            seen.set(m[1], Math.max(seen.get(m[1]) ?? 0, Number(m[2])));
    } catch {
        // No file yet: the order of GNOME's most used apps, without times.
    }
    return seen;
}

function ago(seconds) {
    const minutes = Math.floor((Date.now() / 1000 - seconds) / 60);
    if (minutes < 1)
        return _('Hace un momento');
    if (minutes < 60)
        return fmt(_('Hace {n} min'), {n: minutes});
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return fmt(ngettext('Hace {n} hora', 'Hace {n} horas', hours), {n: hours});
    const days = Math.floor(hours / 24);
    return fmt(ngettext('Hace {n} día', 'Hace {n} días', days), {n: days});
}

export class Launcher {
    constructor({state, settings, capsule, resolver}) {
        this._state = state;
        this._settings = settings;
        this._capsule = capsule;
        this._resolver = resolver;
        this._appSystem = Shell.AppSystem.get_default();
        this._overlay = null;
        this._ids = [
            [state, state.connect('command', (_s, name) => {
                if (name === 'launcher-toggle')
                    this.toggle();
            })],
            [state, state.connect('mode-changed', (_s, mode) => mode !== Mode.EXPANDED && !this._dragging && this.close())],
            [Main.overview, Main.overview.connect('showing', () => this.close(false))],
            // Not while an app is being dragged: its tile must live until the drop ends.
            [this._appSystem, this._appSystem.connect('installed-changed', () => this._overlay && !this._dragging && this._refresh())],
            [AppFavorites.getAppFavorites(), AppFavorites.getAppFavorites().connect('changed',
                () => this._overlay && !this._dragging && this._refresh())],
        ];
        this._freeShortcut();
        // POPUP too: the same keys close it again while it holds the keyboard.
        Main.wm.addKeybinding(KEY, settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP, () => this._fromShortcut());
    }

    // ---------- Super+Space ----------
    _freeShortcut() {
        try {
            this._layouts = new Gio.Settings({schema_id: LAYOUT_SCHEMA});
        } catch {
            this._layouts = null;
            return;
        }
        // Shift+Super+Space goes too when it is ours with Shift added: GNOME uses both.
        const ours = this._settings.get_strv(KEY);
        const kept = this._settings.get_strv(KEPT);
        const taken = [];
        for (const key of LAYOUT_KEYS) {
            const current = this._layouts.get_strv(key);
            const mine = current.filter(a => ours.some(b => same(a, b) || (key.endsWith('backward') && same(a, `<Shift>${b}`))));
            if (!mine.length)
                continue;
            taken.push(...mine.map(a => `${key}=${a}`));
            this._layouts.set_strv(key, current.filter(a => !mine.includes(a)));
        }
        if (taken.length)
            this._settings.set_strv(KEPT, [...new Set([...kept, ...taken])]);
    }

    _giveBackShortcut() {
        const taken = this._settings.get_strv(KEPT);
        if (!this._layouts || !taken.length)
            return;
        for (const key of LAYOUT_KEYS) {
            const back = taken.filter(t => t.startsWith(`${key}=`)).map(t => t.slice(key.length + 1));
            const current = this._layouts.get_strv(key);
            const missing = back.filter(a => !current.some(b => same(a, b)));
            if (missing.length)
                this._layouts.set_strv(key, [...missing, ...current]);
        }
        this._settings.set_strv(KEPT, []);
    }

    _fromShortcut() {
        if (this._overlay) {
            this.close();
            return;
        }
        if (Main.overview.visible)
            Main.overview.hide();
        this.open();
    }

    // ---------- open / close ----------
    get isOpen() {
        return !!this._overlay;
    }

    toggle() {
        if (this._overlay)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._overlay)
            return;
        if (this._state.mode !== Mode.EXPANDED && !this._state.setMode(Mode.EXPANDED))
            return;
        this._state.hold('launcher');
        this._state.command('hide-tooltip');
        this._category = 'todas';
        this._query = '';
        this._selected = 0;
        this._tiles = new Map();
        this._found = [];
        this._seen = lastSeen();
        this._recentFiles = [];
        this._filesCancel = new Gio.Cancellable();
        recentFiles(this._filesCancel, files => (this._recentFiles = files));
        this._build();
        this._refresh();
        this._grab = Main.pushModal(this._overlay, {actionMode: Shell.ActionMode.POPUP});
        this._entry.grab_key_focus();
        this._state.command('panel-open', 'apps', true);

        const panel = this._column;
        this._place();
        // Opened with a shortcut the dock is still opening: the panel follows it frame by frame
        // (placed once after 400 ms it jumped up, 2026-10-27).
        this._follow = new Clutter.Timeline({actor: panel, duration: Math.max(ms(FOLLOW_TIME), 1)});
        this._follow.connect('new-frame', () => this._place());
        this._follow.connect('completed', () => {
            this._place();
            repaintAll();
        });
        this._follow.start();
        panel.set({opacity: 0, scale_x: SMALL, scale_y: SMALL, translation_y: RISE * this._sf});
        panel.ease({opacity: 255, duration: ms(IN_TIME * 0.6), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        panel.ease({scale_x: 1, scale_y: 1, translation_y: 0, duration: ms(IN_TIME),
            mode: Clutter.AnimationMode.EASE_OUT_BACK, onStopped: repaintAll});
    }

    // The top of the open dock and its middle (the island's background), in the overlay's
    // coordinates; without it, an estimate from the icon size.
    _dockEdge() {
        const mon = dockMonitor();
        const island = this._state.skin?.isla?._bg;
        if (island?.get_stage() && island.visible) {
            const [ix, iy] = island.get_transformed_position();
            const [iw] = island.get_transformed_size();
            return {top: Math.min(iy, mon.y + mon.height) - mon.y, center: ix + iw / 2 - mon.x};
        }
        return {top: mon.height - (this._settings.get_int('tamano-base') + 44) * this._sf, center: mon.width / 2};
    }

    // Just above the dock and centered on it, inside the monitor; it keeps its bottom edge
    // there while its height changes with the search.
    _place() {
        const panel = this._column;
        if (!panel || !this._overlay)
            return;
        const sf = this._sf;
        const mon = dockMonitor();
        const {top, center} = this._dockEdge();
        // The panel's own width: the frame's allocation is a step behind when the preview comes or goes.
        const width = this._panel?.width ?? panel.width;
        const [, h] = panel.get_preferred_height(width);
        const x = Math.min(Math.max(center - width / 2, MARGIN * sf), mon.width - width - MARGIN * sf);
        const y = Math.max(top - DOCK_GAP * sf - h, MARGIN * sf);
        panel.set_position(Math.round(x), Math.round(y));
    }

    close(animate = true) {
        const overlay = this._overlay;
        if (!overlay)
            return;
        this._overlay = null;
        this._dragging = false;
        this._follow?.stop();
        this._follow = null;
        this._menu?.destroy();
        this._menu = null;
        this._release();
        this._menuManager = null;
        this._stopFileSearch();
        this._filesCancel?.cancel();
        this._filesCancel = null;
        if (this._clockId) {
            this._wallClock.disconnect(this._clockId);
            this._clockId = 0;
        }
        this._wallClock = null;
        overlay.reactive = false;
        const done = () => {
            overlay.destroy();
            repaintAll();
        };
        if (animate && overlay.opacity > 0) {
            // Back down into the dock.
            this._column.ease({opacity: 0, scale_x: SMALL, scale_y: SMALL, translation_y: RISE * this._sf,
                duration: ms(OUT_TIME), mode: Clutter.AnimationMode.EASE_IN_QUAD, onStopped: done});
        } else {
            done();
        }
        this._state.command('panel-open', 'apps', false);
        this._state.release('launcher');
    }

    _release() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    // ---------- the actors ----------
    _build() {
        const sf = this._sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const mon = dockMonitor();
        const look = islandLook(this._state);
        this._light = look.light;
        const overlay = this._overlay = new St.Widget({name: 'IslaLauncher', reactive: true,
            style_class: `isla-launcher${look.light ? ' clara' : ''}`,
            x: mon.x, y: mon.y, width: mon.width, height: mon.height});
        // Under the dock, so it stays on top with its Aplicaciones button lit.
        Main.layoutManager.uiGroup.add_child(overlay);
        const dock = this._dockActor();
        if (dock)
            Main.layoutManager.uiGroup.set_child_below_sibling(overlay, dock);
        overlay.connect('destroy', () => {
            if (this._overlay === overlay)
                this._overlay = null;
        });
        overlay.connect('captured-event', (_a, event) => this._onEvent(event));
        this._menuManager = new PopupMenu.PopupMenuManager(overlay, {actionMode: Shell.ActionMode.POPUP});

        // One floating panel; the overlay around it is clear (it only catches the clicks outside).
        const width = Math.min(WIDTH * sf, mon.width - 32 * sf);
        const panel = this._panel = new St.BoxLayout({style_class: 'isla-launcher-panel', vertical: true, width});
        // The dock's own color and edge; light, as see-through as the dock (81 %, Frank 2026-10-28),
        // dark at PANEL_ALPHA as the calendar and Ajustes. Its big shadow stays.
        const fill = look.light ? dockLook(this._state) : look;
        if (fill.style)
            panel.style = fill.style.replace(/\s*box-shadow:[^;]*;/, '');
        this._width = width;
        // Room for the preview beside the list, or none on a small monitor.
        this._previewRoom = width + (PREVIEW + PREVIEW_GAP) * sf <= mon.width - 32 * sf;
        // The frame moves and grows as one with the skin's own pieces around the panel (Aurora's halo).
        const frame = this._column = new St.Widget({layout_manager: new Clutter.BinLayout()});
        dressFrame(look, frame, panel, RADIUS);
        frame.set_pivot_point(0.5, 1);
        panel.connect('notify::height', () => this._place());
        panel.connect('notify::width', () => this._place());
        overlay.add_child(frame);
        this._inner = width - 2 * PADDING * sf;

        if (this._settings.get_boolean('lanzador-hora') || this._settings.get_boolean('lanzador-sesion'))
            panel.add_child(this._buildHeader());
        panel.add_child(this._buildSearch());
        panel.add_child(this._buildCard());
        panel.add_child(this._buildDetail());

        this._tip = new St.Label({style_class: 'isla-launcher-tip', visible: false});
        overlay.add_child(this._tip);
    }

    // The dock's own top actor in the ui group (the island lives inside it).
    _dockActor() {
        let actor = this._capsule;
        const group = Main.layoutManager.uiGroup;
        while (actor && actor.get_parent() !== group)
            actor = actor.get_parent();
        return actor;
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'isla-launcher-header'});
        if (this._settings.get_boolean('lanzador-hora')) {
            this._clock = new St.Label({style_class: 'isla-launcher-clock', y_align: Clutter.ActorAlign.END});
            this._date = new St.Label({style_class: 'isla-launcher-date', y_align: Clutter.ActorAlign.END});
            header.add_child(this._clock);
            header.add_child(this._date);
            this._wallClock = new GnomeDesktop.WallClock({time_only: true});
            this._clockId = this._wallClock.connect('notify::clock', () => this._tick());
            this._tick();
        }
        header.add_child(new St.Widget({x_expand: true}));
        if (this._settings.get_boolean('lanzador-sesion')) {
            const actions = SystemActions.getDefault();
            const buttons = new St.BoxLayout({style_class: 'isla-launcher-session', y_align: Clutter.ActorAlign.CENTER});
            for (const [icon, name, run, can, extra] of [
                ['system-lock-screen-symbolic', _('Bloquear'), () => actions.activateLockScreen(), actions.canLockScreen, ''],
                ['weather-clear-night-symbolic', _('Suspender'), () => actions.activateSuspend(), actions.canSuspend, ''],
                ['system-shutdown-symbolic', _('Apagar…'), () => actions.activatePowerOff(), actions.canPowerOff, ' danger'],
            ]) {
                if (!can)
                    continue;
                const button = new St.Button({style_class: `isla-launcher-session-btn${extra}`, can_focus: false,
                    child: new St.Icon({icon_name: icon, icon_size: 19}), accessible_name: name});
                button.connect('clicked', () => {
                    this.close(false);
                    run();
                });
                this._tipFor(button, name);
                buttons.add_child(button);
            }
            header.add_child(buttons);
        }
        return header;
    }

    // "16:27" and "martes, 27 de octubre", in the 12 or 24 hour format of the system.
    _tick() {
        const now = GLib.DateTime.new_now_local();
        this._clock.text = this._wallClock.clock;
        this._date.text = fmt(_('{dia}, {n} de {mes}'), {dia: localName(now, '%A'), n: now.get_day_of_month(),
            mes: localName(now, '%B')}).toLowerCase();
    }

    _buildSearch() {
        const search = new St.BoxLayout({style_class: 'isla-launcher-search'});
        search.add_child(new St.Icon({icon_name: 'system-search-symbolic', style_class: 'isla-launcher-search-icon',
            y_align: Clutter.ActorAlign.CENTER}));
        const entry = this._entry = new St.Entry({style_class: 'isla-launcher-entry', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER, hint_text: _('Buscar aplicaciones, archivos o acciones'), can_focus: true});
        entry.clutter_text.connect('text-changed', () => this._onText());
        entry.clutter_text.connect('key-press-event', (_a, event) => this._onKey(event));
        search.add_child(entry);
        const keys = shortcutText(this._settings.get_strv(KEY)[0]);
        if (keys)
            search.add_child(new St.Label({text: keys, style_class: 'isla-launcher-shortcut', y_align: Clutter.ActorAlign.CENTER}));
        return search;
    }

    _buildCard() {
        const card = new St.BoxLayout({style_class: 'isla-launcher-card', vertical: true});
        const top = new St.BoxLayout({style_class: 'isla-launcher-card-top'});
        const tabs = new St.BoxLayout({style_class: 'isla-launcher-tabs'});
        this._tabs = new Map();
        for (const [id, name] of CATEGORIES) {
            const tab = new St.Button({style_class: 'isla-launcher-tab', label: _(name), can_focus: false,
                y_align: Clutter.ActorAlign.CENTER});
            tab.connect('clicked', () => this._setCategory(id));
            this._tabs.set(id, tab);
            tabs.add_child(tab);
        }
        top.add_child(tabs);
        top.add_child(new St.Widget({x_expand: true}));
        this._recentBox = new St.BoxLayout({style_class: 'isla-launcher-recents', y_align: Clutter.ActorAlign.CENTER});
        top.add_child(this._recentBox);
        card.add_child(top);

        // The list on the left (always the panel's own inner width), the preview on the right.
        const body = new St.BoxLayout({style_class: 'isla-launcher-body'});
        const list = this._list = new St.BoxLayout({vertical: true, style_class: 'isla-launcher-list', width: this._inner});
        body.add_child(list);
        this._vp = new FilePreview({onOpen: () => this._activate(this._selected), openButton: false});
        this._vp.actor.visible = false;
        this._vp.actor.y_align = Clutter.ActorAlign.START;
        body.add_child(this._vp.actor);
        card.add_child(body);

        this._scroll = new St.ScrollView({style_class: 'isla-launcher-scroll', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true});
        this._grid = new St.BoxLayout({vertical: true, style_class: 'isla-launcher-grid'});
        this._scroll.set_child(this._grid);
        list.add_child(this._scroll);
        this._filesBox = new St.BoxLayout({style_class: 'isla-launcher-files', vertical: true, visible: false});
        this._filesBox.add_child(new St.Label({text: _('Archivos'), style_class: 'isla-launcher-files-title'}));
        this._fileList = new St.BoxLayout({vertical: true, style_class: 'isla-launcher-file-list'});
        this._filesBox.add_child(this._fileList);
        list.add_child(this._filesBox);
        this._empty = new St.Button({style_class: 'isla-launcher-empty', visible: false, can_focus: false,
            x_align: Clutter.ActorAlign.CENTER});
        this._empty.connect('clicked', () => this._searchFiles());
        list.add_child(this._empty);
        return card;
    }

    _buildDetail() {
        const bar = this._detail = new St.BoxLayout({style_class: 'isla-launcher-detail'});
        this._detailIcon = new St.Bin({style_class: 'isla-launcher-detail-icon', y_align: Clutter.ActorAlign.CENTER});
        bar.add_child(this._detailIcon);
        const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._detailName = new St.Label({style_class: 'isla-launcher-detail-name'});
        this._detailInfo = new St.Label({style_class: 'isla-launcher-detail-info'});
        this._detailName.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._detailName);
        text.add_child(this._detailInfo);
        bar.add_child(text);
        this._newWindow = new St.Button({style_class: 'isla-launcher-detail-btn', label: _('Nueva ventana'),
            can_focus: false, y_align: Clutter.ActorAlign.CENTER});
        this._newWindow.connect('clicked', () => this._openNew(this._current));
        this._pin = new St.Button({style_class: 'isla-launcher-detail-btn', can_focus: false, y_align: Clutter.ActorAlign.CENTER});
        this._pin.connect('clicked', () => this._togglePin(this._current));
        this._folder = new St.Button({style_class: 'isla-launcher-detail-btn', label: _('Abrir carpeta'),
            can_focus: false, y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._folder.connect('clicked', () => this._openFolder(this._currentFile));
        const open = new St.BoxLayout({style: 'spacing: 8px;'});
        open.add_child(new St.Label({text: _('Abrir'), y_align: Clutter.ActorAlign.CENTER}));
        open.add_child(new St.Label({text: '↵', style_class: 'isla-launcher-open-key', y_align: Clutter.ActorAlign.CENTER}));
        const openButton = new St.Button({style_class: 'isla-launcher-open-btn', child: open, can_focus: false,
            y_align: Clutter.ActorAlign.CENTER});
        openButton.connect('clicked', () => this._activate(this._selected));
        bar.add_child(this._folder);
        bar.add_child(this._newWindow);
        bar.add_child(this._pin);
        bar.add_child(openButton);
        return bar;
    }

    // A small name over a button while the pointer is on it.
    _tipFor(actor, text) {
        actor.connect('notify::hover', () => {
            const tip = this._tip;
            if (!tip)
                return;
            if (!actor.hover) {
                tip.hide();
                return;
            }
            tip.text = text;
            tip.show();
            const [ax, ay] = actor.get_transformed_position();
            const [ox, oy] = this._overlay.get_transformed_position();
            const [, tw] = tip.get_preferred_width(-1);
            const [, th] = tip.get_preferred_height(-1);
            tip.set_position(Math.round(ax - ox + actor.width / 2 - tw / 2), Math.round(ay - oy - th - 6 * this._sf));
        });
    }

    // ---------- what is shown ----------
    _gicon(app) {
        const own = app.get_app_info()?.get_icon();
        const names = own instanceof Gio.ThemedIcon ? own.get_names() : [];
        const id = app.get_id().replace(/\.desktop$/, '');
        return this._resolver?.lookup(id, app.get_icon(), names) ?? app.get_icon();
    }

    _installed() {
        if (!this._all) {
            this._all = this._appSystem.get_installed()
                .filter(info => info.should_show())
                .map(info => this._appSystem.lookup_app(info.get_id()))
                .filter(Boolean)
                .sort((a, b) => a.get_name().localeCompare(b.get_name()));
        }
        return this._all;
    }

    _inCategory(app, id) {
        if (id === 'todas')
            return true;
        if (id === 'favoritas')
            return AppFavorites.getAppFavorites().isFavorite(app.get_id());
        const wanted = CATEGORIES.find(c => c[0] === id)[2];
        const own = (app.get_app_info()?.get_categories() ?? '').split(';');
        return wanted.some(c => own.includes(c));
    }

    _categoryName(app) {
        const found = CATEGORIES.slice(2).find(([id]) => this._inCategory(app, id));
        return found ? _(found[1]) : _('Aplicación');
    }

    // The apps of the category, filtered by the text in GNOME's own order of relevance.
    _visible() {
        const apps = this._installed().filter(app => this._inCategory(app, this._category));
        if (!this._query)
            return apps;
        const byId = new Map(apps.map(a => [a.get_id(), a]));
        return Shell.AppSystem.search(this._query).flat().map(id => byId.get(id)).filter(Boolean);
    }

    // Installed apps or favorites changed while open: everything is made again.
    _refresh() {
        this._all = null;
        this._tiles.forEach(t => t.destroy());
        this._tiles.clear();
        this._recentsDone = false;
        this._recentBox.destroy_all_children();
        this._draw();
    }

    _draw() {
        for (const [id, tab] of this._tabs) {
            if (id === this._category)
                tab.add_style_pseudo_class('checked');
            else
                tab.remove_style_pseudo_class('checked');
        }
        this._drawRecents();

        const apps = this._shown = this._visible();
        // The tiles stay made: only taken out of their old row.
        for (const tile of this._tiles.values())
            tile.get_parent()?.remove_child(tile);
        this._grid.destroy_all_children();
        const tileWidth = Math.floor((this._inner - (COLUMNS - 1) * COLUMN_GAP * this._sf) / COLUMNS);
        let row = null;
        apps.forEach((app, i) => {
            if (i % COLUMNS === 0) {
                row = new St.BoxLayout({style_class: 'isla-launcher-row'});
                this._grid.add_child(row);
            }
            const tile = this._tile(app);
            tile.width = tileWidth;
            this._paintTile(tile, false);
            row.add_child(tile);
        });
        this._drawFiles();
        this._showPreview(this._found.length > 0 && this._previewRoom);
        this._empty.visible = !apps.length && !this._found.length;
        this._scroll.visible = apps.length > 0;
        if (this._empty.visible) {
            this._empty.label = this._query
                ? fmt(_('Ninguna app ni archivo. Enter abre la búsqueda rápida con “{texto}”'), {texto: this._query})
                : _('No hay apps en esta categoría');
        }
        this._fitHeight();
        this._select(Math.min(this._selected, apps.length + this._found.length - 1), false);
    }

    // ---------- files ----------
    // Recent files (GTK's history and their folders) and the desktop's file index, by how well
    // the name matches and then newest first.
    _searchFilesFor(query) {
        this._stopFileSearch();
        if (!query) {
            this._setFound([]);
            return;
        }
        this._fileTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FILE_DELAY, () => {
            this._fileTimer = 0;
            this._findFiles(query).catch(logError);
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopFileSearch() {
        if (this._fileTimer)
            GLib.source_remove(this._fileTimer);
        this._fileTimer = 0;
        this._fileSearch?.cancel();
        this._fileSearch = null;
    }

    async _findFiles(query) {
        const cancellable = this._fileSearch = new Gio.Cancellable();
        const recent = candidates(this._recentFiles).filter(path => rank(GLib.path_get_basename(path), query) >= 0);
        const indexed = await indexedFiles(query, FILE_LOOKUPS, cancellable);
        if (cancellable.is_cancelled())
            return;
        const paths = [...new Set([...recent, ...indexed])].slice(0, FILE_LOOKUPS);
        const infos = await Promise.all(paths.map(path => fileInfo(path, cancellable)));
        if (cancellable.is_cancelled() || query !== this._query)
            return;
        const found = infos.filter(Boolean)
            .map(info => ({...info, rank: rank(info.name, query)}))
            .filter(info => info.rank >= 0)
            .sort((a, b) => a.rank - b.rank || b.mtime - a.mtime)
            .slice(0, FILES);
        this._setFound(found);
    }

    _setFound(found) {
        if (!this._overlay || (!found.length && !this._found.length))
            return;
        this._found = found;
        this._draw();
    }

    _drawFiles() {
        this._fileList.destroy_all_children();
        this._filesBox.visible = this._found.length > 0;
        const [r, g, b] = accentRGB();
        const color = `#${[r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')}`;
        this._found.forEach((file, k) => {
            const row = new St.Button({style_class: 'isla-launcher-file', can_focus: false, track_hover: true, x_expand: true});
            const box = new St.BoxLayout({style_class: 'isla-launcher-file-box', x_expand: true});
            box.add_child(new St.Icon({gicon: file.gicon, icon_size: 26, y_align: Clutter.ActorAlign.CENTER}));
            const name = new St.Label({style_class: 'isla-launcher-file-name', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            name.clutter_text.set_markup(highlight(file.name, this._query, color));
            name.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
            box.add_child(name);
            box.add_child(new St.Label({text: this._fileInfo(file), style_class: 'isla-launcher-file-where',
                y_align: Clutter.ActorAlign.CENTER}));
            row.set_child(box);
            row.connect('clicked', () => this._openFile(file));
            row.connect('notify::hover', () => row.hover && this._select(this._shown.length + k, false));
            file.row = row;
            this._fileList.add_child(row);
        });
    }

    _fileInfo(file) {
        const where = folderLabel(file.dir);
        const when = relativeDate(file.mtime);
        return when ? `${where} · ${when}` : where;
    }

    // The panel grows to the right of the list for the preview (it stays centered on the dock).
    _showPreview(show) {
        const vp = this._vp.actor;
        if (vp.visible === show)
            return;
        vp.visible = show;
        this._panel.width = this._width + (show ? (PREVIEW + PREVIEW_GAP) * this._sf : 0);
        if (show) {
            vp.opacity = 0;
            vp.ease({opacity: 255, duration: ms(150), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            this._vp.cancel();
        }
    }

    _previewItem(app, file) {
        if (app)
            return {kind: 'app', title: app.get_name(), subtitle: app.get_description() ?? '', gicon: this._gicon(app)};
        if (file)
            return {...file, kind: file.folder ? 'folder' : 'file', title: file.name};
        return null;
    }

    _openFile(file) {
        this.close();
        try {
            Gio.AppInfo.launch_default_for_uri(file.uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notifyError(_('No se pudo abrir'), e.message);
        }
    }

    // The folder that holds it, with the file selected (the file manager's own D-Bus call).
    _openFolder(file) {
        if (!file)
            return;
        this.close();
        Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[file.uri], '']),
            null, Gio.DBusCallFlags.NONE, -1, null, (bus, res) => {
                try {
                    bus.call_finish(res);
                } catch {
                    Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(file.dir).get_uri(), null);
                }
            });
    }

    // An app tile or, past the apps, a file row.
    _activate(i) {
        const apps = this._shown ?? [];
        if (i < apps.length)
            this._launch(apps[i]);
        else if (this._found[i - apps.length])
            this._openFile(this._found[i - apps.length]);
    }

    _drawRecents() {
        if (this._recentsDone) {
            this._recentBox.visible = !this._query && this._recentBox.get_n_children() > 1;
            return;
        }
        this._recentsDone = true;
        const seen = this._seen;
        const shown = new Set(this._installed().map(a => a.get_id()));
        let apps = [...seen.entries()].filter(([id]) => shown.has(id)).sort((a, b) => b[1] - a[1])
            .map(([id]) => this._appSystem.lookup_app(id));
        if (!apps.length)
            apps = Shell.AppUsage.get_default().get_most_used().filter(a => shown.has(a.get_id()));
        apps = apps.slice(0, RECENTS);
        this._recentBox.add_child(new St.Label({text: _('Recientes'), style_class: 'isla-launcher-recents-label',
            y_align: Clutter.ActorAlign.CENTER}));
        for (const app of apps) {
            const button = new St.Button({style_class: 'isla-launcher-recent', can_focus: false,
                child: new St.Icon({gicon: this._gicon(app), icon_size: 30})});
            button.connect('clicked', () => this._launch(app));
            button.connect('button-press-event', (_a, event) => this._maybeMenu(event, app, button));
            this._tipFor(button, app.get_name());
            this._recentBox.add_child(button);
        }
        this._recentBox.visible = !this._query && apps.length > 0;
    }

    _tile(app) {
        let tile = this._tiles.get(app.get_id());
        if (tile)
            return tile;
        tile = new St.Button({style_class: 'isla-launcher-tile', can_focus: false, reactive: true, track_hover: true});
        const box = new St.BoxLayout({vertical: true, style_class: 'isla-launcher-tile-box', x_expand: true});
        const square = new St.Bin({style_class: 'isla-launcher-tile-icon', x_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({gicon: this._gicon(app), icon_size: 54})});
        square.set_pivot_point(0.5, 0.5);
        box.add_child(square);
        const label = new St.Label({text: app.get_name(), style_class: 'isla-launcher-tile-name', x_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);
        tile.set_child(box);
        tile._square = square;
        tile._name = label;
        this._wire(tile, app, square);
        this._tiles.set(app.get_id(), tile);
        return tile;
    }

    // Just the app's own icon, no square behind it; the selected one grows a little.
    _paintTile(tile, selected) {
        const scale = selected ? SELECTED_SCALE : 1;
        if (tile._square.scale_x !== scale)
            tile._square.ease({scale_x: scale, scale_y: scale, duration: ms(120), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        if (selected)
            tile._name.add_style_class_name('selected');
        else
            tile._name.remove_style_class_name('selected');
    }

    // Click opens, hover selects, right click the menu, a drag pins it on the dock.
    _wire(actor, app, icon) {
        actor.app = app;
        actor.connect('clicked', () => this._launch(app));
        actor.connect('notify::hover', () => {
            if (actor.hover)
                this._select(this._shown.indexOf(app), false);
        });
        actor.connect('button-press-event', (_a, event) => this._maybeMenu(event, app, actor));
        actor._delegate = {
            launcherApp: app,
            getDragActor: () => app.create_icon_texture(58),
            getDragActorSource: () => icon,
        };
        const draggable = DND.makeDraggable(actor, {timeoutThreshold: 200});
        draggable.connect('drag-begin', () => this._dragBegin());
        draggable.connect('drag-end', () => this._dragEnd());
        draggable.connect('drag-cancelled', () => this._dragEnd());
    }

    // Down to just above the open dock, in whole rows: no app is cut in half. Without a search the
    // list keeps the height of "Todas" in every category, so the panel does not jump between tabs.
    _fitHeight() {
        const sf = this._sf;
        const mon = dockMonitor();
        const {top: dockTop} = this._dockEdge();
        this._scroll.style = null;
        this._list.style = null;
        const [, columnH] = this._column.get_preferred_height(this._column.width);
        const [, scrollH] = this._scroll.get_preferred_height(this._inner);
        const [, listH] = this._list.get_preferred_height(this._inner);
        const steady = !this._query;
        const others = columnH - (steady ? listH : this._scroll.visible ? scrollH : 0);
        const room = Math.max(120 * sf, Math.min(dockTop - (DOCK_GAP + MARGIN) * sf, mon.height * MAX_HEIGHT) - others);
        const first = this._grid.get_first_child();
        if (first)
            [, this._rowH] = first.get_preferred_height(this._inner);
        if (!this._rowH)
            return;
        const gap = ROW_GAP * sf;
        const height = rows => Math.floor((rows * this._rowH + (rows - 1) * gap) / sf);
        const fit = Math.max(1, Math.floor((room + gap) / (this._rowH + gap)));
        if (steady) {
            const all = Math.max(1, Math.ceil(this._installed().length / COLUMNS));
            const rows = Math.min(all, fit);
            this._list.style = `min-height: ${height(rows)}px;`;
            if (all > rows)
                this._scroll.style = `max-height: ${height(rows)}px;`;
        } else if (scrollH > room) {
            this._scroll.style = `max-height: ${height(fit)}px;`;
        }
    }

    // ---------- selection and the detail bar ----------
    _select(i, scroll = true) {
        const apps = this._shown ?? [];
        const old = apps[this._selected];
        const oldTile = old && this._tiles.get(old.get_id());
        if (oldTile)
            this._paintTile(oldTile, false);
        this._found.forEach(f => f.row?.remove_style_pseudo_class('selected'));
        this._selected = Math.max(0, i);
        const app = apps[this._selected];
        const file = this._found[this._selected - apps.length];
        if (this._vp.actor.visible)
            this._vp.show(this._previewItem(app, file));
        if (!app && file) {
            file.row.add_style_pseudo_class('selected');
            this._fillFileDetail(file);
            return;
        }
        this._fillDetail(app);
        if (!app)
            return;
        const tile = this._tiles.get(app.get_id());
        if (tile) {
            this._paintTile(tile, true);
            if (scroll)
                this._scrollTo();
        }
    }

    _fillDetail(app) {
        this._current = app ?? null;
        this._currentFile = null;
        this._folder.visible = false;
        this._detail.opacity = app ? 255 : 0;
        if (!app)
            return;
        this._detailIcon.set_child(new St.Icon({gicon: this._gicon(app), icon_size: 36}));
        this._detailName.text = app.get_name();
        const favorite = AppFavorites.getAppFavorites().isFavorite(app.get_id());
        const windows = app.get_n_windows();
        let info = '';
        if (windows)
            info = fmt(ngettext('{n} ventana abierta', '{n} ventanas abiertas', windows), {n: windows});
        else if (favorite)
            info = _('en el dock');
        else if (this._seen.has(app.get_id()))
            info = fmt(_('abierta {cuando}'), {cuando: ago(this._seen.get(app.get_id())).toLowerCase()});
        this._detailInfo.text = info ? `${this._categoryName(app)} · ${info}` : this._categoryName(app);
        this._newWindow.visible = app.can_open_new_window();
        this._pin.visible = !!app.get_app_info();
        this._pin.label = favorite ? _('Quitar del dock') : _('Fijar en el dock');
    }

    _fillFileDetail(file) {
        this._current = null;
        this._currentFile = file;
        this._detail.opacity = 255;
        this._detailIcon.set_child(new St.Icon({gicon: file.gicon, icon_size: 36}));
        this._detailName.text = file.name;
        this._detailInfo.text = this._fileInfo(file);
        this._newWindow.visible = false;
        this._pin.visible = false;
        this._folder.visible = true;
    }

    // From the row number (the rows' own positions read 0 while a relayout is pending).
    _scrollTo() {
        const adjustment = this._scroll.vadjustment;
        const first = this._grid.get_first_child();
        if (!first)
            return;
        const step = first.height + ROW_GAP * this._sf;
        const top = Math.floor(this._selected / COLUMNS) * step;
        const bottom = top + first.height;
        if (top < adjustment.value)
            adjustment.value = top;
        else if (bottom > adjustment.value + adjustment.page_size)
            adjustment.value = bottom - adjustment.page_size;
    }

    // In the grid by tiles and rows; down past the last row into the files, one by one there.
    _move(step) {
        const apps = this._shown?.length ?? 0;
        const n = apps + this._found.length;
        const at = this._selected;
        let i;
        if (at >= apps)
            i = at + Math.sign(step);
        else if (at + step >= apps && step > 0)
            i = this._found.length ? apps : (step > 1 && at < apps - 1 ? apps - 1 : -1);
        else
            i = at + step;
        if (i < 0 || i >= n)
            return;
        this._select(i);
    }

    // ---------- input ----------
    _onText() {
        const text = this._entry.get_text().trim();
        if (text === this._query)
            return;
        this._query = text;
        this._selected = 0;
        this._draw();
        this._searchFilesFor(text);
    }

    _onKey(event) {
        const symbol = event.get_key_symbol();
        const mods = event.get_state();
        const shift = !!(mods & Clutter.ModifierType.SHIFT_MASK);
        const ctrl = !!(mods & Clutter.ModifierType.CONTROL_MASK);
        switch (symbol) {
        case Clutter.KEY_Escape:
            if (this._entry.get_text())
                this._entry.set_text('');
            else
                this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter: {
            const app = this._shown?.[this._selected];
            const file = this._found[this._selected - (this._shown?.length ?? 0)];
            if (app && ctrl)
                this._openNew(app);
            else if (file && ctrl)
                this._openFolder(file);
            else if (app || file)
                this._activate(this._selected);
            else if (this._query)
                this._searchFiles();
            return Clutter.EVENT_STOP;
        }
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab: {
            const ids = CATEGORIES.map(c => c[0]);
            const back = shift || symbol === Clutter.KEY_ISO_Left_Tab;
            const at = ids.indexOf(this._category);
            this._setCategory(ids[(at + (back ? -1 : 1) + ids.length) % ids.length]);
            return Clutter.EVENT_STOP;
        }
        case Clutter.KEY_Left:
            this._move(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Right:
            this._move(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._move(-COLUMNS);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._move(COLUMNS);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS && !this._entry.clutter_text.has_key_focus()) {
            // Keys always go to the search field (a click may have taken the focus).
            this._entry.grab_key_focus();
            return this._onKey(event) === Clutter.EVENT_STOP ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        if (this._column.contains(global.stage.get_event_actor(event)))
            return Clutter.EVENT_PROPAGATE;
        // Outside (the Aplicaciones button too: its click would open it again).
        this.close();
        return Clutter.EVENT_STOP;
    }

    _setCategory(id) {
        if (id === this._category)
            return;
        this._category = id;
        this._selected = 0;
        this._scroll.vadjustment.value = 0;
        this._draw();
        this._entry.grab_key_focus();
    }

    _launch(app) {
        this.close();
        app.activate();
    }

    _openNew(app) {
        if (!app?.can_open_new_window())
            return;
        this.close();
        app.open_new_window(-1);
    }

    _togglePin(app) {
        if (!app?.get_app_info())
            return;
        const favorites = AppFavorites.getAppFavorites();
        if (favorites.isFavorite(app.get_id()))
            favorites.removeFavorite(app.get_id());
        else
            favorites.addFavorite(app.get_id());
    }

    // Nothing matches: the quick search of the island takes the text (files, folders, sums, the web).
    _searchFiles() {
        const text = this._query;
        this.close(false);
        this._state.command('search-open', text);
    }

    // ---------- right click ----------
    _maybeMenu(event, app, actor) {
        if (event.get_button() !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_PROPAGATE;
        this._openMenu(app, actor);
        return Clutter.EVENT_STOP;
    }

    _openMenu(app, actor) {
        this._menu?.destroy();
        const menu = this._menu = new PopupMenu.PopupMenu(actor, 0.5, St.Side.TOP);
        menu.actor.add_style_class_name('isla-launcher-menu');
        if (this._light)
            menu.actor.add_style_class_name('clara');
        menu.addAction(_('Abrir'), () => this._launch(app));
        if (app.can_open_new_window())
            menu.addAction(_('Nueva ventana'), () => this._openNew(app));
        if (app.get_app_info()) {
            const pinned = AppFavorites.getAppFavorites().isFavorite(app.get_id());
            menu.addAction(pinned ? _('Quitar del dock') : _('Fijar en el dock'), () => this._togglePin(app));
        }
        Main.uiGroup.add_child(menu.actor);
        this._menuManager.addMenu(menu);
        menu.connect('open-state-changed', (_m, open) => {
            if (open)
                return;
            this._entry?.grab_key_focus();
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                menu.destroy();
                return GLib.SOURCE_REMOVE;
            });
        });
        menu.connect('destroy', () => {
            if (this._menu === menu)
                this._menu = null;
        });
        menu.open(true);
    }

    // ---------- drag to the dock ----------
    // The launcher steps aside (the dock stays open) so the app can be dropped on it.
    _dragBegin() {
        if (!this._overlay)
            return;
        this._dragging = true;
        this._release();
        this._overlay.reactive = false;
        this._overlay.ease({opacity: 0, duration: ms(OUT_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _dragEnd() {
        if (!this._dragging)
            return;
        this._dragging = false;
        this.close(false);
    }

    destroy() {
        this.close(false);
        Main.wm.removeKeybinding(KEY);
        this._giveBackShortcut();
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
    }
}
