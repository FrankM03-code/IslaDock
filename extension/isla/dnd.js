// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Do not disturb (A3): a long press on the island switches it. While it is on,
// GNOME shows no banners and the folded island is a small grey dot. The
// previous banner setting is saved and restored, never forced to true.
import Gio from 'gi://Gio';

export class DoNotDisturb {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._ids = [
            [state, state.connect('command', (_s, name) => name === 'toggle-dnd' && this.toggle())],
            // Banners switched on elsewhere (GNOME's own switch): leave do-not-disturb.
            [this._notifications, this._notifications.connect('changed::show-banners', () => {
                if (this._state.dnd && !this._applying && this._notifications.get_boolean('show-banners'))
                    this._turnOff(false);
            })],
            // The switch in Preferences.
            [settings, settings.connect('changed::no-molestar', () => {
                if (this._writing)
                    return;
                const want = settings.get_boolean('no-molestar');
                if (want && !this._state.dnd)
                    this._turnOn();
                else if (!want && this._state.dnd)
                    this._turnOff(true);
            })],
        ];
        // It was on when the Shell restarted or the extension was switched off.
        if (settings.get_boolean('no-molestar'))
            this._apply(true);
    }

    toggle() {
        if (this._state.dnd)
            this._turnOff(true);
        else
            this._turnOn();
    }

    _setKey(on) {
        this._writing = true;
        this._settings.set_boolean('no-molestar', on);
        this._writing = false;
    }

    _turnOn() {
        this._settings.set_boolean('banners-previos', this._notifications.get_boolean('show-banners'));
        this._setKey(true);
        this._apply(true);
    }

    _turnOff(restore) {
        this._setKey(false);
        if (restore)
            this._restoreBanners();
        this._state.setDnd(false);
    }

    _apply(on) {
        this._applying = true;
        this._notifications.set_boolean('show-banners', !on);
        this._applying = false;
        this._state.setDnd(on);
    }

    _restoreBanners() {
        this._applying = true;
        this._notifications.set_boolean('show-banners', this._settings.get_boolean('banners-previos'));
        this._applying = false;
    }

    // Leaves GNOME as it was; `no-molestar` stays so it comes back with the extension.
    destroy() {
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
        if (this._state.dnd) {
            this._restoreBanners();
            this._state.setDnd(false);
        }
        this._notifications = null;
    }
}
