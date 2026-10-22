// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Sin barra superior: GNOME's top bar goes away completely (no space kept for
// it, windows use the whole height) while IslaDock runs; its controls live in
// the dock's Energía panel. The hot corners keep working: GNOME sizes their
// pressure barriers from the bar's height, so they get a fixed size here.
// Everything is put back when the module stops.
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CORNER = 32;        // what the top bar's height gave the hot corners

export class TopBar {
    constructor() {
        const layout = Main.layoutManager;
        this._box = layout.panelBox;
        layout.untrackChrome(this._box);
        this._box.hide();
        // The barrier on the bar's right end (it only made sense with a bar).
        layout._destroyPanelBarrier?.();
        this._ids = [
            layout.connect('hot-corners-changed', () => this._fixCorners()),
            layout.connect('monitors-changed', () => {
                layout._destroyPanelBarrier?.();
                this._fixCorners();
            }),
        ];
        this._fixCorners();
    }

    _fixCorners() {
        const size = CORNER * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        Main.layoutManager.hotCorners.forEach(corner => corner?.setBarrierSize(size));
    }

    destroy() {
        const layout = Main.layoutManager;
        this._ids.forEach(id => layout.disconnect(id));
        this._ids = [];
        this._box.show();
        layout.trackChrome(this._box, {affectsStruts: true, trackFullscreen: true});
        layout._updatePanelBarrier?.();
        layout.hotCorners.forEach(corner => corner?.setBarrierSize(this._box.height));
    }
}
