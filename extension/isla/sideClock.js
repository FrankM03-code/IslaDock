// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Reloj lateral: a bubble hidden at the middle of the right (or left) edge,
// for when maximized windows cover the desktop clock. At rest only a thin
// mark shows on the edge; the pointer on the edge slides the bubble out
// (300 ms, ease-out) and it goes back 600 ms after the pointer leaves it.
// Four looks ('clock-style', isla-dock-reloj-estilos.md), 24 h, orange accent:
//   editorial  no box: hour and minutes huge and stacked, the day in orange, a bar on the edge
//   semana     a glass tab with the time and this week, today in an orange pill
//   linea      a tab with a vertical line of the day (00:00 at the top, 24:00 at the bottom)
//   horizonte  no box: the time on one line, under it a line of the day with an orange dot
// It refreshes on the wall clock's minute change (also right after a suspend
// and at midnight). A click opens the calendar panel ('calendar-toggle') when
// 'reloj-lateral-calendario' is on.
// The sensitive strip is only a few pixels wide: the screen edge stops the
// pointer, and the scroll bars of maximized windows stay usable.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {chromeParams} from './chrome.js';
import {ms} from './timing.js';
import {_} from './i18n.js';
import {dayName, dayProgress, dayShort, initials, monthName, monthShort, two, week} from './dates.js';

const KEYS = ['clock-style', 'reloj-lateral-borde'];
export const CLOCK_STYLES = ['editorial', 'semana', 'linea', 'horizonte'];
const CORAL = [1, 0x8a / 255, 0x4c / 255];

const ZONE_WIDTH = 4;      // px of edge that wake it
const ZONE_HEIGHT = 160;
const MARK_WIDTH = 3;
const MARK_HEIGHT = 46;
const EDITORIAL_TIGHT = 16;   // px the minutes go up under the hour (Editorial)
const IN_TIME = 300;
const OUT_TIME = 220;
const LEAVE_DELAY = 600;

export class SideClock {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._wallClock = new GnomeDesktop.WallClock({time_only: true});
        this._clockId = this._wallClock.connect('notify::clock', () => this._update());
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

        this._bubble = new St.Button({reactive: true, track_hover: true, can_focus: false, accessible_name: _('Reloj')});
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
        if (this._shown)
            global.compositor.enable_unredirect();
        this._shown = false;
        const style = this._settings.get_string('clock-style');
        this._style = CLOCK_STYLES.includes(style) ? style : 'editorial';
        this._mark.x_align = this._right ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
        this._mark.remove_all_transitions();
        this._mark.opacity = 255;
        const tab = this._style === 'semana' || this._style === 'linea' ? ' isla-clock-tab' : '';
        this._bubble.style_class = `isla-clock clock-${this._style}${tab} ${this._right ? 'derecha' : 'izquierda'}`;
        this._parts = {};
        this._bubble.set_child({editorial: () => this._buildEditorial(), semana: () => this._buildSemana(),
            linea: () => this._buildLinea(), horizonte: () => this._buildHorizonte()}[this._style]());
        this._update();
        this._place();
        // Out of sight until the pointer comes (adding it to the stage showed it).
        this._bubble.remove_all_transitions();
        this._bubble.set({translation_x: this._outside, opacity: 0});
        this._bubble.hide();
    }

    _label(cls, props = {}) {
        const label = new St.Label({style_class: cls, ...props});
        label.clutter_text.ellipsize = 0;
        return label;
    }

    // Hours, an orange colon and softer minutes: three labels in a row.
    _time(props = {}) {
        const box = new St.BoxLayout({style_class: 'isla-clock-time', ...props});
        this._parts.hour = this._label('isla-clock-hour', {y_align: Clutter.ActorAlign.END});
        this._parts.min = this._label('isla-clock-min', {y_align: Clutter.ActorAlign.END});
        box.add_child(this._parts.hour);
        box.add_child(this._label('isla-clock-colon', {text: ':', y_align: Clutter.ActorAlign.END}));
        box.add_child(this._parts.min);
        return box;
    }

    get _side() {
        return this._right ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
    }

    // Hour over minutes, huge; the day in orange; a short bar against the screen edge.
    _buildEditorial() {
        const row = new St.BoxLayout({style_class: 'isla-clock-fila'});
        const texts = new St.BoxLayout({style_class: 'isla-clock-bloque', orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER});
        this._parts.hour = this._label('isla-clock-hour', {x_align: this._side});
        this._parts.min = this._label('isla-clock-min', {x_align: this._side});
        this._parts.date = this._label('isla-clock-date', {x_align: this._side});
        for (const a of [this._parts.hour, this._parts.min, this._parts.date])
            texts.add_child(a);
        // Tight lines: the minutes (and the day) pulled up under the hour. A negative margin
        // would break the box's height, so they are moved instead.
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._parts.min.translation_y = this._parts.date.translation_y = -EDITORIAL_TIGHT * sf;
        const edge = new St.Widget({style_class: 'isla-clock-edge', y_align: Clutter.ActorAlign.CENTER});
        if (this._right) {
            row.add_child(texts);
            row.add_child(edge);
        } else {
            row.add_child(edge);
            row.add_child(texts);
        }
        return row;
    }

    // The time and the month; under them this week, today in an orange pill.
    _buildSemana() {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        const head = new St.BoxLayout({style_class: 'isla-clock-head'});
        head.add_child(this._time());
        this._parts.month = this._label('isla-clock-month', {y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this._parts.month);
        box.add_child(head);
        const strip = new St.BoxLayout({style_class: 'isla-week'});
        this._parts.week = initials().map(letter => {
            const day = new St.BoxLayout({style_class: 'isla-week-day', orientation: Clutter.Orientation.VERTICAL});
            day.add_child(this._label('isla-week-initial', {text: letter, x_align: Clutter.ActorAlign.CENTER}));
            const number = this._label('isla-week-num', {x_align: Clutter.ActorAlign.CENTER});
            day.add_child(number);
            strip.add_child(day);
            return {day, number};
        });
        box.add_child(strip);
        return box;
    }

    // A vertical line of the day: orange down to now, a dot there; 00:00 above, 24:00 below.
    _buildLinea() {
        const row = new St.BoxLayout({style_class: 'isla-clock-fila'});
        const line = new St.DrawingArea({style_class: 'isla-day-line', y_expand: true});
        line.connect('repaint', area => this._drawLine(area, true));
        this._parts.line = line;
        const column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        column.add_child(this._label('isla-clock-edge-label', {text: '00:00'}));
        const middle = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_expand: true,
            y_align: Clutter.ActorAlign.CENTER, style_class: 'isla-clock-centro'});
        middle.add_child(this._time());
        this._parts.date = this._label('isla-clock-date');
        middle.add_child(this._parts.date);
        column.add_child(middle);
        column.add_child(this._label('isla-clock-edge-label', {text: '24:00'}));
        if (this._right) {
            row.add_child(line);
            row.add_child(column);
        } else {
            row.add_child(column);
            row.add_child(line);
        }
        return row;
    }

    // The time on one line; under it the day as a line with an orange dot; 00, the date and 24 below.
    _buildHorizonte() {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        box.add_child(this._time({x_align: Clutter.ActorAlign.END}));
        const line = new St.DrawingArea({style_class: 'isla-day-line'});
        line.connect('repaint', area => this._drawLine(area, false));
        this._parts.line = line;
        box.add_child(line);
        const labels = new St.BoxLayout({style_class: 'isla-clock-pie'});
        labels.add_child(this._label('isla-clock-edge-label', {text: '00'}));
        this._parts.date = this._label('isla-clock-date', {x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        labels.add_child(this._parts.date);
        labels.add_child(this._label('isla-clock-edge-label', {text: '24'}));
        box.add_child(labels);
        return box;
    }

    // The day's line: a 4 px track, orange up to now and a 12 px orange dot with a dark edge.
    _drawLine(area, vertical) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const p = this._progress ?? 0;
        const r = 6 * sf, t = 4 * sf;
        const [x0, y0, x1, y1] = vertical ? [w / 2, r, w / 2, h - r] : [r, h / 2, w - r, h / 2];
        const [px, py] = [x0 + (x1 - x0) * p, y0 + (y1 - y0) * p];
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(t);
        cr.setSourceRGBA(1, 1, 1, vertical ? 0.12 : 0.15);
        cr.moveTo(x0, y0);
        cr.lineTo(x1, y1);
        cr.stroke();
        cr.setSourceRGB(...CORAL);
        cr.moveTo(x0, y0);
        cr.lineTo(px, py);
        cr.stroke();
        cr.arc(px, py, r - sf, 0, 2 * Math.PI);
        cr.setSourceRGB(...CORAL);
        cr.fillPreserve();
        cr.setLineWidth(2 * sf);
        if (vertical)
            cr.setSourceRGB(0x1a / 255, 0x22 / 255, 0x33 / 255);
        else
            cr.setSourceRGBA(0, 0, 0, 0.35);
        cr.stroke();
        cr.$dispose();
    }

    // ---------- time ----------
    _update() {
        if (!this._parts)
            return;
        const now = GLib.DateTime.new_now_local();
        const p = this._parts;
        const hh = two(now.get_hour()), mm = two(now.get_minute());
        if (p.hour)
            p.hour.text = hh;
        if (p.min)
            p.min.text = mm;
        this._progress = dayProgress(now);
        if (this._style === 'editorial')
            p.date.text = `${dayName(now)} ${now.get_day_of_month()}`.toUpperCase();
        else if (this._style === 'linea')
            p.date.text = `${dayShort(now)} ${now.get_day_of_month()} ${monthShort(now)}`;
        else if (this._style === 'horizonte')
            p.date.text = `${dayShort(now)} ${now.get_day_of_month()} ${monthShort(now)}`.toUpperCase();
        if (p.month)
            p.month.text = monthName(now);
        const days = week(now);
        p.week?.forEach(({day, number}, i) => {
            const d = days[i];
            number.text = String(d.date.get_day_of_month());
            if (d.today)
                day.add_style_class_name('today');
            else
                day.remove_style_class_name('today');
        });
        p.line?.queue_repaint();
        this._bubble.accessible_name = `${hh}:${mm}, ${dayName(now)} ${now.get_day_of_month()} ${monthName(now)}`;
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
        const x = this._right ? mon.x + mon.width - w : mon.x;
        this._bubble.set_position(Math.round(x), Math.round(mon.y + (mon.height - h) / 2));
        this._outside = w * (this._right ? 1 : -1);
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
        global.compositor.enable_unredirect();
        this._bubble.ease({translation_x: this._outside, opacity: 0, duration: ms(OUT_TIME),
            mode: Clutter.AnimationMode.EASE_IN_CUBIC, onStopped: done => done && this._bubble.hide()});
        this._mark.ease({opacity: 255, duration: ms(OUT_TIME)});
    }

    destroy() {
        this._cancelLeave();
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
        this._settingIds.forEach(id => this._settings.disconnect(id));
        Main.layoutManager.disconnect(this._monitorsId);
    }
}
