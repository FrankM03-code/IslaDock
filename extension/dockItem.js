// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// One dock icon: the tile (the icon), the running
// indicator under it, magnification, the "calm until hovered" effect and the
// launch bounce.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import {Portal} from './isla/portal.js';
import {ms} from './isla/timing.js';

export const INDICATOR_GAP = 1;
export const INDICATOR_HEIGHT = 3;
const INDICATOR_WIDTH = 4;

const HOVER_TIME = 120;
const ZOOM_TIME = 130;
const BOUNCE_HEIGHT = 18;
const BOUNCE_TIME = 500;      // one jump (up + down)
const REST_DESATURATION = 0.6;
const REST_OPACITY = 245;

// Holds the tile at its full (magnified) size and keeps it centered and
// standing on the bottom edge while its own width is animated.
const IconHolder = GObject.registerClass(
class IslaIconHolder extends St.Widget {
    _init(tile) {
        super._init({y_expand: false});
        this._tile = tile;
        this.add_child(tile);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [w, h] = [box.get_width(), box.get_height()];
        const [, tileW] = this._tile.get_preferred_width(-1);
        const [, tileH] = this._tile.get_preferred_height(-1);
        const child = new Clutter.ActorBox();
        child.set_origin(Math.round((w - tileW) / 2), h - tileH);
        child.set_size(tileW, tileH);
        this._tile.allocate(child);
    }
});

export const DockItem = GObject.registerClass({
    Signals: {
        'activate': {param_types: [GObject.TYPE_INT]},
        'hover-changed': {param_types: [GObject.TYPE_BOOLEAN]},
        'drag-started': {},
        'drag-ended': {},
    },
}, class IslaItem extends St.Button {
    // kind: 'app' | 'downloads' | 'trash'
    _init({kind, key, app = null, label = ''}) {
        super._init({
            style_class: 'isla-item',
            reactive: true,
            track_hover: true,
            can_focus: false,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            y_align: Clutter.ActorAlign.END,
        });
        this.kind = kind;
        this.key = key;
        this.app = app;
        this.title = label;
        this.running = false;
        this.progress = false;
        this.zoom = 0;

        this._icon = new St.Icon({style_class: 'isla-icon'});
        this._tile = new St.Widget({
            style_class: 'isla-tile',
            layout_manager: new Clutter.BinLayout(),
        });
        this._tile.set_pivot_point(0.5, 1);
        this._tile.add_child(this._icon);
        this._holder = new IconHolder(this._tile);
        // The applications button is drawn as a Portal instead of an icon.
        if (kind === 'apps') {
            this.portal = new Portal();
            this._tile.add_child(this.portal);
            this._icon.hide();
            this.can_focus = true;
            this.accessible_name = 'Aplicaciones';
            this.connect('key-focus-in', () => this.portal.setFocused(true));
            this.connect('key-focus-out', () => this.portal.setFocused(false));
        }
        this._indicator = new St.Widget({
            style_class: 'isla-indicator',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        const column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        column.add_child(this._holder);
        column.add_child(this._indicator);
        this.set_child(column);

        this._desaturate = null;
        this.connect('notify::hover', () => {
            this.portal?.setHover(this.hover);
            this._updateCalm(true);
            this.emit('hover-changed', this.hover);
        });
        this.connect('clicked', (_b, button) => {
            if (this.portal && button === 1)
                this.portal.burst();
            this.emit('activate', button);
        });

        // Apps can be dragged to reorder them (the dock is the drop target).
        if (kind === 'app') {
            this._delegate = this;
            this._draggable = DND.makeDraggable(this, {timeoutThreshold: 200});
            this._draggable.connect('drag-begin', () => {
                this.fake_release();
                this._tile.opacity = 70;
                this.emit('drag-started');
            });
            const ended = () => {
                this._updateCalm(false);
                this.emit('drag-ended');
            };
            this._draggable.connect('drag-end', ended);
            this._draggable.connect('drag-cancelled', ended);
        }
        this.connect('destroy', () => this._tile.remove_all_transitions());
    }

    get tile() {
        return this._tile;
    }


    // A number on the corner of the icon (it grows with the icon).
    setBadge(count) {
        if (!count) {
            this._badge?.destroy();
            this._badge = null;
            return;
        }
        if (!this._badge) {
            this._badge = new St.Label({style_class: 'isla-insignia', x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START, x_expand: true, y_expand: true});
            this._tile.add_child(this._badge);
        }
        this._badge.text = count > 99 ? '99+' : String(count);
    }

    // An 8 px blue dot on the corner: something new to see (Downloads).
    setDot(on) {
        if (!on) {
            this._dot?.destroy();
            this._dot = null;
            return;
        }
        if (this._dot)
            return;
        this._dot = new St.Widget({style_class: 'isla-punto-nuevo', x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START, x_expand: true, y_expand: true});
        this._tile.add_child(this._dot);
    }

    // A 2 px arc around the icon for a real percentage (0..1), or null.
    setRing(value) {
        if (value === null || value === undefined) {
            this._ring?.destroy();
            this._ring = null;
            return;
        }
        if (!this._ring) {
            this._ring = new St.DrawingArea({x_expand: true, y_expand: true});
            this._ring.connect('repaint', () => {
                const cr = this._ring.get_context();
                const [w, h] = this._ring.get_surface_size();
                const line = Math.max(2, w / 24);
                cr.setLineWidth(line);
                cr.setSourceRGBA(47 / 255, 125 / 255, 225 / 255, 0.22);
                cr.arc(w / 2, h / 2, Math.min(w, h) / 2 - line, 0, 2 * Math.PI);
                cr.stroke();
                cr.setSourceRGBA(47 / 255, 125 / 255, 225 / 255, 1);
                cr.arc(w / 2, h / 2, Math.min(w, h) / 2 - line, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * this._ringValue);
                cr.stroke();
                cr.$dispose();
            });
            this._tile.add_child(this._ring);
        }
        this._ringValue = value;
        this._ring.queue_repaint();
    }

    getDragActor() {
        return new St.Icon({gicon: this._icon.gicon, icon_size: this._p?.base ?? 48});
    }

    getDragActorSource() {
        return this._tile;
    }

    setGIcon(gicon) {
        this._icon.gicon = gicon;
    }

    // p: {base, max, scale, calm}
    configure(p) {
        this._p = p;
        const sf = p.scale;
        const tilePx = p.max * sf;
        this._tile.set_size(tilePx, tilePx);
        this._icon.icon_size = p.max;
        this.portal?.setSize(tilePx);
        this._holder.set_height(p.base * sf);

        this._indicator.set_size(INDICATOR_WIDTH * sf, INDICATOR_HEIGHT * sf);
        this._indicator.margin_top = INDICATOR_GAP * sf;
        this._updateIndicator();

        if (p.calm && !this._desaturate) {
            this._desaturate = new Clutter.DesaturateEffect({factor: REST_DESATURATION});
            this._tile.add_effect_with_name('calm', this._desaturate);
        } else if (!p.calm && this._desaturate) {
            this._tile.remove_effect(this._desaturate);
            this._desaturate = null;
        }
        this._updateCalm(false);
        this.setSize(p.base, false);
    }

    // Animates the icon to `size` logical px (the dock reflows around it).
    setSize(size, animate = true) {
        if (!this._p || size === this.zoom && animate)
            return;
        this.zoom = size;
        const sf = this._p.scale;
        const scale = size / this._p.max;
        const duration = animate ? ms(ZOOM_TIME) : 0;
        this._holder.ease({width: size * sf, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._tile.ease({scale_x: scale, scale_y: scale, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _updateCalm(animate) {
        const awake = this.hover || this._menuOpen;
        const duration = animate ? ms(HOVER_TIME) : 0;
        if (this._desaturate) {
            this._tile.ease_property('@effects.calm.factor', awake ? 0 : REST_DESATURATION,
                {duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        const calm = this._p?.calm;
        this._tile.ease({opacity: awake || !calm ? 255 : REST_OPACITY, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    set menuOpen(open) {
        this._menuOpen = open;
        this._updateCalm(true);
    }

    setRunning(running) {
        if (this.running === running)
            return;
        this.running = running;
        this._updateIndicator();
    }

    setProgress(progress) {
        if (this.progress === progress)
            return;
        this.progress = progress;
        this._updateIndicator();
    }

    _updateIndicator() {
        if (!this._p)
            return;
        const sf = this._p.scale;
        if (this.progress) {
            this._indicator.style_class = 'isla-indicator progreso';
            this._indicator.set_size(26 * sf, 2 * sf);
            this._indicator.show();
            return;
        }
        this._indicator.style_class = 'isla-indicator';
        this._indicator.set_size(INDICATOR_WIDTH * sf, INDICATOR_HEIGHT * sf);
        // Keeps its place when hidden so the icons don't move.
        this._indicator.opacity = this.running ? 255 : 0;
        this._indicator.show();
    }

    // Two jumps of 18 px, like an app being launched.
    bounce() {
        const sf = this._p?.scale ?? 1;
        const half = ms(BOUNCE_TIME / 2);
        const jump = left => {
            if (left === 0)
                return;
            this._tile.ease({
                translation_y: -BOUNCE_HEIGHT * sf,
                duration: half,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._tile.ease({
                    translation_y: 0,
                    duration: half,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => jump(left - 1),
                }),
            });
        };
        jump(2);
    }
});

export const DockSeparator = GObject.registerClass(
class IslaSeparator extends St.Widget {
    _init() {
        super._init({style_class: 'isla-separator', y_align: Clutter.ActorAlign.END});
        this.kind = 'separator';
    }

    configure(p) {
        const sf = p.scale;
        const h = Math.round(p.base * 0.88);
        this.set_size(Math.max(1, Math.round(sf)), h * sf);
        // Centered on the icons, above the indicator row.
        this.margin_bottom = Math.round(((p.base - h) / 2 + INDICATOR_GAP + INDICATOR_HEIGHT) * sf);
    }
});
