// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Cuadrícula: many downloads as tiles in 4 columns on a rounded panel above
// the button, with a small arrow pointing at it and "Abrir carpeta" below.
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {progressBar} from './bar.js';
import {setSource} from './color.js';
import {ms} from '../timing.js';

const COLUMNS = 4;
const TILE_W = 76, TILE_H = 92;
const ICON = 48;
const SPACING = 8;
const ARROW = 10;
const IN_TIME = 160;
const OUT_TIME = 120;

export class GridView {
    constructor({style, sf, on, labels = null}) {
        this._style = style;
        this._labels = labels;
        this._sf = sf;
        this._on = on;
        this._tiles = [];
        const s = style;
        // Panel on top, arrow under it (both placed by hand in place()).
        this.actor = new St.Widget({reactive: true});
        this._panel = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style: `padding: 14px; border-radius: 16px; background-color: ${s.panelFill}; border: 1px solid ${s.panelBorder};` +
                ` box-shadow: 0 6px 20px ${s.shadow}; spacing: 10px;`});
        this._layout = new Clutter.GridLayout({column_spacing: Math.round(SPACING * sf), row_spacing: Math.round(SPACING * sf)});
        this._grid = new St.Widget({layout_manager: this._layout});
        this._panel.add_child(this._grid);

        const footer = new St.BoxLayout({style: 'spacing: 10px;'});
        this._count = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: 12px; color: ${s.textSecondary};`});
        this._folderButton = new St.Button({label: labels?.folder ?? 'Abrir carpeta', can_focus: true, reactive: true, track_hover: true,
            style: this._buttonStyle(false)});
        this._folderButton.connect('notify::hover', () => this._lightButton());
        this._folderButton.connect('key-focus-in', () => this._lightButton());
        this._folderButton.connect('key-focus-out', () => this._lightButton());
        this._folderButton.connect('clicked', () => this._on.folder());
        footer.add_child(this._count);
        footer.add_child(this._folderButton);
        this._panel.add_child(footer);
        this.actor.add_child(this._panel);

        // The arrow is moved under the button by place().
        this._arrow = new St.DrawingArea();
        this._arrow.set_size(Math.round(2 * ARROW * sf), Math.round(ARROW * sf));
        this._arrow.connect('repaint', () => {
            const cr = this._arrow.get_context();
            const [w, h] = this._arrow.get_surface_size();
            cr.moveTo(0, 0);
            cr.lineTo(w, 0);
            cr.lineTo(w / 2, h);
            cr.closePath();
            setSource(cr, s.panelFill);
            cr.fill();
            cr.$dispose();
        });
        this.actor.add_child(this._arrow);
    }

    _buttonStyle(on) {
        const s = this._style;
        return `height: 30px; border-radius: 8px; padding: 0 14px; font-size: 13px; color: ${on ? '#FFFFFF' : s.text};` +
            ` background-color: ${on ? s.accent : s.tileHover}; border: 1px solid ${on ? s.accent : s.panelBorder};`;
    }

    _lightButton() {
        const b = this._folderButton;
        b.style = this._buttonStyle(b.hover || b.has_key_focus());
    }

    _tileStyle(tile) {
        const s = this._style;
        const on = tile.hover || tile.has_key_focus();
        const ring = tile._newest ? `border: 2px solid ${s.accent};` : 'border: 2px solid transparent;';
        return `border-radius: 10px; padding: 6px 2px 4px 2px; ${ring} background-color: ${on ? s.tileHover : 'transparent'};`;
    }

    _tile(entry, newest) {
        const sf = this._sf;
        const s = this._style;
        const tile = new St.Button({reactive: true, can_focus: true, track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE});
        tile._newest = newest;
        tile.entry = entry;
        tile.set_size(Math.round(TILE_W * sf), Math.round(TILE_H * sf));
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style: 'spacing: 5px;'});
        const icon = new St.Icon({gicon: entry.gicon, icon_size: ICON, fallback_icon_name: 'text-x-generic',
            x_align: Clutter.ActorAlign.CENTER});
        box.add_child(icon);
        if (entry.partial) {
            const bar = progressBar(Math.round(ICON * sf), Math.round(3 * sf), s.accent, entry.progress);
            bar.x_align = Clutter.ActorAlign.CENTER;
            box.add_child(bar);
        }
        // Two lines at most, cut with "…".
        const name = new St.Label({text: entry.display, x_align: Clutter.ActorAlign.CENTER, x_expand: true,
            style: `font-size: 11px; text-align: center; color: ${s.text};`});
        const text = name.clutter_text;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        text.ellipsize = Pango.EllipsizeMode.END;
        text.line_alignment = Pango.Alignment.CENTER;
        name.set_height(Math.round(29 * sf));
        box.add_child(name);
        tile.set_child(box);
        tile.accessible_name = entry.display;
        tile.style = this._tileStyle(tile);
        const lit = () => (tile.style = this._tileStyle(tile));
        tile.connect('notify::hover', lit);
        tile.connect('key-focus-in', lit);
        tile.connect('key-focus-out', lit);
        tile.connect('clicked', (_t, button) => (button === 3 ? this._on.menu(entry, tile) : this._on.open(entry)));
        return tile;
    }

    fill(files, total, max) {
        const focused = this._tiles.findIndex(t => t.has_key_focus());
        this._grid.destroy_all_children();
        const accent = this._labels?.accent ?? true;
        this._tiles = files.slice(0, max).map((entry, i) => this._tile(entry, accent && i === 0));
        this._tiles.forEach((tile, i) => this._layout.attach(tile, i % COLUMNS, Math.floor(i / COLUMNS), 1, 1));
        this._count.text = this._labels?.count ? this._labels.count(total) : `Recientes: ${total}`;
        if (focused >= 0)
            this.focus(Math.min(focused, this._tiles.length - 1));
    }

    place(centerX, islandTop, area) {
        const sf = this._sf;
        const [, w] = this._panel.get_preferred_width(-1);
        const [, ph] = this._panel.get_preferred_height(w);
        const arrowH = Math.round(ARROW * sf), arrowW = 2 * arrowH;
        const h = ph + arrowH - 1;
        let x = centerX - w / 2;
        x = Math.min(Math.max(x, area.x + 4 * sf), area.x + area.width - w - 4 * sf);
        const y = Math.max(islandTop - 10 * sf - h, area.y + 4 * sf);
        this._panel.set_position(0, 0);
        this._panel.set_size(w, ph);
        // The arrow stays over the button even when the panel was pushed aside.
        const ax = Math.min(Math.max(centerX - x - arrowW / 2, 16 * sf), w - arrowW - 16 * sf);
        this._arrow.set_position(Math.round(ax), ph - 1);
        this.actor.set_size(w, h);
        this.actor.set_position(Math.round(x), Math.round(y));
        this.actor.set_pivot_point(Math.min(1, Math.max(0, (centerX - x) / w)), 1);
    }

    animateIn() {
        this.actor.set({scale_x: 0.92, scale_y: 0.92, opacity: 0});
        this.actor.ease({scale_x: 1, scale_y: 1, opacity: 255, duration: ms(IN_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    animateOut(done) {
        this.actor.ease({scale_x: 0.92, scale_y: 0.92, opacity: 0, duration: ms(OUT_TIME),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD, onStopped: done});
    }

    focus(index) {
        this._tiles[Math.max(0, Math.min(index, this._tiles.length - 1))]?.grab_key_focus();
    }

    navigate(symbol) {
        const i = this._tiles.findIndex(t => t.has_key_focus());
        const move = {[Clutter.KEY_Left]: -1, [Clutter.KEY_Right]: 1, [Clutter.KEY_Up]: -COLUMNS, [Clutter.KEY_Down]: COLUMNS}[symbol];
        if (move === undefined)
            return false;
        if (i < 0) {
            this.focus(0);
            return true;
        }
        const next = i + move;
        if (next >= this._tiles.length && symbol === Clutter.KEY_Down)
            this._folderButton.grab_key_focus();
        else if (next >= 0 && next < this._tiles.length)
            this.focus(next);
        return true;
    }

    destroy() {
        this.actor.destroy();
        this._tiles = [];
    }
}
