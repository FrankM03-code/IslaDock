// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Calendario y notificaciones: with the top bar hidden, GNOME's date menu
// (recent notifications with their "Limpiar" button and per-notification ×,
// the month calendar, the day's events, world clocks and weather) cannot be
// opened. Its content is lent to a panel shaped like the island and given
// back when it closes, so it is GNOME's own and always up to date.
// It opens from the side clock (click) or with Super+M ('atajo-calendario'),
// which GNOME uses for the same thing ('toggle-message-tray'): while this runs
// that binding gives it up and gets it back after ('calendario-liberado').
// The panel stands by the side clock's edge, centered in height. Over a light
// island it keeps GNOME's dark colors, which its calendar and messages need.
//
// Commands it listens to: 'calendar-toggle' (anchor actor or nothing).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';

import {dressFrame, islandLook} from './look.js';
import {ms} from './timing.js';

const KEY = 'atajo-calendario';
const KEPT = 'calendario-liberado';
const TRAY_SCHEMA = 'org.gnome.shell.keybindings';
const TRAY_KEY = 'toggle-message-tray';
const RADIUS = 26;
const GAP = 14;            // from the screen edge
const IN_TIME = 220;
const OUT_TIME = 140;
const SHIFT = 16;
const DARK = 'background-color: rgba(30, 30, 34, 0.94); border-color: rgba(255, 255, 255, 0.10);';

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

export class CalendarPanel {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._panel = null;
        this._commandId = state.connect('command', (_s, name, ...args) => {
            if (name === 'calendar-toggle')
                this.toggle(args[0] ?? null);
        });
        this._overviewId = Main.overview.connect('showing', () => this.close(false));
        this._freeShortcut();
        Main.wm.addKeybinding(KEY, settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => {
                Main.overview.hide();
                this.toggle(null);
            });
    }

    // ---------- Super+M, lent by GNOME ----------
    _freeShortcut() {
        try {
            this._tray = new Gio.Settings({schema_id: TRAY_SCHEMA});
        } catch {
            this._tray = null;
            return;
        }
        const ours = this._settings.get_strv(KEY);
        const current = this._tray.get_strv(TRAY_KEY);
        const taken = current.filter(a => ours.some(b => same(a, b)));
        if (!taken.length)
            return;
        const kept = this._settings.get_strv(KEPT);
        this._settings.set_strv(KEPT, [...new Set([...kept, ...taken])]);
        this._tray.set_strv(TRAY_KEY, current.filter(a => !taken.includes(a)));
    }

    _giveBackShortcut() {
        const taken = this._settings.get_strv(KEPT);
        if (!this._tray || !taken.length)
            return;
        const current = this._tray.get_strv(TRAY_KEY);
        const missing = taken.filter(a => !current.some(b => same(a, b)));
        if (missing.length)
            this._tray.set_strv(TRAY_KEY, [...current, ...missing]);
        this._settings.set_strv(KEPT, []);
    }

    // ---------- content ----------
    // GNOME's calendar area (borrowed), or a calendar and a message list of our own.
    _takeContent() {
        const dateMenu = Main.panel?.statusArea?.dateMenu;
        const area = dateMenu?.menu?.box?.get_first_child()?.get_first_child();
        if (area && area.name === 'calendarArea') {
            dateMenu.menu.close();
            this._lent = {area, parent: area.get_parent(), dateMenu};
            this._lent.parent.remove_child(area);
            // What the date menu does each time it opens: today selected.
            const now = new Date();
            dateMenu._calendar?.setDate(now);
            dateMenu._date?.setDate(now);
            dateMenu._eventsItem?.setDate(now);
            return area;
        }
        const box = new St.BoxLayout({name: 'calendarArea'});
        this._ownList = new Calendar.CalendarMessageList();
        this._ownCalendar = new Calendar.Calendar();
        this._ownCalendar.setEventSource(new Calendar.EmptyEventSource());
        this._ownCalendar.setDate(new Date());
        box.add_child(this._ownList);
        box.add_child(this._ownCalendar);
        return box;
    }

    _giveBackContent() {
        if (this._lent) {
            const {area, parent} = this._lent;
            area.get_parent()?.remove_child(area);
            parent.add_child(area);
            this._lent = null;
        }
        this._ownList = this._ownCalendar = null;
    }

    // ---------- open / close ----------
    toggle(anchor) {
        if (this._panel)
            this.close();
        else
            this.open(anchor);
    }

    open(anchor) {
        if (this._panel)
            return;
        // Still leaving: done now, so its content is back before it is lent again.
        this._finishClosing?.();
        const content = new St.BoxLayout({style_class: 'isla-calendario', reactive: true});
        content.add_child(this._takeContent());
        const look = islandLook(this._state);
        if (look.light)
            content.style = DARK;
        else if (look.style)
            content.style = look.style;
        const panel = this._panel = new St.Widget({layout_manager: new Clutter.BinLayout(), reactive: true});
        dressFrame(look.light ? {...look, blur: null, style: DARK} : look, panel, content, RADIUS);
        Main.layoutManager.addTopChrome(panel);
        this._place(anchor);
        panel.connect('captured-event', (_a, event) => this._onEvent(event));
        panel.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._grab = Main.pushModal(panel, {actionMode: Shell.ActionMode.POPUP});
        // Over a maximized window drawn straight to the screen (X11).
        global.compositor.disable_unredirect();
        panel.set({opacity: 0, translation_x: this._fromRight ? SHIFT : -SHIFT});
        panel.ease({opacity: 255, translation_x: 0, duration: ms(IN_TIME), mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }

    // Next to the side clock's edge, centered in height, inside the work area.
    _place(anchor) {
        const panel = this._panel;
        const mon = Main.layoutManager.primaryMonitor;
        const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [, w] = panel.get_preferred_width(-1);
        const [, h] = panel.get_preferred_height(w);
        this._fromRight = this._settings.get_string('reloj-lateral-borde') !== 'izquierdo';
        let x = this._fromRight ? mon.x + mon.width - w - GAP * sf : mon.x + GAP * sf;
        if (anchor?.get_stage()) {
            const [ax] = anchor.get_transformed_position();
            const [aw] = anchor.get_transformed_size();
            x = this._fromRight ? ax - w - GAP * sf : ax + aw + GAP * sf;
        }
        x = Math.min(Math.max(x, area.x), area.x + area.width - w);
        const y = Math.min(Math.max(mon.y + (mon.height - h) / 2, area.y), area.y + area.height - h);
        panel.set_position(Math.round(x), Math.round(y));
    }

    _onEvent(event) {
        // GNOME folds an open group of notifications when clicking elsewhere.
        const list = this._lent?.dateMenu?._messageList ?? this._ownList;
        if (list?.maybeCollapseMessageGroupForEvent?.(event))
            return Clutter.EVENT_STOP;
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        if (this._panel.contains(global.stage.get_event_actor(event)))
            return Clutter.EVENT_PROPAGATE;
        this.close();
        return Clutter.EVENT_STOP;
    }

    get isOpen() {
        return !!this._panel;
    }

    close(animate = true) {
        const panel = this._panel;
        if (!panel)
            return;
        this._panel = null;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        global.compositor.enable_unredirect();
        panel.reactive = false;
        const done = () => {
            if (this._finishClosing !== done)
                return;
            this._finishClosing = null;
            panel.remove_all_transitions();
            this._giveBackContent();
            Main.layoutManager.removeChrome(panel);
            panel.destroy();
        };
        this._finishClosing = done;
        if (animate) {
            panel.ease({opacity: 0, translation_x: this._fromRight ? SHIFT : -SHIFT, duration: ms(OUT_TIME),
                mode: Clutter.AnimationMode.EASE_IN_QUAD, onStopped: done});
        } else {
            done();
        }
    }

    destroy() {
        this.close(false);
        this._state.disconnect(this._commandId);
        Main.overview.disconnect(this._overviewId);
        Main.wm.removeKeybinding(KEY);
        this._giveBackShortcut();
    }
}
