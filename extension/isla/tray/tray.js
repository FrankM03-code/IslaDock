// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Bandeja: the tray icons of apps (Telegram, qBittorrent, Steam, Discord…),
// lost with the top bar, live in the open dock: before Energía or at the
// start ('bandeja-lado'). Left click activates the app (or opens its menu
// when that is all it has), middle click is its second action, right click
// opens its menu, the wheel goes to the app. Tooltip: the app's title.
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Watcher} from './watcher.js';
import {TrayItem} from './item.js';
import {fillMenu, readMenu} from './menu.js';

const ORDER = 5;

export class Tray {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._items = new Map();        // key -> {item, button, ids}
        this.actor = new St.BoxLayout({style_class: 'isla-bandeja', y_align: Clutter.ActorAlign.CENTER});
        this._menuManager = new PopupMenu.PopupMenuManager(this.actor);
        this._watcher = new Watcher();
        this._watcherIds = [
            this._watcher.connect('item-added', (_w, key) => this._add(key)),
            this._watcher.connect('item-removed', (_w, key) => this._remove(key)),
        ];
        this._sideId = settings.connect('changed::bandeja-lado', () => this._sync());
        this._watcher.keys.forEach(key => this._add(key));
        this._sync();
    }

    _add(key) {
        if (this._items.has(key))
            return;
        const item = new TrayItem(key);
        const icon = new St.Icon({style_class: 'isla-bandeja-icono', fallback_icon_name: 'image-missing-symbolic'});
        const button = new St.Button({style_class: 'isla-bandeja-boton', can_focus: true, reactive: true, track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE, child: icon, visible: false,
            y_align: Clutter.ActorAlign.CENTER});
        button.connect('clicked', (_b, mouse) => this._onClick(key, mouse));
        button.connect('scroll-event', (_b, event) => this._onScroll(item, event));
        button.connect('notify::hover', () => this._tooltip(button, item));
        const ids = [item.connect('changed', () => {
            icon.gicon = item.gicon;
            button.accessible_name = item.title;
            button.visible = item.visible;
            this._sync();
        })];
        this._items.set(key, {item, button, ids});
        this.actor.add_child(button);
    }

    _remove(key) {
        const entry = this._items.get(key);
        if (!entry)
            return;
        this._items.delete(key);
        entry.ids.forEach(id => entry.item.disconnect(id));
        entry.item.destroy();
        entry.menu?.destroy();
        entry.button.destroy();
        this._hideTooltip();
        this._sync();
    }

    _center(button) {
        const [x, y] = button.get_transformed_position();
        const [w, h] = button.get_transformed_size();
        return [Math.round(x + w / 2), Math.round(y + h / 2)];
    }

    async _onClick(key, mouse) {
        const entry = this._items.get(key);
        if (!entry)
            return;
        const [x, y] = this._center(entry.button);
        if (mouse === 2) {
            entry.item.secondaryActivate(x, y);
        } else if (mouse === 3) {
            this._openMenu(entry, x, y);
        } else if (!await entry.item.activate(x, y)) {
            this._openMenu(entry, x, y);
        }
    }

    _onScroll(item, event) {
        const dir = event.get_scroll_direction();
        const steps = {
            [Clutter.ScrollDirection.UP]: [-1, true], [Clutter.ScrollDirection.DOWN]: [1, true],
            [Clutter.ScrollDirection.LEFT]: [-1, false], [Clutter.ScrollDirection.RIGHT]: [1, false],
        };
        if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            item.scroll(Math.round((Math.abs(dy) >= Math.abs(dx) ? dy : dx) * 10),
                Math.abs(dy) >= Math.abs(dx));
        } else if (steps[dir]) {
            item.scroll(steps[dir][0] * 10, steps[dir][1]);
        }
        return Clutter.EVENT_STOP;
    }

    async _openMenu(entry, x, y) {
        const {item, button} = entry;
        if (!item.menuPath) {
            item.contextMenu(x, y);
            return;
        }
        let tree;
        try {
            tree = await readMenu(item.bus, item.menuPath);
        } catch (e) {
            console.warn(`isla-dock: bandeja: menú de ${item.title}: ${e.message}`);
            item.contextMenu(x, y);
            return;
        }
        if (!this._items.has(entry.item.key))
            return;
        if (!entry.menu) {
            const menu = entry.menu = new PopupMenu.PopupMenu(button, 0.5, St.Side.BOTTOM);
            menu.actor.add_style_class_name('isla-menu');
            Main.uiGroup.add_child(menu.actor);
            menu.actor.hide();
            this._menuManager.addMenu(menu);
            menu.connect('open-state-changed', (_m, open) => {
                if (open) {
                    this._hideTooltip();
                    this._state.hold('bandeja');
                } else {
                    this._state.release('bandeja');
                }
            });
        }
        entry.menu.removeAll();
        fillMenu(entry.menu, tree, item.bus, item.menuPath);
        if (!entry.menu.isEmpty())
            entry.menu.open(BoxPointer.PopupAnimation.FULL);
    }

    // The app's title above the icon, like the dock's own tooltip.
    _tooltip(button, item) {
        if (!button.hover || !item.title || this._items.get(item.key)?.menu?.isOpen) {
            if (this._tip?._owner === button)
                this._hideTooltip();
            return;
        }
        if (!this._tip) {
            this._tip = new St.Label({style_class: 'isla-tooltip', visible: false});
            Main.layoutManager.uiGroup.add_child(this._tip);
        }
        this._tip._owner = button;
        this._tip.text = item.title;
        this._tip.show();
        const [bx, by] = button.get_transformed_position();
        const [bw] = button.get_transformed_size();
        const [, tw] = this._tip.get_preferred_width(-1);
        const [, th] = this._tip.get_preferred_height(-1);
        this._tip.set_position(Math.round(bx + bw / 2 - tw / 2), Math.round(by - th - 8));
    }

    _hideTooltip() {
        if (this._tip) {
            this._tip.hide();
            this._tip._owner = null;
        }
    }

    _sync() {
        const any = [...this._items.values()].some(e => e.button.visible);
        if (!any) {
            this._state.removeStatus('tray');
            return;
        }
        const side = this._settings.get_string('bandeja-lado') === 'izquierda' ? 'start' : 'end';
        this._state.setStatus('tray', {order: ORDER, open: this.actor, side});
    }

    destroy() {
        this._state.removeStatus('tray');
        this._state.release('bandeja');
        this._settings.disconnect(this._sideId);
        this._watcherIds.forEach(id => this._watcher.disconnect(id));
        for (const key of [...this._items.keys()])
            this._remove(key);
        this._watcher.destroy();
        this._tip?.destroy();
        this._tip = null;
        this.actor.destroy();
    }
}
