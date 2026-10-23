// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Reloj lateral: a bubble hidden at the middle of the right (or left) edge,
// for when maximized windows cover the desktop clock. At rest only a thin
// mark shows on the edge; the pointer on the edge slides the bubble out
// (300 ms, ease-out) and it goes back 600 ms after the pointer leaves it.
// Three looks ('reloj-lateral-estilo'): texto (no background, a line joins it
// to the edge), pildora (a dark see-through capsule, one line) and pestana
// (a narrow tab on the edge, the time stacked). A click opens the calendar
// panel ('calendar-toggle') when 'reloj-lateral-calendario' is on.
// The sensitive strip is only a few pixels wide: the screen edge stops the
// pointer, and the scroll bars of maximized windows stay usable.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {chromeParams} from './chrome.js';
import {ms} from './timing.js';

const KEYS = ['reloj-lateral-estilo', 'reloj-lateral-borde', 'reloj-lateral-segundos'];
const DAYS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const ZONE_WIDTH = 4;      // px of edge that wake it
const ZONE_HEIGHT = 160;
const MARK_WIDTH = 3;
const MARK_HEIGHT = 46;
const IN_TIME = 300;
const OUT_TIME = 220;
const LEAVE_DELAY = 600;
const GAP = 10;            // between the bubble and the edge (pildora)

export class SideClock {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._wallClock = new GnomeDesktop.WallClock({time_only: true});
        this._clockId = this._wallClock.connect('notify::clock', () => this._update());
        this._formatId = this._interface.connect('changed::clock-format', () => this._update());
        this._settingIds = KEYS.map(key => settings.connect(`changed::${key}`, () => this._build()));
        this._zone = null;
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._place());
        this._build();
    }

    get _right() {
        return this._settings.get_string('reloj-lateral-borde') !== 'izquierdo';
    }

    // ---------- actors ----------
    // The edge strip (wakes the bubble, carries the mark) and the bubble are
    // made once; a change of look only swaps the bubble's content.
    _makeActors() {
        this._zone = new St.Widget({name: 'IslaRelojLateralZona', reactive: true, track_hover: true,
            layout_manager: new Clutter.BinLayout()});
        this._mark = new St.Widget({style_class: 'isla-rl-marca', y_align: Clutter.ActorAlign.CENTER});
        this._zone.add_child(this._mark);
        this._zone.connect('notify::hover', () => this._onHover());

        this._bubble = new St.Button({reactive: true, track_hover: true, can_focus: false, accessible_name: 'Reloj'});
        this._bubble.connect('notify::hover', () => this._onHover());
        this._bubble.connect('clicked', () => {
            if (!this._settings.get_boolean('reloj-lateral-calendario'))
                return;
            this._state.command('calendar-toggle', this._bubble);
            this._hide();
        });
        Main.layoutManager.addTopChrome(this._zone, chromeParams({affectsInputRegion: true, trackFullscreen: true}));
        // Not trackFullscreen: GNOME would show it by itself. The zone is, so no bubble over a fullscreen app.
        Main.layoutManager.addTopChrome(this._bubble, chromeParams({affectsInputRegion: true}));
    }

    _build() {
        if (!this._zone)
            this._makeActors();
        this._cancelLeave();
        this._stopTick();
        if (this._shown)
            global.compositor.enable_unredirect();
        this._shown = false;
        const style = this._settings.get_string('reloj-lateral-estilo');
        this._style = ['texto', 'pildora', 'pestana'].includes(style) ? style : 'pildora';
        this._mark.x_align = this._right ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
        this._mark.remove_all_transitions();
        this._mark.opacity = 255;
        this._bubble.style_class = `isla-rl isla-rl-${this._style} ${this._right ? 'derecha' : 'izquierda'}`;
        this._bubble.set_child(this._content());
        this._update();
        this._place();
        // Out of sight until the pointer comes (adding it to the stage showed it).
        this._bubble.remove_all_transitions();
        this._bubble.set({translation_x: this._outside, opacity: 0});
        this._bubble.hide();
    }

    _label(cls) {
        const label = new St.Label({style_class: cls});
        label.clutter_text.ellipsize = 0;
        return label;
    }

    _content() {
        const align = this._right ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
        this._parts = {};
        if (this._style === 'pildora') {
            const box = new St.BoxLayout({style_class: 'isla-rl-fila'});
            this._parts.time = this._label('isla-rl-hora');
            this._parts.dot = this._label('isla-rl-punto');
            this._parts.dot.text = '·';
            this._parts.date = this._label('isla-rl-fecha');
            for (const a of [this._parts.time, this._parts.dot, this._parts.date]) {
                a.y_align = Clutter.ActorAlign.CENTER;
                box.add_child(a);
            }
            return box;
        }
        if (this._style === 'pestana') {
            const box = new St.BoxLayout({style_class: 'isla-rl-columna', orientation: Clutter.Orientation.VERTICAL});
            this._parts.hours = this._label('isla-rl-hora');
            this._parts.minutes = this._label('isla-rl-hora');
            this._parts.seconds = this._label('isla-rl-segundos');
            this._parts.day = this._label('isla-rl-dia');
            for (const a of [this._parts.hours, this._parts.minutes, this._parts.seconds, this._parts.day]) {
                a.x_align = Clutter.ActorAlign.CENTER;
                box.add_child(a);
            }
            return box;
        }
        // texto: the time over the date, and a line that joins them to the edge.
        const row = new St.BoxLayout({style_class: 'isla-rl-fila'});
        const texts = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER});
        this._parts.time = this._label('isla-rl-hora');
        this._parts.date = this._label('isla-rl-fecha');
        for (const a of [this._parts.time, this._parts.date]) {
            a.x_align = align;
            texts.add_child(a);
        }
        const line = new St.Widget({style_class: 'isla-rl-linea', y_align: Clutter.ActorAlign.CENTER});
        if (this._right) {
            row.add_child(texts);
            row.add_child(line);
        } else {
            row.add_child(line);
            row.add_child(texts);
        }
        return row;
    }

    // ---------- time ----------
    _update() {
        if (!this._parts)
            return;
        const now = GLib.DateTime.new_now_local();
        const h24 = this._interface.get_string('clock-format') !== '12h';
        const seconds = this._settings.get_boolean('reloj-lateral-segundos');
        let hours = now.get_hour();
        const ampm = hours < 12 ? 'a. m.' : 'p. m.';
        if (!h24)
            hours = hours % 12 || 12;
        const hh = h24 ? String(hours).padStart(2, '0') : String(hours);
        const mm = String(now.get_minute()).padStart(2, '0');
        const ss = String(now.get_second()).padStart(2, '0');
        const time = `${hh}:${mm}${seconds ? `:${ss}` : ''}${h24 ? '' : ` ${ampm}`}`;
        const day = DAYS[now.get_day_of_week() - 1];
        const date = `${day} ${now.get_day_of_month()} ${MONTHS[now.get_month() - 1]}`;
        const p = this._parts;
        if (this._style === 'pildora') {
            p.time.text = time;
            p.date.text = date;
        } else if (this._style === 'pestana') {
            p.hours.text = hh;
            p.minutes.text = mm;
            p.seconds.text = seconds ? ss : '';
            p.seconds.visible = seconds;
            p.day.text = `${day}${h24 ? '' : `\n${ampm}`}`.toUpperCase();
        } else {
            p.time.text = time;
            p.date.text = date.toUpperCase();
        }
        this._bubble.accessible_name = `${time}, ${date}`;
        // Seconds tick only while the bubble is out.
        if (this._shown && seconds)
            this._tickSoon();
    }

    _tickSoon() {
        if (this._tick)
            return;
        const wait = 1000 - Math.floor(GLib.get_real_time() / 1000) % 1000;
        this._tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
            this._tick = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopTick() {
        if (this._tick)
            GLib.source_remove(this._tick);
        this._tick = 0;
    }

    // ---------- place ----------
    _place() {
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon || !this._zone)
            return;
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const zw = ZONE_WIDTH * sf;
        const zh = ZONE_HEIGHT * sf;
        const zx = this._right ? mon.x + mon.width - zw : mon.x;
        this._zone.set_position(zx, Math.round(mon.y + (mon.height - zh) / 2));
        this._zone.set_size(zw, zh);
        this._mark.set_size(MARK_WIDTH * sf, MARK_HEIGHT * sf);
        const [, w] = this._bubble.get_preferred_width(-1);
        const [, h] = this._bubble.get_preferred_height(w);
        const gap = this._style === 'pildora' ? GAP * sf : 0;
        const x = this._right ? mon.x + mon.width - w - gap : mon.x + gap;
        this._bubble.set_position(Math.round(x), Math.round(mon.y + (mon.height - h) / 2));
        this._outside = (w + gap) * (this._right ? 1 : -1);
    }

    // ---------- show / hide ----------
    _onHover() {
        if (this._zone.hover || this._bubble.hover) {
            this._cancelLeave();
            this._show();
        } else if (this._shown && !this._leave) {
            this._leave = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms(LEAVE_DELAY), () => {
                this._leave = 0;
                this._hide();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _cancelLeave() {
        if (this._leave)
            GLib.source_remove(this._leave);
        this._leave = 0;
    }

    _show() {
        if (this._shown)
            return;
        this._shown = true;
        // Over a maximized window drawn straight to the screen (X11).
        global.compositor.disable_unredirect();
        this._update();
        this._bubble.show();
        this._place();
        this._bubble.ease({translation_x: 0, opacity: 255, duration: ms(IN_TIME), mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        this._mark.ease({opacity: 0, duration: ms(IN_TIME)});
    }

    _hide() {
        this._cancelLeave();
        if (!this._shown)
            return;
        this._shown = false;
        this._stopTick();
        global.compositor.enable_unredirect();
        this._bubble.ease({translation_x: this._outside, opacity: 0, duration: ms(OUT_TIME),
            mode: Clutter.AnimationMode.EASE_IN_CUBIC, onStopped: done => done && this._bubble.hide()});
        this._mark.ease({opacity: 255, duration: ms(OUT_TIME)});
    }

    destroy() {
        this._cancelLeave();
        this._stopTick();
        if (this._shown)
            global.compositor.enable_unredirect();
        this._shown = false;
        for (const actor of [this._zone, this._bubble]) {
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
        this._zone = this._bubble = this._mark = null;
        this._parts = null;
        this._wallClock.disconnect(this._clockId);
        this._wallClock = null;
        this._interface.disconnect(this._formatId);
        this._settingIds.forEach(id => this._settings.disconnect(id));
        Main.layoutManager.disconnect(this._monitorsId);
    }
}
