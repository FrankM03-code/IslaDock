// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Batería in the island: the battery icon and, unless switched off in
// Preferences ('bateria-porcentaje'), its percentage, at the right end of the
// folded island and before Energía in the open dock. Red when it runs low.
// Without a battery nothing shows.
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {acquireBattery, describe, releaseBattery} from './power/battery.js';

const ORDER = 30;

export class BatteryStatus {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._folded = this._makePart('isla-bateria');
        this._open = this._makePart('isla-bateria isla-bateria-abierta');
        this._battery = acquireBattery();
        this._batteryId = this._battery.connect('changed', () => this._sync());
        this._settingsId = settings.connect('changed::bateria-porcentaje', () => this._sync());
        this._sync();
    }

    _makePart(cls) {
        const box = new St.BoxLayout({style_class: cls, y_align: Clutter.ActorAlign.CENTER, reactive: false});
        box._icon = new St.Icon({style_class: 'isla-bateria-icono', y_align: Clutter.ActorAlign.CENTER});
        box._label = new St.Label({style_class: 'isla-bateria-texto', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(box._icon);
        box.add_child(box._label);
        return box;
    }

    _sync() {
        const info = this._battery.info;
        if (!info) {
            this._state.removeStatus('battery');
            return;
        }
        const withText = this._settings.get_boolean('bateria-porcentaje');
        for (const part of [this._folded, this._open]) {
            part._icon.icon_name = info.iconName;
            part._icon.fallback_icon_name = info.fallback;
            part._label.text = `${info.percent} %`;
            part._label.visible = withText;
            part.accessible_name = describe(info);
            if (info.low)
                part.add_style_class_name('baja');
            else
                part.remove_style_class_name('baja');
        }
        this._state.setStatus('battery', {order: ORDER, folded: this._folded, open: this._open});
    }

    destroy() {
        this._state.removeStatus('battery');
        this._battery.disconnect(this._batteryId);
        this._settings.disconnect(this._settingsId);
        releaseBattery();
        this._battery = null;
        this._folded.destroy();
        this._open.destroy();
    }
}
