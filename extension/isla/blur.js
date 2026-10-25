// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Blurred backdrop of the island: a blurred copy of the wallpaper under it,
// with rounded corners. The blur is computed once, not every frame.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';

const BLUR_RADIUS = 30;

export function blurEffect(radius, brightness = 1) {
    return new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, brightness, radius});
}

// Rounded-corner mask for the blurred backdrop (Clutter can only clip rectangles).
const RoundedMask = GObject.registerClass(
class IslaRoundedMask extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            'uniform vec2 size; uniform float radius; uniform vec2 corners;',
            `vec2 p = cogl_tex_coord_in[0].xy * size;
             float r = radius;
             bool cx = p.x < r || p.x > size.x - r;
             bool cy = (p.y < r && corners.x > 0.5) || (p.y > size.y - r && corners.y > 0.5);
             if (r > 0.0 && cx && cy) {
                 vec2 c = vec2(clamp(p.x, r, size.x - r), clamp(p.y, r, size.y - r));
                 cogl_color_out *= clamp(r - length(p - c) + 0.5, 0.0, 1.0);
             }`,
            false);
    }

    setShape(width, height, radius, corners) {
        this.set_uniform_float(this.get_uniform_location('size'), 2, [width, height]);
        this.set_uniform_float(this.get_uniform_location('radius'), 1, [radius]);
        this.set_uniform_float(this.get_uniform_location('corners'), 2,
            [corners === 'none' ? 0 : 1, corners === 'all' ? 1 : 0]);
        this.queue_repaint();
    }
});

// Blurred backdrop: a blurred copy of the wallpaper behind the dock. The blur is
// computed once (not every frame, unlike a live background blur, which also
// smears the dock's own previous frame into itself while it animates).
export const BlurLayer = GObject.registerClass(
class IslaBlur extends St.Widget {
    _init(monitorIndex) {
        super._init({x_expand: true, y_expand: true, clip_to_allocation: true});
        this._monitorIndex = monitorIndex;
        this._radius = 0;
        this._corners = 'none';
        this._scale = 1;
        this._mask = new RoundedMask();
        this.add_effect(this._mask);
        this._manager = null;
        // Destroyed with its panel: the wallpaper source is shared and counted, and its
        // 'bg-changed' would otherwise rebuild a copy inside this dead actor.
        this.connect('destroy', () => this._drop());
    }

    // look: {radius, brightness} of the blur (a skin's choice).
    configure(enabled, radius = 0, corners = 'none', scale = 1, look = {}) {
        this._look = {radius: BLUR_RADIUS, brightness: 1, ...look};
        this._radius = radius * scale;
        this._corners = corners;
        this._scale = scale;
        if (!enabled) {
            this._drop();
            this.hide();
            return false;
        }
        try {
            if (!this._manager) {
                this._manager = new Background.BackgroundManager({
                    container: this,
                    monitorIndex: this._monitorIndex,
                    vignette: false,
                    controlPosition: false,
                });
                this._changedId = this._manager.connect('changed', () => this._blurActor());
            }
            this._blurActor();
        } catch (e) {
            console.warn(`isla-dock: sin desenfoque (${e.message})`);
            this._drop();
            this.hide();
            return false;
        }
        this.show();
        this.queue_relayout();
        return true;
    }

    _blurActor() {
        const actor = this._manager?.backgroundActor;
        if (!actor)
            return;
        const look = this._look;
        actor.remove_effect_by_name('blur');
        actor.add_effect_with_name('blur', blurEffect(look.radius * this._scale, look.brightness));
        this.queue_relayout();
    }

    _drop() {
        if (this._manager) {
            this._manager.disconnect(this._changedId);
            this._manager.destroy();
            this._manager = null;
        }
    }

    // Follows the dock while it slides in and out.
    set slide(dy) {
        const actor = this._manager?.backgroundActor;
        if (actor)
            actor.translation_y = -dy;
    }

    // The wallpaper inside is monitor-sized: it must not make the dock grow.
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [w, h] = [box.get_width(), box.get_height()];
        this._mask.setShape(w, h, Math.min(this._radius, h / 2, w / 2), this._corners);
        const actor = this._manager?.backgroundActor;
        if (!actor)
            return;
        // Place the wallpaper so its part under the dock shows here.
        const mon = Main.layoutManager.monitors[this._monitorIndex];
        const bar = this.get_parent();
        const container = bar?.get_parent();
        if (!mon || !container)
            return;
        const x = container.x + bar.x - mon.x;
        const y = container.y + bar.y - mon.y;
        const child = new Clutter.ActorBox();
        child.set_origin(-x, -y);
        child.set_size(mon.width, mon.height);
        actor.allocate(child);
    }
});
