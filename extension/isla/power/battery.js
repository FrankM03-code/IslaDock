// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Batería: UPower's display device (what GNOME's own battery shows), read
// once for everyone who asks (the island and the Energía panel). With no
// battery it reports nothing and its readers hide.
//
// Signals: 'changed'.
import Gio from 'gi://Gio';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

const BUS_NAME = 'org.freedesktop.UPower';
const OBJECT_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
// UPower's DeviceState (UPowerGlib is not always installed).
const CHARGING = 1;
const FULLY_CHARGED = 4;
const PENDING_CHARGE = 5;
export const LOW = 20;

let shared = null;
let users = 0;

// One watcher for every reader; the last one to let go closes it.
export function acquireBattery() {
    if (!shared)
        shared = new Battery();
    users++;
    return shared;
}

export function releaseBattery() {
    if (--users > 0)
        return;
    shared?.destroy();
    shared = null;
    users = 0;
}

class Battery extends Signals.EventEmitter {
    constructor() {
        super();
        this.info = null;
        const Proxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.freedesktop.UPower.Device'));
        this._cancel = new Gio.Cancellable();
        this._proxy = new Proxy(Gio.DBus.system, BUS_NAME, OBJECT_PATH, (proxy, error) => {
            if (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`isla-dock: sin UPower: ${error.message}`);
                return;
            }
            this._propsId = proxy.connect('g-properties-changed', () => this._read(proxy));
            this._read(proxy);
        }, this._cancel);
    }

    // `source` has UPower's property names (a fake one in the tests).
    _read(source) {
        if (!source.IsPresent) {
            this._set(null);
            return;
        }
        const percent = Math.round(source.Percentage);
        const charged = source.State === FULLY_CHARGED || (source.State === CHARGING && percent >= 100);
        const charging = !charged && (source.State === CHARGING || source.State === PENDING_CHARGE);
        const level = 10 * Math.floor(percent / 10);
        this._set({
            percent,
            charged,
            charging,
            low: !charging && !charged && percent <= LOW,
            seconds: charging ? source.TimeToFull : charged ? 0 : source.TimeToEmpty,
            iconName: charged ? 'battery-level-100-charged-symbolic'
                : `battery-level-${level}${charging ? '-charging' : ''}-symbolic`,
            fallback: source.IconName || 'battery-symbolic',
        });
    }

    _set(info) {
        if (JSON.stringify(info) === JSON.stringify(this.info))
            return;
        this.info = info;
        this.emit('changed');
    }

    destroy() {
        this._cancel.cancel();
        if (this._propsId)
            this._proxy.disconnect(this._propsId);
        this._proxy = null;
        this.disconnectAll();
    }
}

// "1 h 20 min", "35 min"; nothing for unknown or under a minute.
function duration(seconds) {
    const minutes = Math.round(seconds / 60);
    if (!seconds || minutes < 1)
        return '';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

// "85 % · Cargando · 1 h 20 min para llenarse"
export function describe(info) {
    const parts = [`${info.percent} %`];
    const time = duration(info.seconds);
    if (info.charged)
        parts.push('Cargada');
    else if (info.charging)
        parts.push(time ? `Cargando · ${time} para llenarse` : 'Cargando');
    else if (time)
        parts.push(`Quedan ${time}`);
    return parts.join(' · ');
}
