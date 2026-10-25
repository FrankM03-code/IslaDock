// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Brillo for the Ajustes panel. GNOME's own screen brightness when it has one (a laptop's
// backlight: GNOME 48 keeps it in gsd-power, over D-Bus; 49 and later in Main.brightnessManager).
// Otherwise the monitor itself, over its cable (DDC/CI), through the ddcutil program: only when
// it is installed and the monitor answers. A monitor takes a moment to answer, so while one
// change is on its way only the newest of the next ones is sent after it.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

const BUS_NAME = 'org.gnome.SettingsDaemon.Power';
const OBJECT_PATH = '/org/gnome/SettingsDaemon/Power';
const VCP_BRIGHTNESS = '10';

export class Brightness {
    // onChange(): the brightness came, went or changed (its value is this.value, 0 to 1).
    constructor(onChange) {
        this._onChange = onChange;
        this._cancel = new Gio.Cancellable();
        this._ddc = null;            // {max} while the monitor answers
        this._busy = false;
        this._pending = null;
        if (Main.brightnessManager) {
            this._manager = Main.brightnessManager;
            this._managerId = this._manager.connect('changed', () => this._followScale());
            this._followScale();
        } else {
            const Proxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.gnome.SettingsDaemon.Power.Screen'));
            this._proxy = new Proxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, (proxy, error) => {
                if (this._cancel.is_cancelled())
                    return;
                if (!error)
                    this._proxyId = this._proxy.connect('g-properties-changed', () => this._changed());
                this._changed();
            }, this._cancel);
        }
    }

    // GNOME 49 and later: the scale for all screens (null without a backlight).
    _followScale() {
        if (this._scale && this._scaleId)
            this._scale.disconnect(this._scaleId);
        this._scale = this._manager.globalScale ?? null;
        this._scaleId = this._scale?.connect('notify::value', () => this._onChange()) ?? 0;
        this._changed();
    }

    get _gnome() {
        if (this._manager)
            return !!this._scale;
        const value = this._proxy?.Brightness;
        return Number.isInteger(value) && value >= 0;
    }

    _changed() {
        if (!this._gnome && !this._ddc && !this._probed) {
            this._probed = true;
            this._probe();
        }
        this._onChange();
    }

    get available() {
        return this._gnome || !!this._ddc;
    }

    get value() {
        if (this._manager && this._scale)
            return this._scale.value;
        if (this._gnome)
            return this._proxy.Brightness / 100;
        return this._ddc ? this._ddc.value / this._ddc.max : 0;
    }

    set value(value) {
        value = Math.min(1, Math.max(0, value));
        if (this._manager && this._scale) {
            this._scale.value = value;
        } else if (this._gnome) {
            this._proxy.Brightness = Math.round(value * 100);
        } else if (this._ddc) {
            this._ddc.value = Math.round(value * this._ddc.max);
            this._send(this._ddc.value);
        }
    }

    // The monitor may have been changed with its own buttons: asked again when the panel opens.
    refresh() {
        if (this._ddc && !this._busy)
            this._probe();
    }

    // ---------- the monitor, over DDC/CI ----------
    async _probe() {
        if (!GLib.find_program_in_path('ddcutil'))
            return;
        const out = await this._run(['ddcutil', 'getvcp', VCP_BRIGHTNESS, '--brief']);
        // "VCP 10 C 50 100": current value and maximum.
        const match = out?.match(/VCP\s+10\s+C\s+(\d+)\s+(\d+)/);
        if (this._cancel.is_cancelled() || this._gnome)
            return;
        const had = !!this._ddc;
        this._ddc = match && Number(match[2]) > 0 ? {value: Number(match[1]), max: Number(match[2])} : null;
        if (had || this._ddc)
            this._onChange();
    }

    async _send(level) {
        if (this._busy) {
            this._pending = level;
            return;
        }
        this._busy = true;
        await this._run(['ddcutil', 'setvcp', VCP_BRIGHTNESS, String(level)]);
        this._busy = false;
        if (this._cancel.is_cancelled() || this._pending === null)
            return;
        const next = this._pending;
        this._pending = null;
        this._send(next);
    }

    _run(argv) {
        return new Promise(resolve => {
            try {
                const proc = Gio.Subprocess.new(argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
                proc.communicate_utf8_async(null, this._cancel, (p, res) => {
                    try {
                        const [, stdout] = p.communicate_utf8_finish(res);
                        resolve(p.get_successful() ? stdout : null);
                    } catch {
                        resolve(null);
                    }
                });
            } catch {
                resolve(null);
            }
        });
    }

    destroy() {
        this._cancel.cancel();
        if (this._managerId)
            this._manager.disconnect(this._managerId);
        if (this._scale && this._scaleId)
            this._scale.disconnect(this._scaleId);
        if (this._proxyId)
            this._proxy.disconnect(this._proxyId);
        this._manager = this._scale = this._proxy = null;
        this._onChange = () => {};
    }
}
