// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Cascada diagonal: few downloads as cells leaning 14° that climb in steps from
// the button, no panel around them. The cells are drawn with cairo; the icon
// and the text sit on top, upright.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {progressBar} from './bar.js';
import {setSource} from './color.js';
import {relativeTime} from './fileActions.js';
import {ms} from '../timing.js';

const CELL_W = 260;
const CELL_H = 44;
const GAP = 6;
const SLANT = Math.tan(14 * Math.PI / 180);
const STEP = Math.round(CELL_H * SLANT);   // 11 px to the left per row
const PAD = 4;                             // room for the shadow
const ICON = 28;
const ICON_LEFT = 14;
const STAGGER = 30;
const IN_TIME = 180;
const OUT_TIME = 120;
const HOVER_TIME = 100;
const HOVER_SHIFT = 4;

// The parallelogram "\": its top edge starts at the left, the bottom one ends at the right.
function shape(cr, x, y, w, h, d) {
    cr.moveTo(x, y);
    cr.lineTo(x + w - d, y);
    cr.lineTo(x + w, y + h);
    cr.lineTo(x + d, y + h);
    cr.closePath();
}

const Cell = GObject.registerClass(
class IslaStackCell extends St.Button {
    _init({entry, style, sf, newest, label = null, detail = '', iconName = null}) {
        super._init({reactive: true, track_hover: true, can_focus: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE});
        this.entry = entry;
        this._style = style;
        this._sf = sf;
        this._newest = newest;
        const pad = PAD * sf;
        const d = STEP * sf;
        const [w, h] = [Math.round(CELL_W * sf + 2 * pad), Math.round(CELL_H * sf + 2 * pad)];
        this.set_size(w, h);

        // The button gives its child only its natural size: the body and its layers are placed by hand.
        const body = new St.Widget({width: w, height: h});
        this._area = new St.DrawingArea({width: w, height: h});
        this._area.connect('repaint', () => this._draw());
        body.add_child(this._area);

        // Upright content, starting 14 px after the leaning left edge (at mid height).
        const content = new St.BoxLayout({width: w, height: h,
            style: `padding-left: ${Math.round(PAD + STEP / 2 + ICON_LEFT)}px; padding-right: ${Math.round(PAD + STEP / 2 + 12)}px;` +
                ' spacing: 10px;'});
        const icon = new St.Icon({icon_size: ICON, fallback_icon_name: 'text-x-generic', y_align: Clutter.ActorAlign.CENTER});
        if (iconName)
            icon.icon_name = iconName;
        else
            icon.gicon = entry?.gicon ?? null;
        const name = new St.Label({text: label ?? entry.display, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: 13px; font-weight: normal; color: ${style.text};`});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._time = new St.Label({text: detail, y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: 11px; color: ${style.textSecondary};`});
        content.add_child(icon);
        content.add_child(name);
        content.add_child(this._time);
        body.add_child(content);

        // A download in progress: a strip along the bottom edge.
        if (entry?.partial) {
            const barH = Math.round(3 * sf);
            const bar = progressBar(Math.round(CELL_W * sf - d - 2 * pad), barH, style.accent, entry.progress);
            bar.set_position(Math.round(pad + d + pad), Math.round(h - pad - sf - barH));
            body.add_child(bar);
        }
        this.set_child(body);
        this.accessible_name = label ?? entry.display;

        const lit = () => {
            const on = this.hover || this.has_key_focus();
            this._area.queue_repaint();
            this.ease({translation_x: on ? -HOVER_SHIFT * sf : 0, duration: ms(HOVER_TIME),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        };
        this.connect('notify::hover', lit);
        this.connect('key-focus-in', lit);
        this.connect('key-focus-out', lit);
    }

    // Sizes come from the surface: reading the actor's here would relayout.
    _draw() {
        const cr = this._area.get_context();
        const [w, h] = this._area.get_surface_size();
        const s = this._style;
        const sf = this._sf;
        const p = PAD * sf;
        const d = STEP * sf;
        const cw = w - 2 * p, ch = h - 2 * p;
        const on = this.hover || this.has_key_focus();
        // A soft shadow under the same leaning shape.
        for (let i = 1; i <= 3; i++) {
            shape(cr, p, p + i * sf * 0.8, cw, ch, d);
            setSource(cr, s.shadow, 0.35);
            cr.fill();
        }
        shape(cr, p, p, cw, ch, d);
        setSource(cr, on ? s.cellHover : s.cellFill);
        cr.fillPreserve();
        cr.save();
        cr.clip();
        // The newest: a 4 px strip along the leaning left edge.
        if (this._newest) {
            const t = 4 * sf;
            cr.moveTo(p, p);
            cr.lineTo(p + t, p);
            cr.lineTo(p + d + t, p + ch);
            cr.lineTo(p + d, p + ch);
            cr.closePath();
            setSource(cr, s.accent);
            cr.fill();
        }
        cr.restore();
        shape(cr, p + 0.5, p + 0.5, cw - 1, ch - 1, d);
        setSource(cr, on ? s.accent : s.cellBorder);
        cr.setLineWidth(Math.max(1, sf));
        cr.stroke();
        cr.$dispose();
    }
});

export class CascadeView {
    // files: newest first · max: cells at most · on: {open(entry), menu(entry, cell), folder()}
    // labels: {folder, accent} to word it for something other than downloads.
    constructor({style, sf, on, labels = null}) {
        this._style = style;
        this._labels = labels;
        this._sf = sf;
        this._on = on;
        this.actor = new St.Widget({reactive: true});
        this._cells = [];
    }

    // Rebuilt in its place (the stack stays open while the folder changes).
    fill(files, total, max) {
        const focused = this._cells.findIndex(c => c.has_key_focus());
        this.actor.destroy_all_children();
        const more = total > Math.min(files.length, max);
        const shown = files.slice(0, more ? Math.max(1, max - 1) : max);
        const accent = this._labels?.accent ?? true;
        const cells = shown.map((entry, i) => new Cell({entry, style: this._style, sf: this._sf, newest: accent && i === 0,
            detail: entry.detail ?? (entry.partial ? 'descargando' : relativeTime(entry.time))}));
        if (more || !shown.length) {
            const rest = total - shown.length;
            const folder = this._labels?.folder ?? 'Abrir carpeta';
            cells.push(new Cell({entry: null, style: this._style, sf: this._sf, newest: false,
                label: rest > 0 ? `${folder} · ${rest} más` : folder, iconName: 'folder-open-symbolic'}));
        }
        const sf = this._sf;
        const n = cells.length;
        const step = STEP * sf, rowH = (CELL_H + GAP) * sf;
        // The bottom cell (the newest) is the rightmost; each row above moves left along the diagonal.
        cells.forEach((cell, i) => {
            cell.set_position(Math.round((n - 1 - i) * step), Math.round((n - 1 - i) * rowH));
            cell.connect('clicked', (_c, button) => {
                if (!cell.entry)
                    this._on.folder();
                else if (button === 3)
                    this._on.menu(cell.entry, cell);
                else
                    this._on.open(cell.entry);
            });
            this.actor.add_child(cell);
        });
        this._cells = cells;
        const pad = PAD * sf;
        this.actor.set_size(Math.round((n - 1) * step + CELL_W * sf + 2 * pad), Math.round((n - 1) * rowH + CELL_H * sf + 2 * pad));
        if (focused >= 0)
            this.focus(Math.min(focused, n - 1));
    }

    // Where the newest cell's middle must stand: x over the button, y 10 px above the island.
    place(centerX, islandTop, area) {
        const sf = this._sf;
        const pad = PAD * sf;
        const n = this._cells.length;
        const [w, h] = this.actor.get_size();
        let x = centerX - ((n - 1) * STEP * sf + pad + CELL_W * sf / 2);
        let y = islandTop - 10 * sf - h + pad;
        x = Math.min(Math.max(x, area.x + 4 * sf), area.x + area.width - w - 4 * sf);
        y = Math.max(y, area.y + 4 * sf);
        this.actor.set_position(Math.round(x), Math.round(y));
    }

    // From the bottom up, 30 ms apart.
    animateIn() {
        const sf = this._sf;
        this._cells.forEach((cell, i) => {
            cell.opacity = 0;
            cell.translation_y = 12 * sf;
            cell.ease({opacity: 255, translation_y: 0, delay: ms(i * STAGGER), duration: ms(IN_TIME),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
    }

    animateOut(done) {
        this.actor.ease({opacity: 0, duration: ms(OUT_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD, onStopped: done});
    }

    focus(index) {
        this._cells[Math.max(0, Math.min(index, this._cells.length - 1))]?.grab_key_focus();
    }

    // Up climbs the cascade, Down goes back to the button.
    navigate(symbol) {
        const i = this._cells.findIndex(c => c.has_key_focus());
        if (symbol === Clutter.KEY_Up)
            this.focus(i + 1);
        else if (symbol === Clutter.KEY_Down)
            this.focus(Math.max(0, i - 1));
        else
            return false;
        return true;
    }

    destroy() {
        this.actor.destroy();
        this._cells = [];
    }
}
