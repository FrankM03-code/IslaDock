// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Mayúsculas: for keyboards with no Caps Lock light. While it is on, a small
// ⇪ badge sits on the island's right corner (switch in Preferences). Turning it on
// over a maximized window brings the hidden island out for a moment to show it.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

import {IslandBadge} from './badge.js';

export class CapsLock {
    constructor({state, settings, capsule, dir}) {
        this._state = state;
        this._settings = settings;
        this._badge = new IslandBadge(capsule, new Gio.FileIcon({file: dir.get_child('icons').get_child('isla-mayus-symbolic.svg')}),
            'isla-insignia-mayus');
        this._keymap = Clutter.get_default_backend().get_default_seat().get_keymap();
        this._on = this._keymap.get_caps_lock_state();
        this._keymapId = this._keymap.connect('state-changed', () => {
            const on = this._keymap.get_caps_lock_state();
            if (on === this._on)
                return;
            this._on = on;
            this._sync(true);
            if (on && this._settings.get_boolean('mayus-insignia'))
                this._state.command('nudge');
        });
        this._settingsId = settings.connect('changed::mayus-insignia', () => this._sync(false));
        this._sync(false);
    }

    _sync(animate) {
        this._badge.show(this._on && this._settings.get_boolean('mayus-insignia'), animate);
    }

    destroy() {
        this._keymap.disconnect(this._keymapId);
        this._settings.disconnect(this._settingsId);
        this._badge.destroy();
    }
}
