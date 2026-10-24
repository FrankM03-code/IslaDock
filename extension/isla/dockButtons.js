// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The three accent buttons of the dock: the app launcher, Portapapeles and
// Ajustes, as big as the app icons, with a symbol drawn by hand (four dots, a
// clipboard, two sliders). Their look is chosen in Preferences ('accent-style',
// see accentStyles.js). They grow on hover like the icons and light up a little;
// pressed they sink to 0.92, and while their panel (or the app grid) is open they
// stay pressed and the symbol makes its gesture: the dots turn into a diamond, the
// clipboard's short line grows, the slider knobs cross. Portapapeles also carries
// a badge in the accent color with how many items it keeps.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import {accentRGB, watchAccent} from './accent.js';
import {ACCENT_STYLES, DEFAULT_ACCENT, accentLook, rgba} from './accentStyles.js';
import {SYMBOLS} from './symbols.js';
import {ms} from './timing.js';

const GRAPHITE = '#1C1D20';
const PAPER = '#F7F6F3';

const DESIGN = 40;                  // the button of the design
const CIRCLE = 0.94;                // the button, of the dock's icon tile
// The symbol, of the button: the clipboard bigger so it reads at dock size.
const SYMBOL = {apps: 0.46, clipboard: 0.58, power: 0.52};
const GESTURE_TIME = 280;
const BOUNCE = [new Graphene.Point({x: 0.3, y: 1.4}), new Graphene.Point({x: 0.5, y: 1})];

export const DockButton = GObject.registerClass(
class IslaDockButton extends St.Widget {
    _init(kind) {
        super._init({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._kind = kind;
        // The shape (circle, square or leaf) with the symbol.
        this._circle = new St.Widget({layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._circle.set_pivot_point(0.5, 0.5);
        this._symbol = new St.DrawingArea({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._symbol.connect('repaint', area => this._draw(area));
        this._circle.add_child(this._symbol);
        // Marcador's accent bar on the outer edge: centered, then moved there in setSize
        // (the alignment alone is not honored here).
        this._marker = new St.Widget({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._circle.add_child(this._marker);
        this.add_child(this._circle);
        // The badge on the top right corner (placed by _placeBadge, it grows with "99+").
        this._badge = new St.Label({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._badge.connect('notify::width', () => this._placeBadge());
        this.add_child(this._badge);
        this._u = 1;
        this._count = 0;
        this._t = 0;
        this._timeline = null;
        this._light = true;
        this._dark = false;
        this._style = DEFAULT_ACCENT;
        this._hover = this._open = this._focused = this._pressed = false;
        // GNOME's accent color changed: repaint in the new one.
        const unwatch = watchAccent(() => this._paint());
        this.connect('destroy', () => {
            unwatch();
            this._stop();
        });
        this.connect('notify::mapped', () => this.mapped && this._placeBadge());
        this._paint();
    }

    _sf() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    // The tile size in logical px (the tile itself is scaled to the dock's size).
    setSize(px) {
        const sf = this._sf();
        const d = px * CIRCLE;
        this._u = d / DESIGN;
        this.set_size(Math.round(px * sf), Math.round(px * sf));
        this._circle.set_size(Math.round(d * sf), Math.round(d * sf));
        const s = Math.round(d * SYMBOL[this._kind] * sf);
        this._symbol.set_size(s, s);
        this._marker.translation_x = Math.round((this._kind === 'apps' ? -1 : 1) * (d / 2 - 2.5 * this._u) * sf);
        this._paint();
    }

    // Over a light island (Cristal, Marcador and the badge's ring follow it).
    setLight(on) {
        this._light = on;
        this._paint();
    }

    // Hoja's dark palette.
    setPalette(dark) {
        this._dark = dark;
        this._paint();
    }

    // One of ACCENT_STYLES; an unknown (older) one falls back to the default.
    setStyle(style) {
        this._style = ACCENT_STYLES.includes(style) ? style : DEFAULT_ACCENT;
        this._paint();
    }

    // Number in the badge (0 hides it).
    setCount(n) {
        this._count = n;
        this._badge.text = n > 99 ? '99+' : `${n}`;
        this._paint();
    }

    _paint() {
        const u = this._u;
        const sf = this._sf();
        const px = n => `${(n * u).toFixed(2)}px`;
        // Edges exactly one device pixel: a fractional one blurs into a pale rim.
        const hair = `${1 / sf}px`;
        const look = accentLook(this._style, this._open || this._pressed ? 2 : this._hover ? 1 : 0, this._light, this._dark,
            accentRGB());
        const ring = this._focused
            ? ` box-shadow: 0 0 0 ${px(2)} ${this._light ? 'rgba(28, 29, 32, 0.45)' : 'rgba(247, 246, 243, 0.55)'};` : '';
        let radius = px(13);
        if (look.shape === 'circle') {
            radius = px(DESIGN);
        } else if (look.shape === 'leaf') {
            // The nearly square corner low and towards the outer end of the dock.
            const [r, c] = [px(20), px(6)];
            radius = this._kind === 'apps' ? `${r} ${r} ${r} ${c}` : `${r} ${r} ${c} ${r}`;
        }
        this._circle.style = `border-radius: ${radius}; background-color: ${look.fill}; border: ${hair} solid ${look.border};` +
            `${look.borderBottom ? ` border-bottom-color: ${look.borderBottom};` : ''}${ring}`;
        this._ink = rgba(look.ink).slice(0, 3);
        this._marker.visible = !!look.marker;
        const r3 = px(3);
        this._marker.style = `width: ${px(3)}; height: ${px(22)}; background-color: ${look.marker || 'transparent'};` +
            ` border-radius: ${this._kind === 'apps' ? `0 ${r3} ${r3} 0` : `${r3} 0 0 ${r3}`};`;
        this._badge.visible = this._count > 0;
        this._badge.style = `min-width: ${px(8)}; height: ${px(14)}; padding: 0 ${px(4)}; border-radius: ${px(8)};` +
            ` font-weight: bold; font-size: ${px(10)}; text-align: center;` +
            ` background-color: ${look.badge[0]}; color: ${look.badge[1]}; border: ${hair} solid ${this._light ? PAPER : GRAPHITE};`;
        this._placeBadge();
        this._symbol.queue_repaint();
    }

    // Hanging off the button's top right corner (about 5 px up and 6 px out), clear of the symbol.
    _placeBadge() {
        if (!this.get_stage())
            return;
        const px = this._u * this._sf();
        const half = DESIGN / 2 * px;
        this._badge.translation_x = Math.round(half + 6 * px - this._badge.width / 2);
        this._badge.translation_y = Math.round(-half - 5 * px + this._badge.height / 2);
    }

    _draw(area) {
        const cr = area.get_context();
        const [w] = area.get_surface_size();
        cr.scale(w / 24, w / 24);
        cr.setSourceRGB(...this._ink ?? [1, 1, 1]);
        cr.setLineWidth(2);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        SYMBOLS[this._kind](cr, this._t);
        cr.$dispose();
    }

    // The symbol's gesture, from where it is now to `to`.
    _gesture(to, animate) {
        this._stop();
        const from = this._t;
        if (!animate || from === to) {
            this._t = to;
            this._symbol.queue_repaint();
            return;
        }
        const timeline = this._timeline = new Clutter.Timeline({actor: this, duration: ms(GESTURE_TIME)});
        timeline.set_cubic_bezier_progress(...BOUNCE);
        timeline.connect('new-frame', () => {
            this._t = from + (to - from) * timeline.get_progress();
            this._symbol.queue_repaint();
        });
        timeline.connect('completed', () => {
            this._t = to;
            this._symbol.queue_repaint();
            this._stop();
        });
        timeline.start();
    }

    _stop() {
        this._timeline?.stop();
        this._timeline = null;
    }

    // ---------- states ----------
    setHover(on) {
        this._hover = on;
        this._paint();
    }

    setOpen(on) {
        if (this._open === on)
            return;
        this._open = on;
        this._paint();
        this._gesture(on ? 1 : 0, !!this.mapped && St.Settings.get().enable_animations);
    }

    setFocused(on) {
        this._focused = on;
        this._paint();
    }

    setPressed(on) {
        if (this._pressed === on)
            return;
        this._pressed = on;
        this._paint();
        const scale = on ? 0.92 : 1;
        this._circle.ease({scale_x: scale, scale_y: scale, duration: ms(on ? 80 : 120),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
});
