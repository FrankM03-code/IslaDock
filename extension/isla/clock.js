// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Reloj de escritorio: the time and date drawn on the wallpaper, Conky style.
// It lives in the background group (under every window, hidden with the
// overview and the lock screen), lets clicks through, and ticks on the wall
// clock's minute change, so it stays right after a suspend.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const LETTERS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre',
    'octubre', 'noviembre', 'diciembre'];

const KEYS = ['reloj-estilo', 'reloj-tamano', 'reloj-monitor', 'reloj-desplazamiento', 'reloj-posicion'];

// 'abajo' leaves this much of the height free under the clock, for the dock.
const BOTTOM_ROOM = 0.12;

const capital = s => s[0].toUpperCase() + s.slice(1);

function texts(now) {
    const day = DAYS[now.get_day_of_week() - 1];
    const date = `${now.get_day_of_month()} de ${MONTHS[now.get_month() - 1]}`;
    return {
        time: now.format('%H:%M'),
        day: capital(day),
        date,
        full: `${capital(day)}, ${date}`,
        upper: `${day}, ${date}`.toUpperCase(),
    };
}

export class DesktopClock {
    constructor(ctx) {
        this._settings = ctx.settings;
        this._wallClock = new GnomeDesktop.WallClock({time_only: true});
        this._clockId = this._wallClock.connect('notify::clock', () => this._update());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._build());
        this._settingIds = KEYS.map(key => this._settings.connect(`changed::${key}`, () => this._build()));
        // A new wallpaper is added on top of the old one: keep the clock above it.
        this._group = Main.layoutManager._backgroundGroup;
        this._childId = this._group.connect('child-added', (group, child) => {
            if (this._actor && child !== this._actor)
                group.set_child_above_sibling(this._actor, null);
        });
        this._build();
    }

    _monitor() {
        const index = this._settings.get_int('reloj-monitor');
        return Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
    }

    _build() {
        this._actor?.destroy();
        this._actor = null;
        this._parts = null;
        const monitor = this._monitor();
        if (!monitor)
            return;
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._scale = monitor.height / sf / 1080 * this._settings.get_double('reloj-tamano');
        const style = this._settings.get_string('reloj-estilo');
        const build = {
            'fino': () => this._buildThin(),
            'lateral': () => this._buildSide(),
            'linea': () => this._buildLine(),
            'esquina': () => this._buildCorner(),
            'semana': () => this._buildWeek(),
            'anillo': () => this._buildRing(),
        }[style] ?? (() => this._buildThin());
        this._parts = {};
        const content = build();
        // A monitor-sized holder; the content keeps its natural size and is
        // centered with a constraint, so nothing moves it during a relayout.
        const [top, left] = this._position;
        const offset = this._settings.get_double('reloj-desplazamiento') / 100;
        this._actor = new St.Widget({
            name: 'IslaDockDesktopClock',
            reactive: false,
            x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
        });
        this._actor.add_child(content);
        // 'arriba' keeps each design's own height; 'centro' and 'abajo' align
        // the content's real height, and the fine offset moves any of them.
        const place = this._settings.get_string('reloj-posicion');
        if (place === 'centro' || place === 'abajo') {
            content.add_constraint(new Clutter.AlignConstraint({source: this._actor, align_axis: Clutter.AlignAxis.Y_AXIS,
                factor: place === 'centro' ? 0.5 : 1}));
            const lift = place === 'abajo' ? top + BOTTOM_ROOM : 0;
            content.translation_y = Math.round(monitor.height * (offset - lift));
        } else {
            content.y = Math.max(0, Math.round(monitor.height * (top + offset)));
        }
        if (left === 'center')
            content.add_constraint(new Clutter.AlignConstraint({source: this._actor, align_axis: Clutter.AlignAxis.X_AXIS, factor: 0.5}));
        else
            content.x = Math.round(monitor.width * left);
        this._group.add_child(this._actor);
        this._group.set_child_above_sibling(this._actor, null);
        this._update();
    }

    // Font px at 1920×1080, scaled to the monitor and the user's multiplier.
    _px(n) {
        return Math.round(n * this._scale);
    }

    _label(name, size, weight, extra = '') {
        const label = new St.Label({
            style_class: 'isla-reloj-texto',
            style: `font-size: ${this._px(size)}px; font-weight: ${weight}; ${extra}`,
        });
        label.clutter_text.ellipsize = 0; // never cut the text
        this._parts[name] = label;
        return label;
    }

    _box(vertical, align, spacing, style = '') {
        return new St.BoxLayout({
            vertical,
            x_align: align,
            style: `spacing: ${this._px(spacing)}px; ${style}`,
        });
    }

    // Each style sets this._position: [fraction from the top, 'center' or a fraction of the width from the left].
    _buildThin() {
        this._position = [0.07, 'center'];
        const box = this._box(true, Clutter.ActorAlign.CENTER, 14);
        box.add_child(this._label('time', 110, 200, 'letter-spacing: -2px;'));
        const date = this._label('upper', 25, 300, `letter-spacing: ${this._px(7)}px;`);
        date.opacity = 217;
        date.x_align = Clutter.ActorAlign.CENTER;
        this._parts.time.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(date);
        return box;
    }

    _buildSide() {
        this._position = [0.07, 'center'];
        const box = this._box(false, Clutter.ActorAlign.CENTER, 30);
        const time = this._label('time', 90, 200);
        time.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(time);
        box.add_child(new St.Widget({
            style_class: 'isla-reloj-linea',
            width: Math.max(1, this._px(1)),
            height: this._px(80),
            opacity: 153,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const date = this._box(true, Clutter.ActorAlign.START, 0);
        date.y_align = Clutter.ActorAlign.CENTER;
        date.add_child(this._label('day', 30, 400));
        const rest = this._label('date', 27, 300);
        rest.opacity = 230;
        date.add_child(rest);
        box.add_child(date);
        return box;
    }

    _buildLine() {
        this._position = [0.05, 'center'];
        const box = this._box(false, Clutter.ActorAlign.CENTER, 0);
        const time = this._label('time', 32, 400, `letter-spacing: ${this._px(2)}px;`);
        time.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(time);
        const dot = this._px(7);
        box.add_child(new St.Widget({
            style_class: 'isla-reloj-punto',
            style: `border-radius: ${dot / 2}px; margin: 0 ${this._px(25)}px;`,
            width: dot,
            height: dot,
            opacity: 179,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const date = this._label('upper', 32, 300, `letter-spacing: ${this._px(5)}px;`);
        date.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(date);
        return box;
    }

    _buildCorner() {
        this._position = [0.06, 0.04];
        const box = this._box(true, Clutter.ActorAlign.START, 0);
        box.add_child(this._label('time', 100, 200));
        const date = this._label('full', 27, 300, `letter-spacing: ${this._px(2)}px; margin-top: ${this._px(12)}px;`);
        date.opacity = 217;
        box.add_child(date);
        box.add_child(new St.Widget({
            style_class: 'isla-reloj-barra',
            style: `border-radius: ${this._px(2)}px; margin-top: ${this._px(20)}px;`,
            width: this._px(70),
            height: Math.max(2, this._px(4)),
            opacity: 179,
            x_align: Clutter.ActorAlign.START,
        }));
        return box;
    }

    _buildWeek() {
        this._position = [0.07, 'center'];
        const box = this._box(true, Clutter.ActorAlign.CENTER, 0);
        const time = this._label('time', 115, 200);
        time.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(time);
        const date = this._label('full', 27, 300, `letter-spacing: ${this._px(2)}px; margin-top: ${this._px(15)}px;`);
        date.opacity = 217;
        date.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(date);
        const strip = this._box(false, Clutter.ActorAlign.CENTER, 15, `margin-top: ${this._px(30)}px;`);
        this._parts.week = [];
        for (const letter of LETTERS) {
            const column = new St.BoxLayout({
                vertical: true,
                style_class: 'isla-reloj-dia',
                style: `width: ${this._px(70)}px; border-radius: ${this._px(22)}px; ` +
                    `padding: ${this._px(12)}px 0; spacing: ${this._px(5)}px;`,
            });
            const name = new St.Label({text: letter, style_class: 'isla-reloj-texto',
                style: `font-size: ${this._px(25)}px; font-weight: 300;`, x_align: Clutter.ActorAlign.CENTER});
            const number = new St.Label({style_class: 'isla-reloj-texto',
                style: `font-size: ${this._px(32)}px; font-weight: 400;`, x_align: Clutter.ActorAlign.CENTER});
            column.add_child(name);
            column.add_child(number);
            strip.add_child(column);
            this._parts.week.push({column, number});
        }
        box.add_child(strip);
        return box;
    }

    _buildRing() {
        this._position = [0.06, 'center'];
        const box = this._box(true, Clutter.ActorAlign.CENTER, 0);
        const size = this._px(300);
        const ring = new St.Widget({layout_manager: new Clutter.BinLayout(), width: size, height: size,
            x_align: Clutter.ActorAlign.CENTER});
        const area = new St.DrawingArea({width: size, height: size});
        area.connect('repaint', a => this._drawRing(a));
        ring.add_child(area);
        const inner = this._box(true, Clutter.ActorAlign.CENTER, 0);
        inner.y_align = Clutter.ActorAlign.CENTER;
        const time = this._label('time', 75, 200);
        time.x_align = Clutter.ActorAlign.CENTER;
        inner.add_child(time);
        const percent = this._label('percent', 22, 300, `letter-spacing: ${this._px(2)}px; margin-top: ${this._px(10)}px;`);
        percent.opacity = 204;
        percent.x_align = Clutter.ActorAlign.CENTER;
        inner.add_child(percent);
        ring.add_child(inner);
        box.add_child(ring);
        const date = this._label('full', 27, 300, `letter-spacing: ${this._px(2)}px; margin-top: ${this._px(20)}px;`);
        date.opacity = 230;
        date.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(date);
        this._parts.ring = area;
        return box;
    }

    _drawRing(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const s = w / 300;
        const cx = w / 2, cy = h / 2, r = 130 * s;
        const start = -Math.PI / 2;
        const end = start + 2 * Math.PI * Math.max(0.001, this._progress ?? 0);
        cr.setLineWidth(10 * s);
        cr.setLineCap(1); // round
        // Soft shadow: a dark, see-through copy a little lower.
        cr.setSourceRGBA(0, 0, 0, 0.15);
        cr.arc(cx, cy + 2 * s, r, 0, 2 * Math.PI);
        cr.stroke();
        cr.setSourceRGBA(1, 1, 1, 0.25);
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.stroke();
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.arc(cx, cy, r, start, end);
        cr.stroke();
        cr.$dispose();
    }

    _update() {
        if (!this._parts)
            return;
        const now = GLib.DateTime.new_now_local();
        const t = texts(now);
        for (const key of ['time', 'day', 'date', 'full', 'upper'])
            this._parts[key]?.set_text(t[key]);
        if (this._parts.week) {
            const today = now.get_day_of_week() - 1;
            const monday = now.add_days(-today);
            this._parts.week.forEach(({column, number}, i) => {
                number.text = String(monday.add_days(i).get_day_of_month());
                column.remove_style_class_name('hoy');
                if (i === today)
                    column.add_style_class_name('hoy');
                column.opacity = i === today ? 255 : 204;
            });
        }
        if (this._parts.ring) {
            const seconds = now.get_hour() * 3600 + now.get_minute() * 60 + now.get_second();
            this._progress = seconds / 86400;
            this._parts.percent.text = `${Math.floor(this._progress * 100)}% DEL DÍA`;
            this._parts.ring.queue_repaint();
        }
    }

    destroy() {
        this._wallClock.disconnect(this._clockId);
        this._wallClock = null;
        Main.layoutManager.disconnect(this._monitorsId);
        this._settingIds.forEach(id => this._settings.disconnect(id));
        this._group.disconnect(this._childId);
        this._actor?.destroy();
        this._actor = null;
        this._parts = null;
    }
}
