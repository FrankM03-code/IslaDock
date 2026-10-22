// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The "Portal" applications button (BOTON_PORTAL.md): a ring with a dot in the
// middle. On hover it fills with blue, glows, a dashed outer ring turns around
// it and the dot becomes a penguin silhouette on white (the user's choice
// instead of the design's 2×2 grid, which looked like Windows).
// Clicked, the outer ring spreads like a wave and the app grid opens.
// Sizes are those of the design (52 px), scaled to the dock's icon tile.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {ms} from './timing.js';

const DESIGN = 52;
// White inside the ring (the user's choice) so the black penguin stands out.
const FILL = [1, 1, 1];
const GLOW = [58 / 255, 141 / 255, 1];

// Ring, inner fill, glow and shadows; `progress` 0 = rest, 1 = open.
const PortalBase = GObject.registerClass({
    Properties: {
        'progress': GObject.ParamSpec.double('progress', null, null, GObject.ParamFlags.READWRITE, 0, 1, 0),
    },
}, class IslaPortalBase extends St.DrawingArea {
    _init() {
        super._init({x_expand: true, y_expand: true});
        this._progress = 0;
        this.graphite = false;
        this.focusRing = false;
    }

    get progress() {
        return this._progress;
    }

    set progress(v) {
        if (this._progress === v)
            return;
        this._progress = v;
        this.notify('progress');
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const u = Math.min(w, h) / DESIGN;
        const cx = w / 2, cy = h / 2;
        const p = this._progress;
        const line = 2.5 * u;
        const ring = 15 * u - line / 2;
        const [lr, lg, lb] = this.graphite ? [0x1E / 255, 0x20 / 255, 0x26 / 255] : [1, 1, 1];
        // Resting shadows: a soft one outside, a faint one inside (fade out on hover).
        for (let i = 1; i <= 3; i++) {
            cr.arc(cx, cy + u, ring + i * 0.8 * u, 0, 2 * Math.PI);
            cr.setSourceRGBA(0, 0, 0, 0.07 * (1 - p) / i);
            cr.setLineWidth(line);
            cr.stroke();
        }
        // Blue glow around the ring.
        for (let i = 6; i >= 1; i--) {
            cr.arc(cx, cy, ring + i * 1.2 * u, 0, 2 * Math.PI);
            cr.setSourceRGBA(...GLOW, 0.8 * p * (0.16 - i * 0.02));
            cr.setLineWidth(2.4 * u);
            cr.stroke();
        }
        // Inner fill.
        if (p > 0) {
            cr.arc(cx, cy, 13 * u, 0, 2 * Math.PI);
            cr.setSourceRGBA(...FILL, p);
            cr.fill();
        }
        cr.arc(cx, cy + 0.5 * u, 13 * u, Math.PI * 1.1, Math.PI * 1.9);
        cr.setSourceRGBA(0, 0, 0, 0.15 * (1 - p));
        cr.setLineWidth(1.5 * u);
        cr.stroke();
        // The ring.
        cr.arc(cx, cy, ring, 0, 2 * Math.PI);
        cr.setSourceRGBA(lr, lg, lb, 1);
        cr.setLineWidth(line);
        cr.stroke();
        // The resting dot, exactly in the middle; it shrinks away first.
        const dot = 4 * u * Math.max(0, 1 - p * 1.7);
        if (dot > 0.2) {
            cr.arc(cx, cy, dot, 0, 2 * Math.PI);
            cr.setSourceRGBA(lr, lg, lb, 1);
            cr.fill();
        }
        // Keyboard focus.
        if (this.focusRing) {
            cr.arc(cx, cy, 15 * u + 3 * u, 0, 2 * Math.PI);
            cr.setSourceRGBA(...GLOW, 0.95);
            cr.setLineWidth(2 * u);
            cr.stroke();
        }
        cr.$dispose();
    }
});

// The penguin: the silhouette the user chose (black, belly and eye see-through),
// prepared by herramientas/pinguino.py.
const PENGUIN = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
    .get_child('icons').get_child('portal-pinguino.png');

export const Portal = GObject.registerClass(
class IslaPortal extends St.Widget {
    _init() {
        super._init({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._base = new PortalBase();
        this._outer = new St.DrawingArea({x_expand: true, y_expand: true, opacity: 0});
        this._outer.set_pivot_point(0.5, 0.5);
        this._outer.connect('repaint', area => this._paintOuter(area));
        this._tux = new St.Icon({gicon: new Gio.FileIcon({file: PENGUIN}), x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER, scale_x: 0, scale_y: 0});
        this._tux.set_pivot_point(0.5, 0.5);
        for (const actor of [this._base, this._outer, this._tux])
            this.add_child(actor);
        this._hover = false;
        this._open = false;
        this._focused = false;
        this.spin = true;
        this.connect('destroy', () => this._stopSpin());
        this._outer.connect('notify::mapped', () => !this._outer.mapped && this._stopSpin());
    }

    // The tile size in px: everything follows the 52 px design.
    setSize(px) {
        const u = px / DESIGN;
        // Inside the 26 px inner circle; even sizes keep it centered.
        this._tux.icon_size = 2 * Math.round(16 * u / 2);
    }

    // Graphite instead of white over a very light island.
    setGraphite(on) {
        this._base.graphite = on;
        this._graphite = on;
        this._base.queue_repaint();
        this._outer.queue_repaint();
    }

    _paintOuter(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const u = Math.min(w, h) / DESIGN;
        const [r, g, b] = this._graphite ? [0x1E / 255, 0x20 / 255, 0x26 / 255] : [1, 1, 1];
        cr.setDash([4 * u, 3 * u], 0);
        cr.arc(w / 2, h / 2, 21 * u, 0, 2 * Math.PI);
        cr.setSourceRGBA(r, g, b, 1);
        cr.setLineWidth(2.5 * u);
        cr.stroke();
        cr.$dispose();
    }

    // ---------- states ----------
    setHover(on) {
        this._hover = on;
        this._update();
    }

    setOpen(on) {
        this._open = on;
        this._update();
    }

    setFocused(on) {
        this._focused = on;
        this._base.focusRing = on;
        this._base.queue_repaint();
        this._update();
    }

    _update() {
        const lit = this._hover || this._open || this._focused;
        // The turning outer ring: only with the pointer over it, never while open.
        const ring = this._hover && !this._open;
        if (lit === this._lit && ring === this._ring)
            return;
        const wasLit = this._lit;
        this._lit = lit;
        this._ring = ring;
        if (lit && !wasLit)
            this._enter();
        else if (!lit && wasLit)
            this._leave();
        if (ring)
            this._showRing();
        else
            this._hideRing();
    }

    _enter() {
        const Mode = Clutter.AnimationMode;
        this._base.remove_transition('progress');
        this._base.ease_property('progress', 1, {duration: ms(200), mode: Mode.EASE_OUT_QUAD});
        // Tux pops out of the portal.
        this._tux.remove_all_transitions();
        this._tux.ease({scale_x: 1, scale_y: 1, delay: ms(70), duration: ms(240), mode: Mode.EASE_OUT_BACK});
    }

    _leave() {
        const Mode = Clutter.AnimationMode;
        this._base.remove_transition('progress');
        this._base.ease_property('progress', 0, {duration: ms(200), mode: Mode.EASE_OUT_QUAD});
        this._tux.remove_all_transitions();
        this._tux.ease({scale_x: 0, scale_y: 0, duration: ms(200), mode: Mode.EASE_OUT_QUAD});
    }

    _showRing() {
        const outer = this._outer;
        outer.remove_all_transitions();
        outer.set({scale_x: 0.7, scale_y: 0.7, opacity: 0});
        outer.ease({scale_x: 1, scale_y: 1, opacity: Math.round(255 * 0.9), duration: ms(300),
            mode: Clutter.AnimationMode.EASE_OUT_BACK, onComplete: () => this._startSpin()});
    }

    _hideRing() {
        const outer = this._outer;
        if (outer.opacity === 0)
            return;
        outer.remove_transition('scale-x');
        outer.remove_transition('scale-y');
        outer.remove_transition('opacity');
        outer.ease({opacity: 0, duration: ms(200), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._stopSpin()});
    }

    _startSpin() {
        if (!this.spin || !St.Settings.get().enable_animations || !this._outer.mapped)
            return;
        const outer = this._outer;
        outer.remove_transition('rotation-angle-z');
        const from = outer.rotation_angle_z % 360;
        outer.rotation_angle_z = from;
        outer.ease({rotation_angle_z: from + 360, duration: 10000, mode: Clutter.AnimationMode.LINEAR, repeatCount: -1});
    }

    _stopSpin() {
        this._outer?.remove_transition('rotation-angle-z');
    }

    // "The portal opens": the outer ring spreads out like a wave.
    burst() {
        const outer = this._outer;
        outer.remove_all_transitions();
        outer.set({scale_x: 1, scale_y: 1, opacity: Math.round(255 * 0.9)});
        outer.ease({scale_x: 1.35, scale_y: 1.35, opacity: 0, duration: ms(220), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._stopSpin()});
        this._ring = false;
    }
});
