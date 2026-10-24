// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Reloj de escritorio: the time and date drawn on the wallpaper, Conky style.
// It lives in the background group (under every window, hidden with the
// overview and the lock screen), lets clicks through, and ticks on the wall
// clock's minute change, so it stays right after a suspend and at midnight.
// Four looks ('reloj-estilo', isla-dock-reloj-escritorio.md), no boxes, a soft
// text shadow, bold hours, softer minutes, a colon and details in
// GNOME's accent color:
//   linea-viva      the time and the date in a row, a thin line of the day under them
//   lateral-acento  the time, an accent bar, the day over the date
//   semana-fluida   the time, the month and this week (past days faint, today in the accent)
//   arco-dia        a half circle of the day over the time, 00 and 24 at its ends
// Sizes are at 1920×1080 and scale with the monitor and 'reloj-tamano'.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {accentRGB, watchAccent} from './accent.js';
import {_, fmt} from './i18n.js';
import {capital, dayName, dayProgress, dayShort, initials, monthName, monthShort, two, week} from './dates.js';

const KEYS = ['reloj-estilo', 'reloj-tamano', 'reloj-monitor', 'reloj-desplazamiento', 'reloj-posicion'];

// 'abajo' leaves this much of the height free under the clock, for the dock.
const BOTTOM_ROOM = 0.12;

// GNOME's accent color (Settings → Appearance; orange in the design), straight in
// the styles: they follow it by themselves. The drawn lines read it when painted.
const ACCENT = '-st-accent-color';
const ACCENT_LIGHT = 'st-mix(-st-accent-color, #ffffff, 85%)';
const ACCENT_PALE = 'st-mix(-st-accent-color, #ffffff, 65%)';
const ON_ACCENT = '-st-accent-fg-color';
const WHITE = '#F2F2F5';
const pt = n => n * 4 / 3;    // the design's points, in px at scale 1

export class DesktopClock {
    constructor(ctx) {
        this._settings = ctx.settings;
        this._wallClock = new GnomeDesktop.WallClock({time_only: true});
        this._clockId = this._wallClock.connect('notify::clock', () => this._update());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._build());
        this._settingIds = KEYS.map(key => this._settings.connect(`changed::${key}`, () => this._build()));
        this._unwatchAccent = watchAccent(() => {
            this._parts?.lines?.forEach(line => line.queue_repaint());
            this._parts?.arc?.queue_repaint();
        });
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
        this._style = ['linea-viva', 'lateral-acento', 'semana-fluida', 'arco-dia'].includes(style) ? style : 'linea-viva';
        this._parts = {};
        const content = {
            'linea-viva': () => this._buildLineaViva(),
            'lateral-acento': () => this._buildLateral(),
            'semana-fluida': () => this._buildSemana(),
            'arco-dia': () => this._buildArco(),
        }[this._style]();
        content.add_style_class_name(`isla-desk-clock desk-${this._style}`);
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

    // px at 1920×1080, scaled to the monitor and the user's multiplier.
    _px(n) {
        return Math.round(n * this._scale);
    }

    // A text with the design's size (points), weight, color and spacing; always with the soft shadow.
    _label(name, size, {weight = 400, color = WHITE, spacing = 0, extra = ''} = {}, props = {}) {
        const label = new St.Label({
            style_class: 'isla-desk-texto',
            style: `font-size: ${this._px(pt(size))}px; font-weight: ${weight}; color: ${color};` +
                ` letter-spacing: ${this._px(spacing)}px; text-shadow: 0 ${this._px(1)}px ${this._px(8)}px rgba(0, 0, 0, 0.35); ${extra}`,
            ...props,
        });
        label.clutter_text.ellipsize = 0; // never cut the text
        if (name)
            this._parts[name] = label;
        return label;
    }

    _box(vertical, spacing = 0, props = {}) {
        return new St.BoxLayout({orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            style: `spacing: ${this._px(spacing)}px;`, ...props});
    }

    // Bold hours, an accent colon, minutes at 60 %: three labels with no space between.
    _time(size, spacing = 0, props = {}) {
        const box = this._box(false, 0, props);
        box.add_child(this._label('hour', size, {weight: 500, spacing}));
        box.add_child(this._label(null, size, {color: ACCENT_LIGHT, spacing, extra: ''}, {text: ':'}));
        box.add_child(this._label('min', size, {color: 'rgba(242, 242, 245, 0.60)', spacing}));
        return box;
    }

    // A line of the day, `thick` px: accent up to now, faint after; it takes the width it is given.
    _dayLine(thick) {
        const area = new St.DrawingArea({x_expand: true, height: Math.max(1, this._px(thick))});
        area.connect('repaint', a => {
            const cr = a.get_context();
            const [w, h] = a.get_surface_size();
            const r = h / 2;
            const bar = (to, [red, green, blue, alpha]) => {
                if (to <= 0)
                    return;
                cr.setSourceRGBA(red, green, blue, alpha);
                cr.newPath();
                cr.arc(r, r, r, Math.PI / 2, 1.5 * Math.PI);
                cr.arc(Math.max(r, to - r), r, r, 1.5 * Math.PI, Math.PI / 2);
                cr.closePath();
                cr.fill();
            };
            bar(w, [1, 1, 1, 0.15]);
            bar(w * (this._progress ?? 0), [...accentRGB().map(v => v / 255), 1]);
            cr.$dispose();
        });
        this._parts.lines = [...this._parts.lines ?? [], area];
        return area;
    }

    // Each style sets this._position: [fraction from the top, 'center' or a fraction of the width from the left].
    // Línea viva: the time and VIERNES 23 OCT in a row; under them, as wide as the row, the day's line.
    _buildLineaViva() {
        this._position = [0.05, 'center'];
        const box = this._box(true, 12);
        const row = this._box(false, 12);
        const time = this._time(24, 0, {y_align: Clutter.ActorAlign.END});
        row.add_child(time);
        row.add_child(this._label('upper', 10, {spacing: 3, color: 'rgba(242, 242, 245, 0.75)',
            extra: `padding-bottom: ${this._px(5)}px;`}, {y_align: Clutter.ActorAlign.END}));
        box.add_child(row);
        box.add_child(this._dayLine(2));
        return box;
    }

    // Lateral acento: the time, an accent bar, the day over "23 de octubre".
    _buildLateral() {
        this._position = [0.07, 'center'];
        const row = this._box(false, 16);
        row.add_child(this._time(44, -2, {y_align: Clutter.ActorAlign.CENTER}));
        row.add_child(new St.Widget({style: `background-color: ${ACCENT}; border-radius: ${this._px(2)}px;`,
            width: Math.max(2, this._px(3)), height: this._px(52), y_align: Clutter.ActorAlign.CENTER}));
        const texts = this._box(true, 0, {y_align: Clutter.ActorAlign.CENTER});
        texts.add_child(this._label('day', 14, {weight: 500}));
        texts.add_child(this._label('date', 11, {color: 'rgba(242, 242, 245, 0.60)'}));
        row.add_child(texts);
        return row;
    }

    // Semana fluida: the time, the month, and Monday to Sunday (past days faint, today in an accent pill).
    _buildSemana() {
        this._position = [0.07, 'center'];
        const box = this._box(true, 0);
        box.add_child(this._time(38, -1.5, {x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(this._label('month', 9, {spacing: 2, color: 'rgba(242, 242, 245, 0.70)',
            extra: `margin-top: ${this._px(6)}px;`}, {x_align: Clutter.ActorAlign.CENTER}));
        const strip = this._box(false, 6, {x_align: Clutter.ActorAlign.CENTER, style: `spacing: ${this._px(6)}px;` +
            ` margin-top: ${this._px(14)}px;`});
        this._parts.week = initials(true).map(letter => {
            const column = this._box(true, 0, {style: `width: ${this._px(26)}px; padding: ${this._px(3)}px 0;` +
                ` border-radius: ${this._px(9)}px;`});
            const initial = this._label(null, 8, {}, {text: letter, x_align: Clutter.ActorAlign.CENTER});
            const number = this._label(null, 11, {weight: 500}, {x_align: Clutter.ActorAlign.CENTER});
            column.add_child(initial);
            column.add_child(number);
            strip.add_child(column);
            return {column, initial, number};
        });
        box.add_child(strip);
        return box;
    }

    // Arco del día: a half circle from 00 (left) to 24 (right) over the time; the date between its ends.
    _buildArco() {
        this._position = [0.06, 'center'];
        const box = this._box(true, 0);
        const [w, h] = [this._px(172), this._px(96)];
        const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), width: w, height: h,
            x_align: Clutter.ActorAlign.CENTER});
        const arc = new St.DrawingArea({width: w, height: h});
        arc.connect('repaint', a => this._drawArc(a));
        this._parts.arc = arc;
        holder.add_child(arc);
        holder.add_child(this._time(32, -1, {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END}));
        box.add_child(holder);
        const ends = this._box(false, 0, {width: w, x_align: Clutter.ActorAlign.CENTER});
        const faint = 'rgba(242, 242, 245, 0.50)';
        ends.add_child(this._label(null, 8, {color: faint}, {text: '00'}));
        ends.add_child(this._label('short', 8, {spacing: 2, color: ACCENT_PALE}, {x_expand: true, x_align: Clutter.ActorAlign.CENTER}));
        ends.add_child(this._label(null, 8, {color: faint}, {text: '24'}));
        box.add_child(ends);
        return box;
    }

    _drawArc(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const s = w / 172;
        const r = 80 * s, cx = w / 2, cy = h - 8 * s;
        const at = Math.PI + Math.PI * (this._progress ?? 0);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(3 * s);
        cr.setSourceRGBA(1, 1, 1, 0.15);
        cr.arc(cx, cy, r, Math.PI, 2 * Math.PI);
        cr.stroke();
        cr.setSourceRGB(...accentRGB().map(v => v / 255));
        cr.arc(cx, cy, r, Math.PI, Math.max(Math.PI + 0.001, at));
        cr.stroke();
        cr.arc(cx + r * Math.cos(at), cy + r * Math.sin(at), 6 * s, 0, 2 * Math.PI);
        cr.fillPreserve();
        cr.setLineWidth(2 * s);
        cr.setSourceRGBA(0, 0, 0, 0.35);
        cr.stroke();
        cr.$dispose();
    }

    _update() {
        if (!this._parts)
            return;
        const now = GLib.DateTime.new_now_local();
        const p = this._parts;
        p.hour?.set_text(two(now.get_hour()));
        p.min?.set_text(two(now.get_minute()));
        const day = now.get_day_of_month();
        p.upper?.set_text(`${dayName(now)} ${day} ${monthShort(now)}`.toUpperCase());
        p.day?.set_text(capital(dayName(now)));
        p.date?.set_text(fmt(_('{dia} de {mes}'), {dia: day, mes: monthName(now)}));
        p.month?.set_text(monthName(now).toUpperCase());
        p.short?.set_text(`${dayShort(now)} ${day} ${monthShort(now)}`.toUpperCase());
        this._progress = dayProgress(now);
        const days = week(now);
        p.week?.forEach(({column, initial, number}, i) => {
            const d = days[i];
            number.text = String(d.date.get_day_of_month());
            // Past days faint, today on the accent (no shadow), the ones to come clear.
            const color = d.today ? ON_ACCENT : d.past ? 'rgba(242, 242, 245, 0.35)' : 'rgba(242, 242, 245, 0.85)';
            for (const label of [initial, number]) {
                label.style = label.style.replace(/color: [^;]+;/, `color: ${color};`)
                    .replace(/text-shadow: [^;]+;/, d.today ? 'text-shadow: none;' : `text-shadow: 0 ${this._px(1)}px ${this._px(8)}px rgba(0, 0, 0, 0.35);`);
            }
            column.style = column.style.replace(/ background-color: [^;]+;/, '') + (d.today ? ` background-color: ${ACCENT};` : '');
        });
        p.lines?.forEach(line => line.queue_repaint());
        p.arc?.queue_repaint();
    }

    destroy() {
        this._wallClock.disconnect(this._clockId);
        this._wallClock = null;
        Main.layoutManager.disconnect(this._monitorsId);
        this._settingIds.forEach(id => this._settings.disconnect(id));
        this._group.disconnect(this._childId);
        this._unwatchAccent();
        this._actor?.destroy();
        this._actor = null;
        this._parts = null;
    }
}
