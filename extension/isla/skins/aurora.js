// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Aurora: a dark capsule wrapped in a halo of flowing colors, like the
// northern lights; livelier while music plays. The halo is a gradient stroke
// drawn with cairo around the capsule and softened with a blur.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {SkinBase} from './base.js';
import {Mode, Priority} from '../state.js';
import {ms} from '../timing.js';

const COLORS = ['#3EE6C4', '#7B5CFF', '#FF6FAE', '#FFC15E'].map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255));
const SPREAD = 22;           // room around the stroke for the blur
const STROKE = 8;
const RADIUS = 22;
const FRAME_MS = 33;         // at most 30 repaints per second

export class AuroraSkin extends SkinBase {
    get blur() {
        return null;
    }

    get darkTooltip() {
        return true;
    }

    get portalGraphite() {
        return false;
    }

    get waveColor() {
        return '#3EE6C4';
    }

    // Dark cells, light text and the halo's teal as the accent.
    getStackStyle() {
        return {
            cellFill: 'rgba(20, 20, 28, 0.85)', cellBorder: 'rgba(255, 255, 255, 0.10)', cellHover: 'rgba(32, 32, 44, 0.95)',
            accent: '#3EE6C4', text: '#F2F3F8', textSecondary: 'rgba(242, 243, 248, 0.60)',
            panelFill: 'rgba(20, 20, 28, 0.90)', panelBorder: 'rgba(123, 92, 255, 0.45)', shadow: 'rgba(0, 0, 0, 0.40)',
            tileHover: 'rgba(62, 230, 196, 0.16)',
        };
    }

    // The Energía panel wears the same halo: it follows the island's (opacity, flow).
    floatingLook() {
        return {
            layers: radius => {
                const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                const halo = new St.DrawingArea({style_class: 'isla-aurora-halo', reactive: false});
                halo._around = SPREAD * sf;
                halo.connect('repaint', area => this._paint(area, radius, 4));
                halo.add_effect(haloBlur(sf));
                this._halo.bind_property('opacity', halo, 'opacity', GObject.BindingFlags.SYNC_CREATE);
                this._extra.add(halo);
                halo.connect('destroy', () => this._extra?.delete(halo));
                return [halo];
            },
        };
    }

    enable() {
        this._phase = 0;
        this._cycle = 12000;
        this._cycleTarget = 12000;
        this._grow = 4;
        const halo = new St.DrawingArea({style_class: 'isla-aurora-halo', opacity: 140});
        halo._around = SPREAD;
        halo.connect('repaint', area => this._paint(area, RADIUS, this._grow));
        halo.add_effect(haloBlur(St.ThemeContext.get_for_stage(global.stage).scale_factor));
        this._halo = this.addLayer(halo, 'around');
        this._extra = new Set();
        this._timeline = new Clutter.Timeline({actor: halo, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        this.connect(halo, 'notify::mapped', () => this._run());
        this.connect(St.Settings.get(), 'notify::enable-animations', () => this._run());
        this._last = GLib.get_monotonic_time();
        this.connect(this.isla._state, 'music-changed', () => this._react());
        this._react();
    }

    // Moves the colors along the edge; the speed eases towards its target.
    _tick() {
        const now = GLib.get_monotonic_time();
        const dt = (now - this._last) / 1000;
        if (dt < FRAME_MS)
            return;
        this._last = now;
        this._cycle += (this._cycleTarget - this._cycle) * Math.min(1, dt / 600);
        this._phase = (this._phase + dt / this._cycle) % 1;
        this._halo.queue_repaint();
        this._extra.forEach(h => h.queue_repaint());
    }

    _run() {
        const animate = St.Settings.get().enable_animations && this._halo.mapped && this._halo.opacity > 0 &&
            !this.isla._state.dnd;
        if (animate && !this._timeline.is_playing()) {
            this._last = GLib.get_monotonic_time();
            this._timeline.start();
        } else if (!animate && this._timeline.is_playing()) {
            this._timeline.stop();
        }
    }

    _paint(area, radius, grow) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const inset = (SPREAD - grow) * sf;
        const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset;
        const r = Math.min((radius + grow) * sf, (y1 - y0) / 2);
        cr.newPath();
        cr.arc(x1 - r, y0 + r, r, -Math.PI / 2, 0);
        cr.arc(x1 - r, y1 - r, r, 0, Math.PI / 2);
        cr.arc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI);
        cr.arc(x0 + r, y0 + r, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
        // A diagonal gradient whose stops travel: the colors flow along the edge.
        const gradient = new Cairo.LinearGradient(0, 0, w, h);
        const n = COLORS.length;
        for (let k = -n; k <= n; k++) {
            const pos = (k + this._phase * n) / n;
            if (pos < -0.25 || pos > 1.25)
                continue;
            const [cr_, cg, cb] = COLORS[((k % n) + n) % n];
            gradient.addColorStopRGBA(Math.max(0, Math.min(1, pos)), cr_, cg, cb, 1);
        }
        cr.setSource(gradient);
        cr.setLineWidth(STROKE * sf);
        cr.stroke();
        cr.$dispose();
    }

    // How the halo reacts: resting, music, open, notice, do not disturb.
    _react() {
        const state = this.isla._state;
        const mode = state.mode;
        let opacity = 0.55, cycle = 12000;
        if (state.dnd) {
            opacity = 0;
        } else if (mode === Mode.EXPANDED || mode === Mode.SEARCH) {
            opacity = 0.70;
            cycle = 8000;
        } else if (state.musicPlaying && state.activities.some(a => a.priority === Priority.MUSIC)) {
            opacity = 0.85;
            cycle = 6000;
        }
        this._grow = mode === Mode.COLLAPSED ? 4 : 5;
        this._cycleTarget = cycle;
        if (!St.Settings.get().enable_animations)
            opacity = state.dnd ? 0 : 0.6;
        this._halo.remove_transition('opacity');
        const target = Math.round(255 * opacity);
        if (mode === Mode.NOTICE && !state.dnd) {
            // A flash, then back.
            this._halo.ease({opacity: 255, duration: ms(150), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._halo?.ease({opacity: Math.round(255 * 0.55), duration: ms(600), delay: ms(250)})});
        } else {
            this._halo.ease({opacity: target, duration: ms(600), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._halo && this._run()});
        }
        this._run();
        this._halo.queue_repaint();
    }

    onStateChanged() {
        this._react();
    }

    onActivityChanged() {
        this._react();
    }

    disable() {
        this._timeline?.stop();
        this._timeline = null;
        this._extra.forEach(h => h.destroy());
        this._extra = null;
        this._halo = null;
        super.disable();
    }
}

function haloBlur(sf) {
    const blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, brightness: 1});
    if (GObject.Object.find_property.call(Shell.BlurEffect, 'radius'))
        blur.radius = 10 * sf;
    else
        blur.sigma = 5 * sf;
    return blur;
}
