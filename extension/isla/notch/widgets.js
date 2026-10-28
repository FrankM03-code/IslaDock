// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Small pieces the top island and its pages share: boxes, buttons, the ring
// and the music wave.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {accentRGB} from '../accent.js';

export const vbox = (props = {}) => new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, ...props});
export const hbox = (props = {}) => new St.BoxLayout(props);
export const spacer = () => new St.Widget({x_expand: true});

// 25:00, 1:05:00
export function clock(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
    const two = n => String(n).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

export function label(styleClass, text = '', props = {}) {
    return new St.Label({style_class: styleClass, text, y_align: Clutter.ActorAlign.CENTER, ...props});
}

// A round button with a symbolic icon (`icon`: a name or a Gio.Icon).
export function iconButton(icon, styleClass = 'isla-sup-boton', size = 16, name = '') {
    const iconProps = typeof icon === 'string' ? {icon_name: icon} : {gicon: icon};
    return new St.Button({style_class: styleClass, can_focus: true, accessible_name: name, y_align: Clutter.ActorAlign.CENTER,
        child: new St.Icon({...iconProps, icon_size: size})});
}

// A capsule with an optional icon before its text.
export function pillButton(text, styleClass = '', icon = null) {
    const button = new St.Button({style_class: `isla-sup-pastilla ${styleClass}`, can_focus: true,
        y_align: Clutter.ActorAlign.CENTER});
    const box = hbox({style_class: 'isla-sup-pastilla-caja'});
    if (icon) {
        const iconProps = typeof icon === 'string' ? {icon_name: icon} : {gicon: icon};
        box.add_child(new St.Icon({...iconProps, icon_size: 13, y_align: Clutter.ActorAlign.CENTER}));
    }
    // An empty text leaves only the icon (a round chip).
    button._label = label('', text, {visible: !!text});
    button._label.connect('notify::text', l => (l.visible = !!l.text));
    box.add_child(button._label);
    button.set_child(box);
    return button;
}

// A ring that fills in GNOME's accent color: `fraction()` says how much.
export function ring(size, line, fraction) {
    const area = new St.DrawingArea({style_class: 'isla-sup-anillo', y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER});
    area.style = `width: ${size}px; height: ${size}px;`;
    area.connect('repaint', () => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const fg = area.get_theme_node().get_foreground_color();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const lw = line * sf;
        const r = Math.min(w, h) / 2 - lw / 2 - 1;
        cr.setLineWidth(lw);
        cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.14);
        cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI);
        cr.stroke();
        const f = Math.max(0, Math.min(1, fraction()));
        if (f > 0) {
            const [ar, ag, ab] = accentRGB();
            cr.setSourceRGBA(ar / 255, ag / 255, ab / 255, 1);
            cr.setLineCap(1 /* ROUND */);
            cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + f * 2 * Math.PI);
            cr.stroke();
        }
        cr.$dispose();
    });
    return area;
}

// Four bars that jump while music plays and rest low otherwise.
const BARS = 4;
const REST = 0.3;

export class Wave {
    constructor() {
        this.actor = hbox({style_class: 'isla-sup-onda', y_align: Clutter.ActorAlign.CENTER});
        this._bars = [];
        for (let i = 0; i < BARS; i++) {
            const bar = new St.Widget({style_class: 'isla-sup-onda-barra', y_align: Clutter.ActorAlign.CENTER});
            bar.set_pivot_point(0.5, 0.5);
            bar.scale_y = REST;
            this.actor.add_child(bar);
            this._bars.push(bar);
        }
        // Clutter does not animate what is not on screen: start again when it shows (one idle
        // later: right after it shows Clutter still sets values at once).
        this.actor.connect('notify::mapped', () => {
            if (this._idle || !this.actor.mapped)
                return;
            this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._idle = 0;
                this._start();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    set color(color) {
        this._bars.forEach(b => (b.style = color ? `background-color: ${color};` : null));
    }

    set playing(on) {
        on = on && St.Settings.get().enable_animations;
        if (on === this._on)
            return;
        this._on = on;
        if (on) {
            this._start();
            return;
        }
        this._bars.forEach(bar => {
            bar.remove_transition('scale-y');
            bar.ease({scale_y: REST, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
    }

    _start() {
        if (this._on && this.actor.mapped)
            this._bars.forEach(bar => !bar.get_transition('scale-y') && this._jump(bar));
    }

    _jump(bar) {
        if (!this._on || !bar.mapped)
            return;
        bar.ease({
            scale_y: 0.25 + Math.random() * 0.75,
            duration: 160 + Math.random() * 240,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onComplete: () => this._on && this._jump(bar),
        });
    }

    stop() {
        this._on = false;
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
        this._bars.forEach(bar => bar.remove_all_transitions());
    }
}
