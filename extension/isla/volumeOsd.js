// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Volume indicator (volumen-isla-dock.md, A2 "Solo barra", 2026-10-24): in place
// of GNOME's volume box in the middle of the screen, a small pill 8 px over the
// dock, 150 px long and in the dock's own colors (the user's choice over the spec): a speaker with 0–3 waves and a thin bar, no number. Muted: the speaker
// with a red ×. Over 100 % (amplified) the waves turn orange and the bar shows
// the extra part in orange (the whole bar is the allowed maximum). It comes up on
// every change (keys, the wheel, quick settings), stays 1.5 s after the last one
// and lets every click through. Brightness, microphone and the rest keep
// GNOME's own box.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

import {dockLook} from './look.js';
import {dockMonitor} from './monitor.js';
import {ms} from './timing.js';

const WIDTH = 150;
const PADDING = 9;
const BORDER = 1;
const SPACING = 7;
const ICON = 11;
const BAR = 4;
const GAP = 8;            // px over the dock
const RISE = 6;
const IN_TIME = 150;
const BAR_TIME = 120;
const OUT_TIME = 200;
const STAY = 1500;
const MUTED_RED = [0xc4, 0x3a, 0x4c];
const LOUD_ORANGE = [0xb2, 0x5a, 0x12];
const WAVES = [4.5, 7.5, 10.5];
const WAVE_ANGLE = 0.8;

// GNOME 48: show(monitorIndex, icon, label, level, maxLevel).
// GNOME 49+: showOne(monitorIndex, icon, label, level, maxLevel) and showAll(icon, label, level, maxLevel).
const isVolume = icon => /^audio-volume-/.test(icon?.get_names?.()[0] ?? icon?.to_string?.() ?? '');

export class VolumeOsd {
    constructor({state, capsule}) {
        this._state = state;
        this._capsule = capsule;
        this._build();
        this._patch();
        // The wheel over the island (gestures.js) shows it too.
        this._commandId = state.connect('command', (_s, name, value) => {
            if (name === 'volume-level')
                this._show(value, 1, this._sinkMuted());
        });
    }

    // ---------- GNOME's box ----------
    _patch() {
        const osd = Main.osdWindowManager;
        this._patched = [];
        const wrap = (name, takesMonitor) => {
            const original = osd[name];
            if (typeof original !== 'function')
                return;
            osd[name] = (...args) => {
                const [icon, , level, maxLevel] = takesMonitor ? args.slice(1) : args;
                if (!isVolume(icon) || level === null || level === undefined)
                    return original.apply(osd, args);
                const muted = /muted/.test(icon.get_names?.()[0] ?? '') || this._sinkMuted();
                this._show(level, maxLevel ?? 1, muted);
                return undefined;
            };
            this._patched.push(name);
        };
        if (typeof osd.showAll === 'function') {
            wrap('showOne', true);
            wrap('showAll', false);
        } else {
            wrap('show', true);
        }
    }

    _unpatch() {
        // The wrappers are own properties: removing them uncovers the class's methods.
        for (const name of this._patched ?? [])
            delete Main.osdWindowManager[name];
        this._patched = [];
    }

    _sinkMuted() {
        return !!Volume.getMixerControl()?.get_default_sink()?.is_muted;
    }

    // ---------- the pill ----------
    _build() {
        this._pill = new St.BoxLayout({style_class: 'isla-volumen', reactive: false, visible: false,
            y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.DrawingArea({style_class: 'isla-volumen-icono', y_align: Clutter.ActorAlign.CENTER});
        this._icon.connect('repaint', area => this._drawIcon(area));
        this._track = new St.Widget({style_class: 'isla-volumen-pista', y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.FixedLayout(), clip_to_allocation: true});
        this._fill = new St.Widget({style_class: 'isla-volumen-relleno'});
        this._extra = new St.Widget({style_class: 'isla-volumen-extra'});
        this._track.add_child(this._extra);
        this._track.add_child(this._fill);
        this._pill.add_child(this._icon);
        this._pill.add_child(this._track);
        // Not chrome: it never takes a click nor a piece of the input region.
        Main.layoutManager.uiGroup.add_child(this._pill);
        this._waves = 3;
        this._muted = false;
        this._loud = false;
    }

    // value and max in GNOME's terms: 1 = 100 %, max 1.5 when amplifying is allowed.
    _show(value, max, muted) {
        max = Math.max(1, max || 1);
        value = Math.max(0, Math.min(max, value ?? 0));
        const percent = Math.round(value * 100);
        this._muted = muted;
        this._loud = !muted && value > 1;
        this._waves = muted || percent === 0 ? 0 : percent <= 33 ? 1 : percent <= 66 ? 2 : 3;
        this._icon.queue_repaint();

        const pill = this._pill;
        const showing = pill.visible && pill.opacity > 0 && !this._leaving;
        this._leaving = false;
        pill.remove_transition('opacity');
        pill.remove_transition('translation-y');
        this._look();
        Main.layoutManager.uiGroup.set_child_above_sibling(pill, null);
        pill.show();
        this._place();
        this._setBar(value, max, showing);
        if (!showing) {
            const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            pill.set({opacity: 0, translation_y: RISE * sf});
            pill.ease({opacity: 255, translation_y: 0, duration: ms(IN_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            pill.set({opacity: 255, translation_y: 0});
        }
        if (this._stayId)
            GLib.source_remove(this._stayId);
        this._stayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STAY, () => {
            this._stayId = 0;
            this._hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hide() {
        this._leaving = true;
        this._pill.ease({opacity: 0, duration: ms(OUT_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: done => {
                if (done && this._leaving) {
                    this._leaving = false;
                    this._pill.hide();
                }
            }});
    }

    // The dock's own color and transparency, whatever the skin (light ones too).
    _look() {
        const look = dockLook(this._state);
        this._pill.style_class = `isla-volumen${look.light ? '' : ' oscura'}`;
        this._pill.style = look.style || null;
        this._fill.style_class = `isla-volumen-relleno${this._muted ? ' silencio' : ''}`;
    }

    // The bar is the allowed maximum: up to 100 % in the accent color, past it orange.
    _setBar(value, max, animate) {
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = Math.round((WIDTH - 2 * (PADDING + BORDER) - ICON - SPACING) * sf);
        const height = Math.round(BAR * sf);
        this._track.set_size(width, height);
        const normal = Math.round(width * Math.min(value, 1) / max);
        const total = Math.round(width * value / max);
        // Muted: no orange part (it showed through the faded red).
        this._extra.visible = !this._muted;
        this._fill.set_position(0, 0);
        this._extra.set_position(0, 0);
        this._fill.height = this._extra.height = height;
        const duration = animate ? ms(BAR_TIME) : 0;
        for (const [actor, w] of [[this._fill, normal], [this._extra, total]]) {
            actor.remove_transition('width');
            if (duration)
                actor.ease({width: w, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                actor.width = w;
        }
    }

    // Centered over the dock, 8 px above it; never under the screen's edge while the dock is hidden away.
    _place() {
        const pill = this._pill;
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const mon = dockMonitor();
        const [, w] = pill.get_preferred_width(-1);
        const [, h] = pill.get_preferred_height(w);
        const [cx, cy] = this._capsule.get_transformed_position();
        const [cw] = this._capsule.get_transformed_size();
        const top = Math.min(cy, mon.y + mon.height - 12 * sf);
        pill.set_position(Math.round(cx + cw / 2 - w / 2), Math.round(top - GAP * sf - h));
    }

    // The speaker of the design (a 24 px viewBox), with 0–3 waves or a red ×.
    _drawIcon(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const s = Math.min(w, h) / 24;
        const accent = area.get_theme_node().get_foreground_color();
        const rgb = this._muted ? MUTED_RED : this._loud ? LOUD_ORANGE : [accent.red, accent.green, accent.blue];
        cr.setSourceRGBA(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1);
        cr.setLineCap(1);    // round
        cr.setLineJoin(1);
        cr.scale(s, s);
        cr.setLineWidth(2.6);
        cr.moveTo(11, 5);
        cr.lineTo(6, 9);
        cr.lineTo(3, 9);
        cr.lineTo(3, 15);
        cr.lineTo(6, 15);
        cr.lineTo(11, 19);
        cr.closePath();
        cr.stroke();
        if (this._muted) {
            for (const [x1, y1, x2, y2] of [[16, 9, 22, 15], [22, 9, 16, 15]]) {
                cr.moveTo(x1, y1);
                cr.lineTo(x2, y2);
            }
            cr.stroke();
        } else {
            // Arcs around (12, 12), like the design's curves at 15.5 and 18.5.
            for (const r of WAVES.slice(0, this._waves)) {
                cr.arc(12, 12, r, -WAVE_ANGLE, WAVE_ANGLE);
                cr.stroke();
            }
        }
        cr.$dispose();
    }

    destroy() {
        this._unpatch();
        this._state.disconnect(this._commandId);
        if (this._stayId)
            GLib.source_remove(this._stayId);
        this._stayId = 0;
        this._pill.destroy();
    }
}
