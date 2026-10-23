// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The applications button ("Mazo"): a rounded graphite square, the size of the
// dock's icons, holding three white cards stacked like a deck (the apps).
// Hover lifts it a little and the cards fan out with a small bounce; pressed
// it sinks; with the app grid open the square turns blue and the fan stays open.
// Sizes follow a 52 px tile, scaled to the dock's icon tile.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {ms} from './timing.js';

// The blue of the open state (and the focus ring), in one place.
export const ACCENT = [0x2f, 0x7d, 0xe1];

const DESIGN = 52;
const SQUARE = 42;                       // the rounded square, of the 52 px tile
const CARD = [13, 18];                   // each card (width, height)
// Per card (back left, back right, front): rest and fanned positions.
const REST = [{x: -3, y: 0, angle: -6}, {x: 3, y: 0, angle: 6}, {x: 0, y: 1, angle: 0}];
const FAN = [{x: -6, y: 1, angle: -20}, {x: 6, y: 1, angle: 20}, {x: 0, y: -2, angle: 0}];
const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a})`;

export const AppsButton = GObject.registerClass(
class IslaAppsButton extends St.Widget {
    _init() {
        super._init({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._square = new St.Widget({layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._square.set_pivot_point(0.5, 0.5);
        // Back cards first, the front one on top.
        this._cards = REST.map((_p, i) => {
            const card = new St.Widget({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
                opacity: i < 2 ? 200 : 255});
            card.set_pivot_point(0.5, 1);
            this._square.add_child(card);
            return card;
        });
        this.add_child(this._square);
        this._u = 1;
        this._hover = this._open = this._focused = this._pressed = false;
        this._fanned = null;
        this._paint();
        this._moveCards(false);
    }

    _sf() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    // The tile size in logical px (the tile itself is scaled to the dock's size).
    setSize(px) {
        this._u = px / DESIGN;
        const sf = this._sf();
        this.set_size(Math.round(px * sf), Math.round(px * sf));
        const side = Math.round(SQUARE * this._u * sf);
        this._square.set_size(side, side);
        for (const card of this._cards)
            card.set_size(Math.round(CARD[0] * this._u * sf), Math.round(CARD[1] * this._u * sf));
        this._paint();
        this._moveCards(false);
    }

    // Kept for the skins' contrast hint: the graphite square reads on any island.
    setLight(_on) {}

    _paint() {
        const u = this._u;
        const [top, bottom] = this._open ? ['#4C93EE', rgba(ACCENT, 1)]
            : this._hover || this._focused ? ['#5A6273', '#3A404C'] : ['#4E5564', '#323742'];
        const focus = this._focused ? ` box-shadow: 0 0 0 ${(2 * u).toFixed(2)}px ${rgba(ACCENT, 0.6)};`
            : ` box-shadow: 0 ${(1.5 * u).toFixed(2)}px ${(4 * u).toFixed(2)}px rgba(0, 0, 0, 0.28);`;
        this._square.style = `border-radius: ${(12 * u).toFixed(2)}px;` +
            ` background-gradient-direction: vertical; background-gradient-start: ${top}; background-gradient-end: ${bottom};` +
            ` border: ${(1 * u).toFixed(2)}px solid rgba(255, 255, 255, 0.10);${focus}`;
        for (const card of this._cards) {
            card.style = `background-color: #ffffff; border-radius: ${(3.5 * u).toFixed(2)}px;` +
                ` box-shadow: 0 ${(1 * u).toFixed(2)}px ${(2 * u).toFixed(2)}px rgba(0, 0, 0, 0.30);`;
        }
    }

    // Fanned out on hover and while the grid is open.
    _moveCards(animate) {
        const fanned = this._hover || this._open;
        if (fanned === this._fanned && animate)
            return;
        this._fanned = fanned;
        const px = this._u * this._sf();
        (fanned ? FAN : REST).forEach((p, i) => {
            const card = this._cards[i];
            card.remove_all_transitions();
            const target = {translation_x: p.x * px, translation_y: p.y * px, rotation_angle_z: p.angle};
            if (!animate)
                card.set(target);
            else
                card.ease({...target, delay: fanned && i === 2 ? ms(40) : 0, duration: ms(fanned ? 320 : 200),
                    mode: fanned ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_QUAD});
        });
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
        this._update();
    }

    setPressed(on) {
        if (this._pressed === on)
            return;
        this._pressed = on;
        const scale = on ? 0.92 : 1;
        this._square.ease({scale_x: scale, scale_y: scale, duration: ms(on ? 80 : 160),
            mode: on ? Clutter.AnimationMode.EASE_OUT_QUAD : Clutter.AnimationMode.EASE_OUT_BACK});
    }

    _update() {
        this._paint();
        const lift = this._hover ? -3 * this._u * this._sf() : 0;
        if (this._square.translation_y !== lift)
            this._square.ease({translation_y: lift, duration: ms(180), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._moveCards(true);
    }
});
