// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// One colored dot per open app, in the folded island. The color is the main
// color of the app's icon, computed once per app (16×16, ignoring transparent,
// white and black pixels). An app with an unread notice gets a ring.
// With no app open and nothing else to show, three white dots keep the island
// from being an empty pill.
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import St from 'gi://St';

const DOT = 8, GAP = 8;
const FALLBACK = [128, 134, 148];
const RESTING = 3;

const _colors = new Map();     // app id -> [r, g, b]
let _theme = null;

// Average color of an image, leaving out transparent, almost white and almost
// black pixels; colorful pixels count more than grey ones. null if none is left.
// plain: a true average of every pixel (the light of a wallpaper).
export function averageColor(pixbuf, plain = false) {
    const px = pixbuf.get_pixels();
    const n = pixbuf.get_n_channels(), stride = pixbuf.get_rowstride();
    const alpha = pixbuf.get_has_alpha();
    let r = 0, g = 0, b = 0, w = 0;
    for (let y = 0; y < pixbuf.get_height(); y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const i = y * stride + x * n;
            const a = alpha ? px[i + 3] / 255 : 1;
            const max = Math.max(px[i], px[i + 1], px[i + 2]), min = Math.min(px[i], px[i + 1], px[i + 2]);
            if (!plain && (a < 0.5 || max < 28 || min > 232))
                continue;
            const weight = plain ? a : a * (0.2 + (max - min) / 255);
            r += px[i] * weight;
            g += px[i + 1] * weight;
            b += px[i + 2] * weight;
            w += weight;
        }
    }
    return w ? [r / w, g / w, b / w].map(Math.round) : null;
}

// Path of the image behind a Gio.Icon (a file or a themed name).
function iconPath(gicon) {
    if (gicon instanceof Gio.FileIcon)
        return gicon.get_file().get_path();
    if (!gicon)
        return null;
    // One theme for every lookup: a new one would read the theme's folders again each time.
    _theme ??= new St.IconTheme();
    return _theme.lookup_by_gicon(gicon, 32, 0)?.get_filename() ?? null;
}

export function iconColor(id, gicon) {
    if (_colors.has(id))
        return _colors.get(id);
    let color = null;
    try {
        const path = iconPath(gicon);
        if (path)
            color = averageColor(GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 16, 16, false));
    } catch {}
    color ??= FALLBACK;
    _colors.set(id, color);
    return color;
}

export class Dots {
    constructor(state) {
        this._state = state;
        this._unread = new Set();
        this._running = [];
        this.actor = new St.BoxLayout({style_class: 'isla-dots'});
        this._ids = [
            state.connect('apps-changed', (_s, running) => {
                this._running = running;
                this._update();
            }),
            state.connect('skin-changed', () => this._update()),
            state.connect('command', (_s, name, appId, on) => {
                if (name !== 'unread')
                    return;
                if (on)
                    this._unread.add(appId);
                else
                    this._unread.delete(appId);
                this._update();
            }),
        ];
    }

    get count() {
        return this._running.length;
    }

    // The three white dots, when nothing else is in the folded island.
    setResting(on) {
        if (this._resting === on)
            return;
        this._resting = on;
        this._update();
    }

    setScale(f) {
        this._f = f;
        this.actor.style = `spacing: ${Math.round(GAP * f)}px;`;
        this._update();
    }

    _update() {
        const f = this._f ?? 1;
        const size = Math.round(DOT * f);
        const resting = this._resting && !this._running.length;
        const wanted = resting ? RESTING : this._running.length;
        const dots = this.actor.get_children();
        while (dots.length > wanted)
            dots.pop().destroy();
        while (dots.length < wanted) {
            const dot = new St.Widget({style_class: 'isla-dot', y_align: Clutter.ActorAlign.CENTER});
            this.actor.add_child(dot);
            dots.push(dot);
        }
        if (resting) {
            const style = `width: ${size}px; height: ${size}px; border-radius: ${size}px; background-color: rgba(255, 255, 255, 0.9);`;
            dots.forEach(dot => {
                dot._color = [255, 255, 255];
                if (dot.style !== style)
                    dot.style = style;
            });
            return;
        }
        this._running.forEach(({id, gicon}, i) => {
            const color = iconColor(id, gicon);
            const [r, g, b] = color;
            const ring = this._unread.has(id);
            dots[i]._color = color;
            const style = `width: ${size}px; height: ${size}px; border-radius: ${size}px; background-color: rgb(${r}, ${g}, ${b});` +
                (ring ? ` border: ${Math.max(1, Math.round(f * 1.5))}px solid rgba(255, 255, 255, 0.95); box-shadow: 0 0 0 1px rgb(${r}, ${g}, ${b});` : '');
            if (dots[i].style !== style)
                dots[i].style = style;
        });
    }

    destroy() {
        this._ids.forEach(id => this._state.disconnect(id));
        this.actor.destroy();
        // Nothing of IslaDock stays in memory once it is switched off.
        _colors.clear();
        _theme = null;
    }
}
