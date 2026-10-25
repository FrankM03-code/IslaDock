// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What the island asks of a skin. A skin only changes how the island looks:
// states, animations, priorities and functions stay in isla.js and the modules.
import Clutter from 'gi://Clutter';

export class SkinBase {
    constructor(isla, key) {
        this.isla = isla;
        this.key = key;
        this._layers = [];
        this._signals = [];
    }

    // CSS class on the capsule (and the tooltip): .isla-skin-<key>
    get styleClass() {
        return `isla-skin-${this.key}`;
    }

    // Wallpaper blur behind the capsule: {radius, brightness} or null.
    get blur() {
        return {radius: 30, brightness: 1};
    }

    // true: icons always in full color (ignores desaturar-en-reposo).
    get forcesColorIcons() {
        return false;
    }

    // More classes for the capsule (variants such as a dark one).
    get extraClasses() {
        return [];
    }

    // The round buttons (launcher, Notificaciones, Portapapeles, Ajustes) turn graphite over a light island.
    get buttonsGraphite() {
        return !this.isla._settings.get_boolean('isla-oscura');
    }

    get darkTooltip() {
        return this.isla._settings.get_boolean('isla-oscura');
    }

    // Open island padding [top, horizontal, bottom (optional)] and space between icons, at 32 px icons.
    get openPadding() {
        return [7, 10];
    }

    get itemSpacing() {
        return 6;
    }

    // true: the activity panels (music...) go to a card next to the island.
    get panelCard() {
        return false;
    }

    // Color of the music bars: null = the cover's color.
    get waveColor() {
        return null;
    }

    // Colors of the Downloads stack (the views never hard-code them).
    // The Clásica ones; a dark variant with "isla oscura".
    getStackStyle() {
        if (this.isla._settings.get_boolean('isla-oscura')) {
            return {
                cellFill: 'rgba(28, 30, 44, 0.86)', cellBorder: 'rgba(255, 255, 255, 0.14)', cellHover: 'rgba(40, 43, 62, 0.96)',
                accent: '#5B9BF0', text: '#F4F5FA', textSecondary: 'rgba(244, 245, 250, 0.62)',
                panelFill: 'rgba(18, 20, 34, 0.86)', panelBorder: 'rgba(255, 255, 255, 0.12)', shadow: 'rgba(0, 0, 0, 0.35)',
                tileHover: 'rgba(91, 155, 240, 0.18)',
            };
        }
        return {
            cellFill: 'rgba(255, 255, 255, 0.78)', cellBorder: 'rgba(255, 255, 255, 0.95)', cellHover: 'rgba(255, 255, 255, 0.95)',
            accent: '#2F7DE1', text: '#1E1E1E', textSecondary: 'rgba(30, 30, 30, 0.60)',
            panelFill: 'rgba(255, 255, 255, 0.86)', panelBorder: 'rgba(255, 255, 255, 0.95)', shadow: 'rgba(0, 0, 0, 0.18)',
            tileHover: 'rgba(47, 125, 225, 0.12)',
        };
    }

    // How the pieces floating apart (the Energía panel) wear the skin, beyond the
    // island's background: {style (CSS that replaces it), layers(radius) -> actors
    // to put under the panel, each with actor._around in px}, or null.
    floatingLook() {
        return null;
    }

    // Hooks.
    enable() {}
    onResize(_box) {}
    onStateChanged(_mode) {}
    onActivityChanged(_main) {}
    onWindowBehind(_behind) {}

    connect(obj, signal, fn) {
        this._signals.push([obj, obj.connect(signal, fn)]);
    }

    // where: 'behind' (under the blur), 'over' (over the background, under the
    // content), 'front' (over the content) or 'around' (outside, in the strip;
    // set actor._around to the margin in px). Layers fill the capsule unless
    // they have actor._allocateIn(box).
    addLayer(actor, where = 'over') {
        this.isla.addSkinLayer(actor, where);
        this._layers.push(actor);
        return actor;
    }

    disable() {
        this._signals.forEach(([obj, id]) => obj.disconnect(id));
        this._signals = [];
        this._layers.forEach(a => a.destroy());
        this._layers = [];
    }
}

export function fill(box) {
    const b = new Clutter.ActorBox();
    b.set_origin(box.x1, box.y1);
    b.set_size(box.get_width(), box.get_height());
    return b;
}
