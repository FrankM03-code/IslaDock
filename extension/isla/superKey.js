// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The Super key alone (GNOME's 'overlay-key') opens the app drawer, as the Aplicaciones
// button of the dock: the Lanzador Isla when it is on, GNOME's app grid when it is off.
// Pressed again it closes it. GNOME's own handler (overviewControls.js, Activities) is
// blocked while this runs and unblocked after. Key 'super-abre-cajon'.
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

export class SuperKey {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        // GNOME's handlers, blocked before ours is connected.
        this._blocked = GObject.signal_handlers_block_matched(global.display, {signalId: 'overlay-key'});
        this._id = global.display.connect('overlay-key', () => this._onSuper());
        // POPUP too: Super closes the Lanzador while it holds the keyboard.
        Main.wm.allowKeybinding('overlay-key', MODES | Shell.ActionMode.POPUP);
    }

    _onSuper() {
        if (this._settings.get_boolean('lanzador-isla') && !Main.overview.visible)
            this._state.command('launcher-toggle');
        else if (Main.overview.visible)
            Main.overview.hide();
        else
            Main.overview.showApps();
    }

    destroy() {
        Main.wm.allowKeybinding('overlay-key', MODES);
        global.display.disconnect(this._id);
        if (this._blocked)
            GObject.signal_handlers_unblock_matched(global.display, {signalId: 'overlay-key'});
    }
}
