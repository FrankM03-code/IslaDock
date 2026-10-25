// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Do not disturb (A3): a long press on the island switches it. While it is on,
// GNOME shows no banners and the folded island is a small grey dot. The
// previous banner setting is saved and restored, never forced to true.
// From the notification center it can also last a while ('dnd-set': 'hora',
// 'manana' until 7:00 tomorrow, 'siempre', 'off'): 'no-molestar-hasta' keeps
// the end (unix seconds, 0 = until switched off), so it also ends after a restart.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MORNING = 7;

export class DoNotDisturb {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._ids = [
            [state, state.connect('command', (_s, name, value) => {
                if (name === 'toggle-dnd')
                    this.toggle();
                else if (name === 'dnd-set')
                    this.set(value);
            })],
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
                    this.set('siempre');
                else if (!want && this._state.dnd)
                    this._turnOff(true);
            })],
        ];
        // It was on when the Shell restarted or the extension was switched off.
        if (settings.get_boolean('no-molestar')) {
            if (this._expired())
                this._turnOff(true);
            else
                this._apply(true);
        }
        this._schedule();
    }

    // 'hora', 'manana', 'siempre' or 'off'.
    set(value) {
        if (value === 'off') {
            if (this._state.dnd)
                this._turnOff(true);
            return;
        }
        const now = GLib.DateTime.new_now_local();
        let until = 0;
        if (value === 'hora') {
            until = now.to_unix() + 3600;
        } else if (value === 'manana') {
            const t = now.add_days(1);
            until = GLib.DateTime.new_local(t.get_year(), t.get_month(), t.get_day_of_month(), MORNING, 0, 0).to_unix();
        }
        this._settings.set_string('no-molestar-modo', value);
        this._settings.set_int64('no-molestar-hasta', until);
        if (this._state.dnd)
            this._state.emit('dnd-changed', true);   // a new duration: the panel says so
        else
            this._turnOn();
        this._schedule();
    }

    _expired() {
        const until = this._settings.get_int64('no-molestar-hasta');
        return until > 0 && until <= GLib.DateTime.new_now_local().to_unix();
    }

    // Ends by itself at 'no-molestar-hasta' (checked each minute: a suspend may skip a timeout).
    _schedule() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        if (!this._state.dnd || !this._settings.get_int64('no-molestar-hasta'))
            return;
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            if (!this._expired())
                return GLib.SOURCE_CONTINUE;
            this._timer = 0;
            this._turnOff(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    // The long press: on until switched off.
    toggle() {
        if (this._state.dnd)
            this._turnOff(true);
        else
            this.set('siempre');
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
        this._settings.set_int64('no-molestar-hasta', 0);
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
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
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
        if (this._state.dnd) {
            this._restoreBanners();
            this._state.setDnd(false);
        }
        this._notifications = null;
    }
}
