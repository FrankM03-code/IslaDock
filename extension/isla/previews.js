// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Window previews (B3). With the island open, resting the pointer 400 ms on an
// open app shows a glass card above it with a live thumbnail per window, its
// title and a close button. Click a thumbnail to go to that window. The card
// waits 300 ms after the pointer leaves, so it can be reached. With
// 'isla-vistas-previas' off the card only comes on demand ('previews-show':
// a right click on Archivos, or a click on the app in front).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Mode} from './state.js';
import {chromeParams} from './chrome.js';
import {islandLook} from './look.js';
import {dockMonitor} from './monitor.js';

const SHOW_DELAY = 400;
const HIDE_DELAY = 300;
const THUMB_W = 200, THUMB_H = 124;
const GAP = 12;
const RADIUS = 18;           // the card's corners (.isla-vista)

export class Previews {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._timers = {};
        this._layers = [];           // the skin's pieces around the card (Aurora's halo)
        this._card = new St.BoxLayout({style_class: 'isla-vista', reactive: true, track_hover: true, visible: false});
        Main.layoutManager.addChrome(this._card, chromeParams({affectsInputRegion: true}));
        this._card.connect('notify::hover', () => {
            if (this._card.hover)
                this._cancel('hide');
            else
                this._later('hide', HIDE_DELAY, () => this.hide());
        });
        this._ids = [
            state.connect('item-hover', (_s, item, hover) => this._onItemHover(item, hover)),
            state.connect('mode-changed', (_s, mode) => mode !== Mode.EXPANDED && this.hide()),
            // A click on the app in front can ask for them at once ('clic-enfocada').
            state.connect('command', (_s, name, item) => {
                if (name === 'previews-show' && item?.app && this._state.mode === Mode.EXPANDED) {
                    this._cancel('show');
                    this._cancel('hide');
                    this._show(item);
                }
            }),
        ];
    }

    _later(name, ms, fn) {
        this._cancel(name);
        this._timers[name] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers[name] = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancel(name) {
        if (this._timers[name])
            GLib.source_remove(this._timers[name]);
        this._timers[name] = 0;
    }

    _windows(app) {
        return app.get_windows().filter(w => !w.skip_taskbar);
    }

    _onItemHover(item, hover) {
        if (!hover) {
            this._cancel('show');
            if (this._card.visible && !this._card.hover)
                this._later('hide', HIDE_DELAY, () => this.hide());
            return;
        }
        this._cancel('hide');
        if (!this._settings.get_boolean('isla-vistas-previas')) {
            if (this._card.visible && item !== this._item)
                this.hide();
            return;
        }
        if (item.kind !== 'app' || !item.app || !this._windows(item.app).length || this._state.mode !== Mode.EXPANDED) {
            this.hide();
            return;
        }
        if (this._card.visible) {
            this._show(item);
            return;
        }
        this._later('show', SHOW_DELAY, () => item.hover && this._show(item));
    }

    _show(item) {
        this._item = item;
        this._card.destroy_all_children();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        for (const win of this._windows(item.app)) {
            const actor = win.get_compositor_private();
            if (!actor)
                continue;
            this._card.add_child(this._thumb(win, actor, sf));
        }
        if (!this._card.get_n_children()) {
            this.hide();
            return;
        }
        // Dressed like the island: its solid color, and light text on a dark skin.
        const look = islandLook(this._state);
        this._card.style = look.style ?? '';
        if (look.light)
            this._card.remove_style_class_name('oscura');
        else
            this._card.add_style_class_name('oscura');
        this._state.hold('preview');
        this._state.command('hide-tooltip');
        this._card.show();
        this._card.opacity = 0;
        this._place(item);
        this._card.ease({opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._dress(look);
    }

    // The skin's own pieces (Aurora's halo) under the card, following it like in the other panels.
    _dress(look) {
        this._undress();
        const parent = this._card.get_parent();
        for (const layer of look.layers?.(RADIUS) ?? []) {
            const m = layer._around ?? 0;
            layer.add_constraint(new Clutter.BindConstraint({source: this._card, coordinate: Clutter.BindCoordinate.POSITION, offset: -m}));
            layer.add_constraint(new Clutter.BindConstraint({source: this._card, coordinate: Clutter.BindCoordinate.SIZE, offset: 2 * m}));
            parent.insert_child_below(layer, this._card);
            this._layers.push(layer);
        }
    }

    _undress() {
        this._layers.forEach(layer => layer.destroy());
        this._layers = [];
    }

    _thumb(win, actor, sf) {
        const button = new St.Button({style_class: 'isla-miniatura', can_focus: false});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        const [w, h] = actor.get_size();
        const scale = Math.min(THUMB_W * sf / w, THUMB_H * sf / h, 1);
        const frame = new St.Widget({style_class: 'isla-miniatura-marco', layout_manager: new Clutter.BinLayout()});
        frame.set_size(Math.round(THUMB_W * sf), Math.round(THUMB_H * sf));
        const clone = new Clutter.Clone({source: actor, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        clone.set_size(Math.round(w * scale), Math.round(h * scale));
        frame.add_child(clone);
        const header = new St.BoxLayout({style_class: 'isla-miniatura-cabecera'});
        const title = new St.Label({style_class: 'isla-miniatura-titulo', text: win.get_title() || this._item.app.get_name(),
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const close = new St.Button({style_class: 'isla-miniatura-cerrar', can_focus: false,
            child: new St.Icon({icon_name: 'window-close-symbolic', style_class: 'isla-boton-icono'})});
        close.connect('clicked', () => {
            win.delete(global.get_current_time());
            button.destroy();
            if (!this._card.get_n_children())
                this.hide();
            else
                this._place(this._item);
        });
        header.add_child(title);
        header.add_child(close);
        box.add_child(header);
        box.add_child(frame);
        button.set_child(box);
        button.connect('clicked', () => {
            Main.activateWindow(win);
            this.hide();
            this._state.command('fold');
        });
        return button;
    }

    // Centered above the icon, inside the monitor.
    _place(item) {
        const [, natW] = this._card.get_preferred_width(-1);
        const [, natH] = this._card.get_preferred_height(natW);
        const [ix, iy] = item.get_transformed_position();
        const [iw] = item.get_transformed_size();
        const mon = dockMonitor();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const x = Math.min(Math.max(ix + iw / 2 - natW / 2, mon.x + 8), mon.x + mon.width - natW - 8);
        this._card.set_position(Math.round(x), Math.round(iy - natH - GAP * sf));
    }

    hide() {
        this._cancel('show');
        this._cancel('hide');
        if (!this._card.visible)
            return;
        this._card.remove_all_transitions();
        this._card.hide();
        this._undress();
        this._card.destroy_all_children();
        this._item = null;
        this._state.release('preview');
    }

    destroy() {
        this.hide();
        Object.keys(this._timers).forEach(name => this._cancel(name));
        this._ids.forEach(id => this._state.disconnect(id));
        Main.layoutManager.removeChrome(this._card);
        this._card.destroy();
    }
}
