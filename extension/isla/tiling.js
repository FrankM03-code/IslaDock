// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Acomodar ventanas ('acomodar-ventanas', on by default): simple tiling, no layouts to learn.
// Dragging a window with the mouse to a screen edge or corner shows a soft shadow of where it
// will go; letting it go there puts it on that half (left / right edge), that quarter (a corner)
// or maximized (the top edge). Dragged away again, it takes back the size it had before.
// 'acomodar-ventanas-llenar': after a half, the other half shows the other windows of that
// monitor and workspace as colored tiles (icon, name, title); a click puts that one there (Esc or a click
// outside leaves the space empty). Like Tiling Assistant's popup, which Frank used.
// While on, GNOME's own edge tiling ('edge-tiling' of org.gnome.mutter) steps aside so the two
// never draw their shadows at once; it comes back when this goes ('acomodo-liberado').
// With the Tiling Assistant extension running, this one lets it do the job.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {_} from './i18n.js';
import {islandLook} from './look.js';
import {ms} from './timing.js';

const KEPT = 'acomodo-liberado';
const FILL = 'acomodar-ventanas-llenar';
const MUTTER = 'org.gnome.mutter';
const EDGE_TILING = 'edge-tiling';
const TILING_ASSISTANT = 'tiling-assistant@leleat-on-github';
const EDGE = 8;            // px from the screen edge that count as "at the edge"
const CORNER = 0.22;       // part of the side, from a corner, that makes a quarter instead of a half
const POLL = 40;           // ms between two looks at the pointer while dragging
const UNTILE = 12;         // px the pointer moves before a tiled window gets its old size back
const SHADOW_TIME = 160;
const SETTLE = 300;        // ms after a tile to check the window took its place (some have a minimum size)
const PICK_MAX = 9;        // windows offered to fill the other half
const TILE_W = 300;       // a tile of the picker; one left alone on the last row takes the whole row
const TILE_H = 150;
const TILE_ICON = 64;
const CARD_GAP = 18;      // px between two tiles of the picker
// Soft tile colors, light and dark theme; an app always gets the same one (from its id).
const TILE_LIGHT = ['#FDE2E4', '#DCEBFF', '#D6F0FF', '#E3ECFF', '#FFF1D6', '#DFF5E3', '#EEE3FF', '#FFE6D5'];
const TILE_DARK = ['#4A2F36', '#2A3A55', '#21414F', '#2F3557', '#4A3F26', '#27452F', '#3A3055', '#4B3428'];
const tileColor = (key, light) => {
    let h = 0;
    for (const c of key)
        h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const list = light ? TILE_LIGHT : TILE_DARK;
    return list[h % list.length];
};

// GNOME 49 dropped the flags of maximize() / unmaximize() and get_maximized().
const maximized = w => w.is_maximized?.() ?? w.get_maximized() !== 0;
const unmaximize = w => (w.unmaximize.length ? w.unmaximize(Meta.MaximizeFlags.BOTH) : w.unmaximize());
const maximize = w => (w.maximize.length ? w.maximize(Meta.MaximizeFlags.BOTH) : w.maximize());
const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export class Tiling {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._tiled = new Map();       // window → {rect it was put in, width and height before}
        this._watched = new Set();     // windows whose closing takes them off _tiled
        this._settles = new Set();
        this._lendEdgeTiling();
        this._ids = [
            global.display.connect('grab-op-begin', (_d, window, op) => this._begin(window, op)),
            global.display.connect('grab-op-end', (_d, window) => this._end(window)),
        ];
    }

    // ---------- GNOME's own edge tiling steps aside ----------
    _lendEdgeTiling() {
        try {
            this._mutter = new Gio.Settings({schema_id: MUTTER});
        } catch {
            this._mutter = null;
            return;
        }
        if (this._mutter.get_boolean(EDGE_TILING)) {
            this._settings.set_boolean(KEPT, true);
            this._mutter.set_boolean(EDGE_TILING, false);
        }
    }

    _giveBackEdgeTiling() {
        if (!this._mutter || !this._settings.get_boolean(KEPT))
            return;
        this._mutter.set_boolean(EDGE_TILING, true);
        this._settings.set_boolean(KEPT, false);
    }

    get _otherTiler() {
        return Main.extensionManager.lookup(TILING_ASSISTANT)?.state === 1;
    }

    // ---------- dragging ----------
    _begin(window, op) {
        // The mouse only (not Alt+F7 from the keyboard).
        if (!window || (op !== Meta.GrabOp.MOVING && op !== Meta.GrabOp.MOVING_UNCONSTRAINED) ||
            window.get_window_type() !== Meta.WindowType.NORMAL || this._otherTiler)
            return;
        this._closePicker();
        const [px, py] = global.get_pointer();
        this._drag = {window, start: [px, py], zone: null, untiled: !this._isTiled(window)};
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL, () => {
            this._follow();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _isTiled(window) {
        const t = this._tiled.get(window);
        return !!t && sameRect(window.get_frame_rect(), t.rect);
    }

    _follow() {
        const drag = this._drag;
        // Closed while dragged.
        if (!drag.window.get_compositor_private()) {
            this._stopFollowing();
            this._showShadow(null);
            return;
        }
        const [px, py] = global.get_pointer();
        // Off a tile: its old size back, under the pointer.
        if (!drag.untiled && Math.hypot(px - drag.start[0], py - drag.start[1]) > UNTILE) {
            drag.untiled = true;
            const before = this._tiled.get(drag.window);
            this._tiled.delete(drag.window);
            const r = drag.window.get_frame_rect();
            const x = Math.round(px - (px - r.x) * before.width / r.width);
            drag.window.move_resize_frame(true, x, r.y, before.width, before.height);
        }
        const zone = this._zoneAt(px, py);
        if (zone?.name === drag.zone?.name && zone?.monitor === drag.zone?.monitor)
            return;
        drag.zone = zone;
        this._showShadow(zone);
    }

    // Where the pointer is: a half, a quarter, the whole (top edge) or nothing.
    _zoneAt(px, py) {
        const monitor = global.display.get_monitor_index_for_rect(new Mtk.Rectangle({x: px, y: py, width: 1, height: 1}));
        if (monitor < 0)
            return null;
        const mon = global.display.get_monitor_geometry(monitor);
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const edge = EDGE * sf;
        // Only the screen's outer edges: between two monitors the window just goes across.
        const open = dir => global.display.get_monitor_neighbor_index(monitor, dir) < 0;
        const D = Meta.DisplayDirection;
        const left = px <= mon.x + edge && open(D.LEFT), right = px >= mon.x + mon.width - 1 - edge && open(D.RIGHT);
        const top = py <= mon.y + edge && open(D.UP), bottom = py >= mon.y + mon.height - 1 - edge && open(D.DOWN);
        if (!left && !right && !top && !bottom)
            return null;
        const nearTop = py < mon.y + mon.height * CORNER, nearBottom = py > mon.y + mon.height * (1 - CORNER);
        const nearLeft = px < mon.x + mon.width * CORNER / 2, nearRight = px > mon.x + mon.width * (1 - CORNER / 2);
        let name = null;
        if ((left && nearTop) || (top && nearLeft))
            name = 'arriba-izquierda';
        else if ((right && nearTop) || (top && nearRight))
            name = 'arriba-derecha';
        else if ((left && nearBottom) || (bottom && nearLeft))
            name = 'abajo-izquierda';
        else if ((right && nearBottom) || (bottom && nearRight))
            name = 'abajo-derecha';
        else if (left)
            name = 'izquierda';
        else if (right)
            name = 'derecha';
        else if (top)
            name = 'maximizar';
        if (!name)
            return null;
        return {name, monitor, rect: this._rectOf(name, monitor)};
    }

    _rectOf(name, monitor) {
        const wa = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(monitor);
        const halfW = Math.floor(wa.width / 2), halfH = Math.floor(wa.height / 2);
        const x2 = wa.x + halfW, y2 = wa.y + halfH;
        const r = (x, y, width, height) => new Mtk.Rectangle({x, y, width, height});
        switch (name) {
        case 'izquierda': return r(wa.x, wa.y, halfW, wa.height);
        case 'derecha': return r(x2, wa.y, wa.width - halfW, wa.height);
        case 'arriba-izquierda': return r(wa.x, wa.y, halfW, halfH);
        case 'arriba-derecha': return r(x2, wa.y, wa.width - halfW, halfH);
        case 'abajo-izquierda': return r(wa.x, y2, halfW, wa.height - halfH);
        case 'abajo-derecha': return r(x2, y2, wa.width - halfW, wa.height - halfH);
        default: return r(wa.x, wa.y, wa.width, wa.height);
        }
    }

    // The soft shadow of where the window goes, under the window being dragged.
    _showShadow(zone) {
        if (!zone) {
            const shadow = this._shadow;
            this._shadow = null;
            shadow?.ease({opacity: 0, duration: ms(SHADOW_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => shadow.destroy()});
            return;
        }
        const {x, y, width, height} = zone.rect;
        const actor = this._drag?.window.get_compositor_private();
        if (!this._shadow) {
            this._shadow = new St.Widget({style_class: 'isla-acomodo-sombra', opacity: 0});
            global.window_group.add_child(this._shadow);
            // Born small at the pointer, it grows into place.
            const [px, py] = global.get_pointer();
            this._shadow.set_position(px, py);
            this._shadow.set_size(1, 1);
        }
        if (actor?.get_parent() === global.window_group)
            global.window_group.set_child_below_sibling(this._shadow, actor);
        this._shadow.remove_all_transitions();
        this._shadow.ease({x, y, width, height, opacity: 255, duration: ms(SHADOW_TIME),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _end(window) {
        const drag = this._drag;
        if (!drag || drag.window !== window)
            return;
        this._stopFollowing();
        const zone = drag.zone;
        this._showShadow(null);
        if (zone)
            this.tile(window, zone.name, zone.monitor);
    }

    _stopFollowing() {
        if (this._pollId)
            GLib.source_remove(this._pollId);
        this._pollId = 0;
        this._drag = null;
    }

    // ---------- putting a window in its place ----------
    tile(window, name, monitor = window.get_monitor()) {
        if (name === 'maximizar') {
            this._tiled.delete(window);
            maximize(window);
            return;
        }
        const rect = this._rectOf(name, monitor);
        const before = this._tiled.get(window);
        let r = window.get_frame_rect();
        if (maximized(window)) {
            // Its own size comes back later (async): dragged off, it gets two thirds of the screen.
            unmaximize(window);
            const wa = this._rectOf('maximizar', monitor);
            r = {width: Math.round(wa.width * 2 / 3), height: Math.round(wa.height * 2 / 3)};
        }
        // The size to go back to: the one before the first tile, not another tile's.
        this._tiled.set(window, {rect, width: before?.width ?? r.width, height: before?.height ?? r.height});
        if (!this._watched.has(window)) {
            this._watched.add(window);
            window.connectObject('unmanaged', () => {
                this._tiled.delete(window);
                this._watched.delete(window);
            }, this);
        }
        window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
        this._settle(window, name, monitor);
        if ((name === 'izquierda' || name === 'derecha') && this._settings.get_boolean(FILL))
            this._offerFill(window, name === 'izquierda' ? 'derecha' : 'izquierda', monitor);
    }

    // A window that cannot be that small (the Calculator, say) stays as small as it can, against
    // the zone's own corner and inside the screen; what it ended up with counts as its tile.
    _settle(window, name, monitor) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE, () => {
            this._settles.delete(id);
            const tile = this._tiled.get(window);
            if (!tile || this._drag?.window === window)
                return GLib.SOURCE_REMOVE;
            const want = tile.rect;
            const r = window.get_frame_rect();
            if (!sameRect(r, want)) {
                const wa = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(monitor);
                const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
                const x = clamp(name.includes('derecha') ? want.x + want.width - r.width : want.x, wa.x, wa.x + wa.width - r.width);
                const y = clamp(name.includes('abajo') ? want.y + want.height - r.height : want.y, wa.y, wa.y + wa.height - r.height);
                window.move_frame(true, x, y);
                tile.rect = new Mtk.Rectangle({x, y, width: r.width, height: r.height});
            }
            return GLib.SOURCE_REMOVE;
        });
        this._settles.add(id);
    }

    // ---------- filling the other half ----------
    _offerFill(placed, side, monitor) {
        const rect = this._rectOf(side, monitor);
        const ws = global.workspace_manager.get_active_workspace();
        const others = global.display.get_tab_list(Meta.TabList.NORMAL, ws)
            .filter(w => w !== placed && w.get_monitor() === monitor && !w.skip_taskbar);
        // Already filled by a tile: nothing to ask.
        if (!others.length || others.some(w => !w.minimized && this._isTiled(w) && sameRect(this._tiled.get(w).rect, rect)))
            return;
        this._openPicker(placed, side, monitor, rect, others.slice(0, PICK_MAX));
    }

    _openPicker(placed, side, monitor, rect, windows) {
        this._closePicker();
        const look = islandLook(this._state);
        const panel = new St.BoxLayout({style_class: 'isla-acomodo', orientation: Clutter.Orientation.VERTICAL,
            reactive: true, x: rect.x, y: rect.y, width: rect.width, height: rect.height});
        if (look.light)
            panel.add_style_class_name('clara');
        panel.add_child(new St.Label({style_class: 'isla-acomodo-titulo', text: _('¿Qué va en este lado?'),
            x_align: Clutter.ActorAlign.CENTER}));
        // Rows made by hand: Clutter.FlowLayout gave every card 0 px of height once they wrapped to a
        // second row (more than three windows), so a click fell on the panel and closed it.
        const flow = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 14px;',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true});
        const perRow = Math.max(1, Math.min(2, Math.floor((rect.width - 48 + CARD_GAP) / (TILE_W + CARD_GAP))));
        let row = null;
        panel.add_child(new St.Label({style_class: 'isla-acomodo-ayuda', text: _('Esc para dejarlo vacío'),
            x_align: Clutter.ActorAlign.CENTER}));
        panel.add_child(flow);
        const tracker = Shell.WindowTracker.get_default();
        let first = null;
        for (const w of windows) {
            // A colored tile: the app's icon, its name and the window's title, all centered.
            const app = tracker.get_window_app(w);
            const card = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'isla-acomodo-caja',
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true});
            const icon = app?.create_icon_texture(TILE_ICON) ??
                new St.Icon({icon_name: 'application-x-executable', icon_size: TILE_ICON});
            icon.x_align = Clutter.ActorAlign.CENTER;
            card.add_child(icon);
            const lines = [[app?.get_name() || w.get_title() || '', 'isla-acomodo-nombre'],
                [w.get_title() ?? '', 'isla-acomodo-titulo-ventana']];
            if (lines[1][0] === lines[0][0])
                lines.pop();
            for (const [text, style] of lines) {
                const label = new St.Label({style_class: style, text, x_align: Clutter.ActorAlign.CENTER});
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                label.style = `max-width: ${TILE_W - 40}px;`;
                card.add_child(label);
            }
            const button = new St.Button({style_class: 'isla-acomodo-ventana', child: card, can_focus: true,
                accessible_name: w.get_title() ?? '', height: TILE_H,
                style: `background-color: ${tileColor(app?.get_id() ?? w.get_wm_class() ?? '', look.light)};`});
            button.connect('clicked', () => {
                this._closePicker();
                if (w.minimized)
                    w.unminimize();
                this.tile(w, side, monitor);
                w.activate(global.get_current_time());
            });
            if (!row || row.get_n_children() === perRow) {
                row = new St.BoxLayout({style: `spacing: ${CARD_GAP}px;`, x_align: Clutter.ActorAlign.CENTER});
                flow.add_child(row);
            }
            row.add_child(button);
            first ??= button;
        }
        // Every tile as wide as a column; one left alone on the last row spans the whole row.
        for (const r of flow.get_children()) {
            const alone = r.get_n_children() === 1 && flow.get_n_children() > 1;
            r.get_children().forEach(b => (b.width = alone ? perRow * TILE_W + (perRow - 1) * CARD_GAP : TILE_W));
        }
        Main.layoutManager.uiGroup.add_child(panel);
        this._picker = panel;
        this._pickerFor = placed;
        this._pickerOwner = {};
        placed.connectObject('unmanaged', () => this._closePicker(), 'position-changed', () => {
            if (!this._drag && !this._isTiled(placed))
                this._closePicker();
        }, this._pickerOwner);
        this._grab = Main.pushModal(panel, {actionMode: Shell.ActionMode.POPUP});
        panel.connect('captured-event', (_a, event) => {
            const type = event.type();
            if ((type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) &&
                !flow.contains(global.stage.get_event_actor(event))) {
                this._closePicker();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        panel.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._closePicker();
            return Clutter.EVENT_STOP;
        });
        first?.grab_key_focus();
        panel.opacity = 0;
        panel.ease({opacity: 255, duration: ms(SHADOW_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _closePicker() {
        const panel = this._picker;
        if (!panel)
            return;
        this._picker = null;
        this._pickerFor?.disconnectObject(this._pickerOwner);
        this._pickerFor = this._pickerOwner = null;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        panel.reactive = false;
        panel.ease({opacity: 0, duration: ms(SHADOW_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => panel.destroy()});
    }

    destroy() {
        this._ids.forEach(id => global.display.disconnect(id));
        this._ids = [];
        this._stopFollowing();
        this._settles.forEach(id => GLib.source_remove(id));
        this._settles.clear();
        this._closePicker();
        this._shadow?.destroy();
        this._shadow = null;
        for (const w of this._watched)
            w.disconnectObject(this);
        this._watched.clear();
        this._tiled.clear();
        this._giveBackEdgeTiling();
    }
}
