// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Vidrio oscuro: thick smoky glass like Apple's "Liquid Glass". With nothing
// behind the island it is a lens (blurred wallpaper bent near the edges, with a
// light rim lit from the top left); with a window behind it turns into flat
// tinted glass. The icons are the user's own, without circles around them
// (asked 2026-10-21); the music goes to a glass card of its own, next to the island.
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SkinBase} from './base.js';
import {Lens} from './lens.js';

const MARGIN = 40;            // wallpaper around the lens for the bent edge
const RADIUS = 26;
const FADE = 200;

export class VidrioOscuroSkin extends SkinBase {
    get blur() {
        return null;
    }

    get forcesColorIcons() {
        return true;
    }

    get darkTooltip() {
        return true;
    }

    get portalGraphite() {
        return false;
    }

    get extraClasses() {
        return this._flat ? ['vo-plano'] : [];
    }

    get openPadding() {
        return [9, 11, 7];
    }

    get itemSpacing() {
        return 8;
    }

    // The activity panels (music...) go to a glass card next to the island.
    get panelCard() {
        return this.isla._settings.get_boolean('glass-music-card');
    }

    get waveColor() {
        return '#FFFFFF';
    }

    getStackStyle() {
        return {
            cellFill: 'rgba(18, 18, 22, 0.55)', cellBorder: 'rgba(255, 255, 255, 0.22)', cellHover: 'rgba(40, 40, 48, 0.75)',
            accent: '#FFFFFF', text: '#FFFFFF', textSecondary: 'rgba(255, 255, 255, 0.65)',
            panelFill: 'rgba(18, 18, 22, 0.78)', panelBorder: 'rgba(255, 255, 255, 0.22)', shadow: 'rgba(0, 0, 0, 0.45)',
            tileHover: 'rgba(255, 255, 255, 0.12)',
        };
    }

    // The Energía panel: its own lens and shadow while the island is a lens; flat glass otherwise.
    floatingLook() {
        if (this._flat)
            return {style: 'background-color: rgba(18, 18, 22, 0.82); border: 1px solid rgba(255, 255, 255, 0.26);'};
        return {
            style: 'background-color: transparent; border-width: 0; box-shadow: none;',
            layers: radius => {
                const shadow = new St.Widget({style_class: 'isla-vo-sombra', style: `border-radius: ${radius}px;`});
                shadow._around = 0;
                try {
                    const lens = new Lens({monitorIndex: Main.layoutManager.primaryIndex, margin: MARGIN, scale: this._sf});
                    const s = this.isla._settings;
                    lens.configure({tint: s.get_double('glass-tint'), strength: s.get_double('glass-strength')});
                    lens.setRadius(radius * this._sf);
                    return [shadow, lens];
                } catch (e) {
                    console.warn(`isla-dock: panel sin lente (${e.message})`);
                    shadow.style += ' background-color: rgba(18, 18, 22, 0.82);';
                    return [shadow];
                }
            },
        };
    }

    enable() {
        const isla = this.isla;
        const settings = isla._settings;
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._sf = sf;
        this._flat = false;
        this._off = false;
        this._behind = false;
        this._lenses = [];
        this._later = 0;

        // Shadow and lens of the island; the same for the music card.
        // The card's lens (a second wallpaper copy) only exists while the card shows.
        for (const target of ['capsule', 'card']) {
            const shadow = new St.Widget({style_class: 'isla-vo-sombra'});
            shadow._around = 0;
            shadow._target = target;
            this.addLayer(shadow, 'around');
            if (target === 'card')
                this._cardShadow = shadow;
        }
        this._lens = this._makeLens('capsule');
        for (const key of ['glass-tint', 'glass-strength'])
            this.connect(settings, `changed::${key}`, () => this._applyLook());
        this.connect(settings, 'changed::glass-refraction', () => this._updateMode(true));
        this.connect(settings, 'changed::glass-music-card', () => {
            isla._applySettings();
            isla._resize();
        });

        // The card's glass follows the card.
        const card = isla.card;
        const followCard = () => {
            this._cardShadow.visible = card.visible;
            if (card.visible && !this._cardLens) {
                this._cardLens = this._makeLens('card');
                this._cardLens?.setRadius(Math.min(RADIUS * sf, card.height / 2 || RADIUS * sf));
            } else if (!card.visible && this._cardLens) {
                this._dropLens(this._cardLens);
                this._cardLens = null;
            }
            this._fade(false);
            this._queueButtons();
        };
        this.connect(card, 'notify::visible', followCard);
        this.connect(card, 'notify::opacity', () => this._fade(false));
        this.connect(card, 'notify::allocation', () => {
            this._cardLens?.setRadius(Math.min(RADIUS * sf, card.height / 2));
            this._queueButtons();
        });
        followCard();

        // The reflection follows the pointer; buttons are re-read when they move.
        for (const [actor, lens] of [[isla.capsule, () => this._lens], [card, () => this._cardLens]]) {
            this.connect(actor, 'motion-event', (_a, event) => {
                lens()?.setMouse(event.get_coords());
                return Clutter.EVENT_PROPAGATE;
            });
            this.connect(actor, 'leave-event', () => {
                lens()?.setMouse(null);
                return Clutter.EVENT_PROPAGATE;
            });
        }
        this._queueButtons();
        this._updateMode(false);
    }

    _makeLens(target) {
        try {
            const lens = new Lens({monitorIndex: Main.layoutManager.primaryIndex, margin: MARGIN, scale: this._sf});
            lens._target = target;
            this.addLayer(lens, 'around');
            this._lenses.push(lens);
            this._applyLook();
            return lens;
        } catch (e) {
            console.warn(`isla-dock: vidrio oscuro sin lente (${e.message})`);
            return null;
        }
    }

    _dropLens(lens) {
        this._lenses = this._lenses.filter(l => l !== lens);
        this._layers = this._layers.filter(l => l !== lens);
        lens.destroy();
    }

    _applyLook() {
        const s = this.isla._settings;
        const look = {tint: s.get_double('glass-tint'), strength: s.get_double('glass-strength')};
        this._lenses.forEach(l => l.configure(look));
    }

    // ---------- lens or flat glass ----------
    onWindowBehind(behind) {
        this._behind = behind;
        this._updateMode(true);
    }

    _updateMode(animate) {
        const flat = this._behind || !this.isla._settings.get_boolean('glass-refraction') || !this._lens;
        const changed = flat !== this._flat;
        this._flat = flat;
        const card = this.isla.card;
        for (const actor of [this.isla.capsule, card]) {
            if (flat)
                actor.add_style_class_name('vo-plano');
            else
                actor.remove_style_class_name('vo-plano');
        }
        if (changed || !animate)
            this._fade(animate);
    }

    // The lenses fade in and out (200 ms) while the flat glass does the opposite in CSS.
    _fade(animate) {
        const card = this.isla.card;
        const targets = [[this._lens, 255], [this._cardLens, card.opacity]];
        for (const [lens, top] of targets) {
            if (!lens)
                continue;
            const value = this._flat ? 0 : top;
            lens.remove_transition('opacity');
            if (animate && St.Settings.get().enable_animations)
                lens.ease({opacity: value, duration: FADE, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                lens.opacity = value;
        }
        if (this._cardShadow)
            this._cardShadow.opacity = card.opacity;
    }

    // ---------- the play button is a small lens of the card ----------
    _queueButtons() {
        if (this._later || this._off)
            return;
        const laters = global.compositor.get_laters();
        this._later = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._later = 0;
            this._sendButtons();
            return false;
        });
    }

    _sendButtons() {
        const circle = (actor, focus) => {
            const r = actor.get_transformed_extents();
            return [r.get_x() + r.get_width() / 2, r.get_y() + r.get_height() / 2, r.get_width() / 2, focus];
        };
        this._lens?.setButtons([]);
        const play = this.isla.card.visible ? findByClass(this.isla.card, 'isla-boton-play') : null;
        this._cardLens?.setButtons(play?.mapped ? [circle(play, 0)] : []);
    }

    onResize(box) {
        const h = box.get_height();
        this._lens?.setRadius(Math.min(RADIUS * this._sf, h / 2));
        this._queueButtons();
    }

    onStateChanged(_mode) {
        this._queueButtons();
    }

    disable() {
        this._off = true;
        if (this._later)
            global.compositor.get_laters().remove(this._later);
        this._later = 0;
        for (const actor of [this.isla.capsule, this.isla.card])
            actor.remove_style_class_name('vo-plano');
        super.disable();
        this._lenses = [];
        this._lens = this._cardLens = this._cardShadow = null;
    }
}

function findByClass(actor, name) {
    if (actor.has_style_class_name?.(name))
        return actor;
    for (const child of actor.get_children()) {
        const found = findByClass(child, name);
        if (found)
            return found;
    }
    return null;
}
