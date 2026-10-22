// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Fondo desenfocado en el cajón: behind the app grid (and the Activities
// view) the user's own wallpaper, blurred and a little darker, instead of the
// theme's flat color. One copy per monitor, at the bottom of the overview;
// the blur is cached, so it costs nothing while it stays still.
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';

const HAS_BLUR_RADIUS = !!GObject.Object.find_property.call(Shell.BlurEffect, 'radius');
const RADIUS = 30;
const BRIGHTNESS = 0.6;

export class OverviewBlur {
    constructor() {
        this._copies = [];
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._build());
        this._build();
    }

    _build() {
        this._clear();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        for (const monitor of Main.layoutManager.monitors) {
            const holder = new St.Widget({name: 'IslaDockOverviewBlur', reactive: false,
                x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height});
            Main.layoutManager.overviewGroup.insert_child_at_index(holder, 0);
            const manager = new Background.BackgroundManager({
                container: holder,
                monitorIndex: monitor.index,
                vignette: false,
                controlPosition: false,
            });
            const blur = () => {
                const actor = manager.backgroundActor;
                if (!actor)
                    return;
                actor.remove_effect_by_name('blur');
                const effect = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, brightness: BRIGHTNESS});
                if (HAS_BLUR_RADIUS)
                    effect.radius = RADIUS * sf;
                else
                    effect.sigma = RADIUS / 2 * sf;
                actor.add_effect_with_name('blur', effect);
            };
            // A new wallpaper brings a new actor: it gets the blur too.
            const changedId = manager.connect('changed', blur);
            blur();
            this._copies.push({holder, manager, changedId});
        }
    }

    _clear() {
        for (const {holder, manager, changedId} of this._copies) {
            manager.disconnect(changedId);
            manager.destroy();
            holder.destroy();
        }
        this._copies = [];
    }

    destroy() {
        Main.layoutManager.disconnect(this._monitorsId);
        this._clear();
    }
}
