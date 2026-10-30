// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Esquinas activas: each screen corner runs its own action, and each one can be
// switched on or off ('esquina-<corner>', action 'esquina-<corner>-accion',
// own command 'esquina-<corner>-comando'). Defaults: top left = Activities
// overview (as GNOME's own corner), top right = do not disturb, bottom left =
// terminal, bottom right = lock the screen.
// Corners are pressure barriers, as GNOME's hot corner: they work in the
// overview too and a brush against the edge does not fire them. Only outer
// corners get one: a corner touching another monitor would stop the pointer
// on its way there. GNOME's own hot corner ('enable-hot-corners') is switched
// off while this runs and back on after; 'esquinas-nativa-apagada' remembers
// it, so a Shell restart in between still gives it back.
// A quarter circle in the action's color flashes in the corner ('esquinas-destello');
// do not disturb also shows a small badge with just its icon.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {_} from './i18n.js';
import {dockLook} from './look.js';

export const CORNERS = ['sup-izq', 'sup-der', 'inf-izq', 'inf-der'];
const BARRIER_SIZE = 10;        // px of each barrier along the edge
const PRESSURE_TIMEOUT = 1000;  // ms to build up the pressure
const FLASH_SIZE = 150;         // logical px
const BADGE_SIZE = 64;          // logical px
const BADGE_ICON = 28;
const BADGE_TIME = 900;         // ms it stays before fading
const BADGE_GAP = 12;           // px between the badge and the dock

const COLORS = {
    overview: '#3584e4',
    apps: '#1c71d8',
    dnd: '#ff7800',
    terminal: '#26a269',
    desktop: '#e5a50a',
    lock: '#c061cb',
    command: '#9a9996',
};

// The first one installed is opened.
const TERMINALS = [
    'org.gnome.Ptyxis.desktop',
    'org.gnome.Console.desktop',
    'org.gnome.Terminal.desktop',
    'com.mitchellh.ghostty.desktop',
    'kitty.desktop',
    'Alacritty.desktop',
    'org.wezfurlong.wezterm.desktop',
    'org.kde.konsole.desktop',
    'xfce4-terminal.desktop',
    'tilix.desktop',
];

// Rebuild the barriers when one of these changes.
const KEYS = ['esquinas-presion', ...CORNERS.map(c => `esquina-${c}`)];

export class HotCorners {
    constructor({state, settings, title}) {
        this._state = state;
        this._settings = settings;
        this._title = title;
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._corners = [];
        this._flashes = new Set();
        this._hidden = [];
        this._idleId = 0;
        this._dragging = false;

        if (this._interface.get_boolean('enable-hot-corners')) {
            this._interface.set_boolean('enable-hot-corners', false);
            settings.set_boolean('esquinas-nativa-apagada', true);
        }

        this._ids = [
            ...KEYS.map(k => [settings, settings.connect(`changed::${k}`, () => this._rebuild())]),
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._rebuild())],
            // A window dragged to a corner (Acomodar ventanas) must not lock the screen.
            [global.display, global.display.connect('grab-op-begin', () => (this._dragging = true))],
            [global.display, global.display.connect('grab-op-end', () => (this._dragging = false))],
        ];
        this._rebuild();
    }

    _rebuild() {
        this._destroyCorners();
        const monitors = Main.layoutManager.monitors;
        monitors.forEach((monitor, index) => {
            for (const corner of CORNERS) {
                if (this._settings.get_boolean(`esquina-${corner}`) && this._isOuter(monitors, monitor, index, corner))
                    this._corners.push(this._makeCorner(corner, monitor));
            }
        });
    }

    _isOuter(monitors, monitor, index, corner) {
        const right = corner.endsWith('der');
        const bottom = corner.startsWith('inf');
        const px = right ? monitor.x + monitor.width - 1 : monitor.x;
        const py = bottom ? monitor.y + monitor.height - 1 : monitor.y;
        const inOther = (x, y) => monitors.some((m, i) =>
            i !== index && x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        return !inOther(right ? px + 1 : px - 1, py) && !inOther(px, bottom ? py + 1 : py - 1);
    }

    _barrier(params) {
        // GNOME 48+ takes the backend; 'display' is the older property.
        try {
            return new Meta.Barrier({backend: global.backend, ...params});
        } catch {
            return new Meta.Barrier({display: global.display, ...params});
        }
    }

    _makeCorner(corner, monitor) {
        const right = corner.endsWith('der');
        const bottom = corner.startsWith('inf');
        const x = right ? monitor.x + monitor.width : monitor.x;
        const y = bottom ? monitor.y + monitor.height : monitor.y;
        const barriers = [
            this._barrier({
                x1: x, x2: x,
                y1: bottom ? y - BARRIER_SIZE : y,
                y2: bottom ? y : y + BARRIER_SIZE,
                directions: right ? Meta.BarrierDirection.NEGATIVE_X : Meta.BarrierDirection.POSITIVE_X,
            }),
            this._barrier({
                x1: right ? x - BARRIER_SIZE : x,
                x2: right ? x : x + BARRIER_SIZE,
                y1: y, y2: y,
                directions: bottom ? Meta.BarrierDirection.NEGATIVE_Y : Meta.BarrierDirection.POSITIVE_Y,
            }),
        ];
        const pressure = new Layout.PressureBarrier(this._settings.get_int('esquinas-presion'), PRESSURE_TIMEOUT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        barriers.forEach(b => pressure.addBarrier(b));
        const data = {corner, monitor, right, bottom, pressure, barriers};
        data.triggerId = pressure.connect('trigger', () => this._onTrigger(data));
        return data;
    }

    _destroyCorners() {
        for (const {pressure, triggerId, barriers} of this._corners) {
            pressure.disconnect(triggerId);
            pressure.destroy();
            barriers.forEach(b => b.destroy());
        }
        this._corners = [];
    }

    _onTrigger(data) {
        const action = this._settings.get_string(`esquina-${data.corner}-accion`);
        if (action === 'none' || (this._dragging && action !== 'overview'))
            return;
        if (this._settings.get_boolean('esquinas-pantalla-completa') && data.monitor.inFullscreen && !Main.overview.visible)
            return;
        if (action === 'overview' && !Main.overview.shouldToggleByCornerOrButton())
            return;
        // Flash first and act outside the barrier's signal: locking the screen
        // switches the extension off and destroys the barriers.
        this._flash(data, action);
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            this._run(action, data);
            return GLib.SOURCE_REMOVE;
        });
    }

    _run(action, data) {
        switch (action) {
        case 'overview':
            Main.overview.toggle();
            break;
        case 'apps':
            // As the dock's Aplicaciones button: the Lanzador Isla, or GNOME's app grid.
            this._state.command('apps-open');
            break;
        case 'dnd':
            // Through the island's own do not disturb, so the island shows it.
            this._state.command('toggle-dnd');
            this._badge(data.monitor, this._state.dnd ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic',
                this._state.dnd ? _('No molestar activado') : _('No molestar desactivado'));
            break;
        case 'terminal':
            this._openTerminal();
            break;
        case 'desktop':
            this._toggleDesktop();
            break;
        case 'lock':
            if (Main.screenShield)
                Main.screenShield.lock(true);
            else
                Util.spawn(['loginctl', 'lock-session']);
            break;
        case 'command': {
            const line = this._settings.get_string(`esquina-${data.corner}-comando`).trim();
            if (line)
                Util.spawnCommandLine(line);
            else
                Main.notify(this._title, _('Esta esquina no tiene un comando configurado.'));
            break;
        }
        }
    }

    _openTerminal() {
        const apps = Shell.AppSystem.get_default();
        const app = TERMINALS.map(id => apps.lookup_app(id)).find(Boolean);
        if (!app) {
            Main.notify(this._title, _('No se encontró una terminal instalada. Puedes usar «Comando propio» en su lugar.'));
            return;
        }
        app.open_new_window(-1);
        Main.overview.hide();
    }

    // Minimizes the windows of this workspace; the next time puts the same ones back.
    _toggleDesktop() {
        Main.overview.hide();
        const windows = global.workspace_manager.get_active_workspace().list_windows();
        const shown = windows.filter(w => !w.minimized && !w.skip_taskbar && w.get_window_type() === Meta.WindowType.NORMAL);
        if (shown.length) {
            this._hidden = shown;
            shown.forEach(w => w.minimize());
        } else {
            this._hidden.filter(w => windows.includes(w)).forEach(w => w.unminimize());
            this._hidden = [];
        }
    }

    // A small circle in the dock's color with only the icon (no text), centered just above
    // the dock (as the calendar panel); the label is for screen readers.
    _badge(monitor, iconName, label) {
        this._badgeActor?.destroy();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const size = BADGE_SIZE * scale;
        const look = dockLook(this._state);
        // Over the dock when it is on screen; otherwise near the bottom of the corner's monitor.
        let center = monitor.x + monitor.width / 2;
        let top = monitor.y + monitor.height - BADGE_GAP * scale;
        const dock = this._state.skin?.isla?._bg;
        if (dock?.get_stage() && dock.visible) {
            const [dx, dy] = dock.get_transformed_position();
            const [dw] = dock.get_transformed_size();
            const area = Main.layoutManager.monitors.find(m => dx >= m.x && dx < m.x + m.width) ?? monitor;
            center = dx + dw / 2;
            // A hidden dock sits below the screen: then from the bottom edge.
            top = Math.min(dy, area.y + area.height);
        }
        const badge = new St.Bin({
            style: `${look.style} border-width: 1px; border-style: solid; border-radius: ${size / 2}px;`,
            width: size,
            height: size,
            x: Math.round(center - size / 2),
            y: Math.round(top - BADGE_GAP * scale - size),
            opacity: 0,
            scale_x: 0.8,
            scale_y: 0.8,
            reactive: false,
            accessible_name: label,
            child: new St.Icon({
                icon_name: iconName,
                icon_size: BADGE_ICON,
                style: `color: ${look.light ? '#1e1e1e' : '#ffffff'};`,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });
        badge.set_pivot_point(0.5, 0.5);
        Main.uiGroup.add_child(badge);
        this._badgeActor = badge;
        badge.connect('destroy', () => {
            if (this._badgeActor === badge)
                this._badgeActor = null;
        });
        badge.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => badge.ease({
                opacity: 0,
                delay: BADGE_TIME,
                duration: 260,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => badge.destroy(),
            }),
        });
    }

    _flash(data, action) {
        if (!this._settings.get_boolean('esquinas-destello'))
            return;
        const size = FLASH_SIZE * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const m = data.monitor;
        // The corner away from the screen's is the round one. St order: top left, top right, bottom right, bottom left.
        const radius = {
            'sup-izq': `0 0 ${size}px 0`,
            'sup-der': `0 0 0 ${size}px`,
            'inf-izq': `0 ${size}px 0 0`,
            'inf-der': `${size}px 0 0 0`,
        }[data.corner];
        const flash = new St.Widget({
            style: `background-color: ${COLORS[action] ?? '#ffffff'}; border-radius: ${radius};`,
            width: size,
            height: size,
            x: data.right ? m.x + m.width - size : m.x,
            y: data.bottom ? m.y + m.height - size : m.y,
            opacity: 0,
            scale_x: 0.3,
            scale_y: 0.3,
            reactive: false,
        });
        flash.set_pivot_point(data.right ? 1 : 0, data.bottom ? 1 : 0);
        Main.uiGroup.add_child(flash);
        this._flashes.add(flash);
        flash.connect('destroy', () => this._flashes?.delete(flash));
        flash.ease({
            opacity: 210,
            scale_x: 1,
            scale_y: 1,
            duration: 170,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => flash.ease({
                opacity: 0,
                duration: 380,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => flash.destroy(),
            }),
        });
    }

    destroy() {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
        this._destroyCorners();
        [...this._flashes].forEach(f => f.destroy());
        this._flashes = null;
        this._badgeActor?.destroy();
        this._hidden = [];
        if (this._settings.get_boolean('esquinas-nativa-apagada')) {
            this._interface.set_boolean('enable-hot-corners', true);
            this._settings.set_boolean('esquinas-nativa-apagada', false);
        }
        this._interface = null;
    }
}
