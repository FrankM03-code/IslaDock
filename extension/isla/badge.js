// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// A small round badge on the island's top right corner, half outside it,
// that pops in and out (Mayúsculas).
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {ms} from './timing.js';

export class IslandBadge {
    // styleClass adds its color.
    constructor(capsule, gicon, styleClass) {
        this._badge = new St.Bin({style_class: `isla-insignia ${styleClass}`, reactive: false, visible: false,
            child: new St.Icon({gicon, style_class: 'isla-insignia-icono'})});
        // The capsule's layout calls _allocateIn with its own box.
        this._badge._allocateIn = box => {
            const [, w] = this._badge.get_preferred_width(-1);
            const [, h] = this._badge.get_preferred_height(w);
            const b = new Clutter.ActorBox();
            b.set_origin(Math.round(box.x2 - w * 0.7), Math.round(box.y1 - h * 0.4));
            b.set_size(w, h);
            this._badge.allocate(b);
        };
        capsule.add_child(this._badge);
        this._badge.set_pivot_point(0.5, 0.5);
    }

    get visible() {
        return this._badge.visible;
    }

    show(want, animate) {
        const badge = this._badge;
        badge.remove_all_transitions();
        if (want === badge.visible && badge.scale_x === 1)
            return;
        if (!animate || !St.Settings.get().enable_animations) {
            badge.set({visible: want, scale_x: 1, scale_y: 1, opacity: 255});
            return;
        }
        if (want) {
            badge.set({visible: true, scale_x: 0.4, scale_y: 0.4, opacity: 0});
            badge.ease({scale_x: 1, scale_y: 1, opacity: 255, duration: ms(180),
                mode: Clutter.AnimationMode.EASE_OUT_BACK});
        } else {
            badge.ease({scale_x: 0.4, scale_y: 0.4, opacity: 0, duration: ms(140),
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: done => done && badge.set({visible: false, scale_x: 1, scale_y: 1, opacity: 255})});
        }
    }

    destroy() {
        this._badge.destroy();
    }
}
