// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Lista: the latest downloads as quiet rows on a slim rounded panel above the
// button: icon, name, and when (and how big) under it. The newest wears a small
// dot; "Abrir carpeta" sits under a hairline at the bottom. No arrow, no frames.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {progressBar} from './bar.js';
import {relativeTime} from './fileActions.js';
import {ms} from '../timing.js';
import {_, fmt} from '../i18n.js';

const WIDTH = 300;
const ICON = 30;
const STAGGER = 25;
const IN_TIME = 170;
const OUT_TIME = 120;
const RISE = 8;

export class ListView {
    // files: newest first · max: rows at most · on: {open(entry), menu(entry, row), folder()}
    // labels: {title, folder, count(total), accent} to word it for something other than downloads.
    constructor({style, sf, on, labels = null}) {
        this._style = style;
        this._labels = labels;
        this._sf = sf;
        this._on = on;
        this._rows = [];
        const s = style;
        this.actor = new St.BoxLayout({reactive: true, orientation: Clutter.Orientation.VERTICAL,
            style: `width: ${WIDTH}px; padding: 10px 8px 8px 8px; border-radius: 20px; background-color: ${s.panelFill};` +
                ` border: 1px solid ${s.panelBorder}; box-shadow: 0 8px 24px ${s.shadow}; spacing: 2px;`});

        const header = new St.BoxLayout({style: 'padding: 0 10px 6px 10px;'});
        header.add_child(new St.Label({text: labels?.title ?? _('Descargas'), x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: 13px; font-weight: bold; color: ${s.text};`}));
        this._count = new St.Label({y_align: Clutter.ActorAlign.CENTER, style: `font-size: 11px; color: ${s.textSecondary};`});
        header.add_child(this._count);
        this.actor.add_child(header);

        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 2px;'});
        this.actor.add_child(this._list);

        this.actor.add_child(new St.Widget({style: `height: 1px; margin: 6px 10px; background-color: ${s.panelBorder};`}));
        this._folderButton = new St.Button({can_focus: true, reactive: true, track_hover: true, x_expand: true});
        const footer = new St.BoxLayout({style: 'spacing: 8px;'});
        footer.add_child(new St.Icon({icon_name: 'folder-open-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.CENTER,
            style: `color: ${s.accent};`}));
        this._folderLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER, x_expand: true,
            style: `font-size: 12px; font-weight: bold; color: ${s.accent};`});
        footer.add_child(this._folderLabel);
        this._folderButton.set_child(footer);
        this._lightFolder();
        for (const signal of ['notify::hover', 'key-focus-in', 'key-focus-out'])
            this._folderButton.connect(signal, () => this._lightFolder());
        this._folderButton.connect('clicked', () => this._on.folder());
        this.actor.add_child(this._folderButton);
    }

    _rowStyle(on) {
        return `height: 46px; padding: 0 10px; border-radius: 12px; background-color: ${on ? this._style.tileHover : 'transparent'};`;
    }

    _lightFolder() {
        const b = this._folderButton;
        b.style = `${this._rowStyle(b.hover || b.has_key_focus())} height: 34px;`;
    }

    _detail(entry) {
        if (entry.detail !== undefined)
            return entry.detail;
        if (entry.partial)
            return entry.transfer ?? 'descargando';
        const when = relativeTime(entry.time);
        const size = entry.isDir || !entry.size ? '' : GLib.format_size(entry.size);
        return [when, size].filter(Boolean).join(' · ');
    }

    _row(entry, newest) {
        const s = this._style;
        const row = new St.Button({reactive: true, can_focus: true, track_hover: true, x_expand: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE});
        row.entry = entry;
        const box = new St.BoxLayout({x_expand: true, style: 'spacing: 12px;'});
        box.add_child(new St.Icon({gicon: entry.gicon, icon_size: ICON, fallback_icon_name: 'text-x-generic',
            y_align: Clutter.ActorAlign.CENTER}));
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER, style: 'spacing: 2px;'});
        const name = new St.Label({text: entry.display, style: `font-size: 13px; color: ${s.text};`});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        text.add_child(name);
        const detail = this._detail(entry);
        if (detail) {
            row._detail = new St.Label({text: detail, style: `font-size: 11px; color: ${s.textSecondary};`});
            text.add_child(row._detail);
        }
        if (entry.partial)
            text.add_child(progressBar(Math.round(200 * this._sf), Math.round(3 * this._sf), s.accent, entry.progress));
        box.add_child(text);
        if (newest) {
            box.add_child(new St.Widget({y_align: Clutter.ActorAlign.CENTER,
                style: `width: 6px; height: 6px; border-radius: 3px; background-color: ${s.accent};`}));
        }
        row.set_child(box);
        row.accessible_name = entry.display;
        row.style = this._rowStyle(false);
        const lit = () => (row.style = this._rowStyle(row.hover || row.has_key_focus()));
        for (const signal of ['notify::hover', 'key-focus-in', 'key-focus-out'])
            row.connect(signal, lit);
        row.connect('clicked', (_r, button) => (button === 3 ? this._on.menu(entry, row) : this._on.open(entry)));
        return row;
    }

    // Rebuilt in its place (the stack stays open while the folder changes).
    fill(files, total, max) {
        const focused = this._rows.findIndex(r => r.has_key_focus());
        this._list.destroy_all_children();
        const accent = this._labels?.accent ?? true;
        this._rows = files.slice(0, max).map((entry, i) => this._row(entry, accent && i === 0));
        this._rows.forEach(row => this._list.add_child(row));
        this._count.text = this._labels?.count ? this._labels.count(total) : `${total}`;
        const rest = total - this._rows.length;
        const folder = this._labels?.folder ?? _('Abrir carpeta');
        this._folderLabel.text = rest > 0 ? fmt(_('{carpeta} · {n} más'), {carpeta: folder, n: rest}) : folder;
        if (focused >= 0)
            this.focus(Math.min(focused, this._rows.length - 1));
    }

    // Centered over the button, 10 px above the island, inside the work area.
    place(centerX, islandTop, area) {
        const sf = this._sf;
        const [, w] = this.actor.get_preferred_width(-1);
        const [, h] = this.actor.get_preferred_height(w);
        let x = centerX - w / 2;
        x = Math.min(Math.max(x, area.x + 4 * sf), area.x + area.width - w - 4 * sf);
        const y = Math.max(islandTop - 10 * sf - h, area.y + 4 * sf);
        this.actor.set_position(Math.round(x), Math.round(y));
    }

    // The panel rises a little; the rows follow it, top first.
    animateIn() {
        const sf = this._sf;
        this.actor.set({opacity: 0, translation_y: RISE * sf});
        this.actor.ease({opacity: 255, translation_y: 0, duration: ms(IN_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._rows.forEach((row, i) => {
            row.opacity = 0;
            row.ease({opacity: 255, delay: ms(60 + i * STAGGER), duration: ms(IN_TIME),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
    }

    // How much has arrived, how fast.
    updateTransfer() {
        for (const row of this._rows) {
            if (row.entry.partial && row._detail)
                row._detail.text = this._detail(row.entry);
        }
    }

    animateOut(done) {
        this.actor.ease({opacity: 0, translation_y: RISE * this._sf / 2, duration: ms(OUT_TIME),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD, onStopped: done});
    }

    focus(index) {
        const row = this._rows[Math.max(0, Math.min(index, this._rows.length - 1))];
        (row ?? this._folderButton).grab_key_focus();
    }

    // Up and Down walk the rows; past the last one is "Abrir carpeta".
    navigate(symbol) {
        if (symbol !== Clutter.KEY_Up && symbol !== Clutter.KEY_Down)
            return false;
        const i = this._rows.findIndex(r => r.has_key_focus());
        if (this._folderButton.has_key_focus()) {
            if (symbol === Clutter.KEY_Up)
                this.focus(this._rows.length - 1);
        } else if (i < 0) {
            this.focus(0);
        } else if (symbol === Clutter.KEY_Down && i === this._rows.length - 1) {
            this._folderButton.grab_key_focus();
        } else {
            this.focus(i + (symbol === Clutter.KEY_Down ? 1 : -1));
        }
        return true;
    }

    destroy() {
        this.actor.destroy();
        this._rows = [];
    }
}
