// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// When the island must be calmer, in one place:
//  · "Reducir animaciones" (GNOME's Accesibilidad switches animations off):
//    no Aurora halo moving, no breathing, no magnified icons. GNOME already
//    makes every slide instant then.
//  · Ahorro de energía ('ahorro-energia', on by default): running on battery
//    or in the "Ahorro" power mode, no blur, no Aurora halo moving and no
//    breathing.
// Readers ask its getters and listen to 'changed'.
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const UPOWER = ['org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower'];
const PROFILES = ['net.hadess.PowerProfiles', '/net/hadess/PowerProfiles', 'net.hadess.PowerProfiles'];

export class Calm extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._cancel = new Gio.Cancellable();
        this._onBattery = false;
        this._powerSaver = false;
        this._animId = St.Settings.get().connect('notify::enable-animations', () => this.emit('changed'));
        this._settingId = settings.connect('changed::ahorro-energia', () => this.emit('changed'));
        this._proxies = [];
        this._watch(UPOWER, p => (this._onBattery = !!p.get_cached_property('OnBattery')?.unpack()));
        this._watch(PROFILES, p => (this._powerSaver = p.get_cached_property('ActiveProfile')?.unpack() === 'power-saver'));
    }

    _watch([name, path, iface], read) {
        Gio.DBusProxy.new(Gio.DBus.system, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null, name, path, iface, this._cancel,
            (_o, res) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_finish(res);
                } catch {
                    return;
                }
                const update = () => {
                    const before = this.saving;
                    read(proxy);
                    if (this.saving !== before)
                        this.emit('changed');
                };
                this._proxies.push([proxy, proxy.connect('g-properties-changed', update)]);
                update();
            });
    }

    get reduced() {
        return !St.Settings.get().enable_animations;
    }

    get saving() {
        return !!this._settings?.get_boolean('ahorro-energia') && (this._onBattery || this._powerSaver);
    }

    // Aurora's moving halo and the breathing.
    get motionOff() {
        return this.reduced || this.saving;
    }

    get magnifyOff() {
        return this.reduced;
    }

    get blurOff() {
        return this.saving;
    }

    destroy() {
        this._cancel.cancel();
        St.Settings.get().disconnect(this._animId);
        this._settings.disconnect(this._settingId);
        this._proxies.forEach(([p, id]) => p.disconnect(id));
        this._proxies = [];
        this._settings = null;
        this.disconnectAll();
    }
}
