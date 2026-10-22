// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Vidrio oscuro's lens: a blurred copy of the wallpaper around a target (the
// island or the music card), bent near the edges like a magnifier by a
// refraction shader that also tints it, rounds it and draws the light rim.
// The shader only repaints when something changes (size, pointer, buttons).
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';

export const MAX_BUTTONS = 32;
const HAS_BLUR_RADIUS = !!GObject.Object.find_property.call(Shell.BlurEffect, 'radius');

const DECLARATIONS = `
uniform vec2  u_size;
uniform vec4  u_rect;
uniform float u_radius;
uniform float u_strength;
uniform float u_lens;
uniform float u_tint;
uniform float u_sf;
uniform vec2  u_mouse;
uniform vec4  u_circ[${MAX_BUTTONS}];
uniform float u_ncirc;

vec4 muestra(vec2 px) { return texture2D(cogl_sampler0, clamp(px / u_size, 0.0, 1.0)); }

float sdRB(vec2 p, vec2 c, vec2 b, float r) {
  vec2 q = abs(p - c) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float sdDock(vec2 p) { return sdRB(p, u_rect.xy + u_rect.zw * 0.5, u_rect.zw * 0.5, u_radius); }

vec3 vidrio(vec2 p, float d, vec2 n, vec2 centro, float fuerza, float lente, float tinte) {
  float e = clamp(1.0 + d / (30.0 * u_sf), 0.0, 1.0); e = e * e * e;
  vec2 q = centro + (p - centro) * (1.0 - lente) - n * e * fuerza;
  vec3 col = muestra(q).rgb;
  col.r = mix(col.r, muestra(q - n * e * 7.0 * u_sf).r, e * 0.7);
  col.b = mix(col.b, muestra(q + n * e * 7.0 * u_sf).b, e * 0.7);
  col = mix(col, vec3(0.07, 0.07, 0.085), tinte) * 1.15;
  float banda = 1.0 - smoothstep(0.0, 2.4 * u_sf, abs(d + 1.2 * u_sf));
  float l = dot(n, normalize(vec2(-0.55, -0.85)));
  col += banda * (max(l, 0.0) * 0.95 + max(-l, 0.0) * 0.60 + 0.12);
  col += e * 0.06;
  col += exp(-length(p - u_mouse) / (85.0 * u_sf)) * 0.08 * (0.35 + e);
  return col;
}
`;

const CODE = `
vec2 p = cogl_tex_coord_in[0].xy * u_size;
float d = sdDock(p);
vec2 n = normalize(vec2(sdDock(p + vec2(1.0, 0.0)) - sdDock(p - vec2(1.0, 0.0)),
                        sdDock(p + vec2(0.0, 1.0)) - sdDock(p - vec2(0.0, 1.0))) + 1e-5);
vec2 c = u_rect.xy + u_rect.zw * 0.5;
vec3 col = vidrio(p, d, n, c, u_strength, u_lens, u_tint);

for (int i = 0; i < ${MAX_BUTTONS}; i++) {
  if (float(i) < u_ncirc) {
    vec4 ci = u_circ[i];
    float dc = length(p - ci.xy) - ci.z;
    if (dc < 1.0) {
      vec2 nc = normalize(p - ci.xy + 1e-5);
      vec3 g = vidrio(p, dc, nc, ci.xy, 20.0 * u_sf, 0.20, u_tint * 0.35 - 0.08 * ci.w);
      col = mix(col, g, smoothstep(1.0, -0.6, dc));
    }
  }
}

// cogl_color_in carries the actor's opacity: the glass fades with the island and the card.
float alfa = smoothstep(1.0, -0.6, d) * cogl_color_in.a;
cogl_color_out = vec4(clamp(col, 0.0, 1.0) * alfa, alfa);
`;

const Refraction = GObject.registerClass(
class IslaRefraction extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    }

    set(name, size, values) {
        this.set_uniform_float(this.get_uniform_location(name), size, values);
    }
});

export const Lens = GObject.registerClass(
class IslaLens extends St.Widget {
    // margin: room around the target for the pixels the edge bends in (px, logical).
    _init({monitorIndex, margin, scale}) {
        super._init({clip_to_allocation: true, reactive: false});
        this._monitorIndex = monitorIndex;
        this._sf = scale;
        this._around = Math.round(margin * scale);
        this._radius = 0;
        this._look = {tint: 0.46, strength: 28};
        this._buttons = [];
        this._mouse = [-1000, -1000];
        this._holder = new St.Widget();
        this.add_child(this._holder);
        this._effect = new Refraction();
        this.add_effect(this._effect);
        this._manager = new Background.BackgroundManager({
            container: this._holder,
            monitorIndex,
            vignette: false,
            controlPosition: false,
        });
        this._changedId = this._manager.connect('changed', () => this._blur());
        this._blur();
        // The wallpaper copy stays still while the island slides to hide.
        this.connect('notify::translation-y', () => {
            const bg = this._manager?.backgroundActor;
            if (bg)
                bg.translation_y = -this.translation_y;
        });
        this.connect('destroy', () => {
            this._gone = true;
            this._drop();
        });
    }

    _blur() {
        const actor = this._manager?.backgroundActor;
        if (!actor)
            return;
        actor.remove_effect_by_name('blur');
        const effect = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, brightness: 0.9});
        if (HAS_BLUR_RADIUS)
            effect.radius = 18 * this._sf;
        else
            effect.sigma = 9 * this._sf;
        actor.add_effect_with_name('blur', effect);
        this.queue_relayout();
    }

    _drop() {
        if (!this._manager)
            return;
        this._manager.disconnect(this._changedId);
        this._manager.destroy();
        this._manager = null;
    }

    configure({tint, strength}) {
        this._look = {tint, strength};
        this._sendLook();
        this.queue_redraw();
    }

    setRadius(radius) {
        if (radius === this._radius)
            return;
        this._radius = radius;
        this._effect.set('u_radius', 1, [radius]);
        this.queue_redraw();
    }

    // buttons: [[cx, cy, r, focus], ...] in stage coordinates.
    setButtons(buttons) {
        if (this._gone)
            return;
        this._buttons = buttons.slice(0, MAX_BUTTONS);
        this._sendButtons();
    }

    // In stage coordinates; null when the pointer is away.
    setMouse(point) {
        // The Shell shutting down destroys the lens before the island's last leave-event.
        if (this._gone)
            return;
        this._mouse = point ?? [-1000, -1000];
        this._sendMouse();
    }

    _origin() {
        const [x, y] = this.get_transformed_position();
        return [x, y];
    }

    _sendLook() {
        this._effect.set('u_tint', 1, [this._look.tint]);
        this._effect.set('u_strength', 1, [this._look.strength * this._sf]);
        this._effect.set('u_lens', 1, [0.06]);
        this._effect.set('u_sf', 1, [this._sf]);
    }

    _sendButtons() {
        const [ox, oy] = this._origin();
        const flat = [];
        for (const [cx, cy, r, focus] of this._buttons)
            flat.push(cx - ox, cy - oy, r, focus);
        while (flat.length < MAX_BUTTONS * 4)
            flat.push(0, 0, 0, 0);
        this._effect.set('u_circ', 4, flat);
        this._effect.set('u_ncirc', 1, [this._buttons.length]);
        this.queue_redraw();
    }

    _sendMouse() {
        const [ox, oy] = this._origin();
        const [mx, my] = this._mouse;
        this._effect.set('u_mouse', 2, mx < -999 ? [-1000, -1000] : [mx - ox, my - oy]);
        this.queue_redraw();
    }

    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [w, h] = [box.get_width(), box.get_height()];
        const m = this._around;
        this._effect.set('u_size', 2, [w, h]);
        this._effect.set('u_rect', 4, [m, m, Math.max(0, w - 2 * m), Math.max(0, h - 2 * m)]);
        this._sendLook();
        const holder = new Clutter.ActorBox();
        holder.set_size(w, h);
        this._holder.allocate(holder);
        const actor = this._manager?.backgroundActor;
        const mon = Main.layoutManager.monitors[this._monitorIndex];
        const strip = this.get_parent();
        if (!actor || !mon || !strip)
            return;
        // The part of the wallpaper under the lens shows here.
        const b = new Clutter.ActorBox();
        b.set_origin(-(strip.x + box.x1 - mon.x), -(strip.y + box.y1 - mon.y));
        b.set_size(mon.width, mon.height);
        actor.allocate(b);
    }
});
