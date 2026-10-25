// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Clima, at the top of the calendar: the weather now (icon, temperature, sky and place) and
// the next days (icon, highest and lowest). It comes from GNOME's own weather service, the
// one the top bar's date menu uses (its place is the first one in the Weather app), so
// nothing is asked twice. Clicking it opens the Weather app; clicking the place's name opens
// the Clima group of the preferences, to pick another place. Hidden while there is no answer.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {_} from './i18n.js';

const DAYS = 4;
const MIDDAY = 13;   // the hour whose sky stands for the whole day

const capital = s => s.charAt(0).toLocaleUpperCase() + s.slice(1);

function degrees(info) {
    const [ok, value] = info.get_value_temp(GWeather.TemperatureUnit.DEFAULT);
    return ok ? Math.round(value) : null;
}

// The forecast comes every few hours: one entry per coming day, with its highest, lowest and
// the sky around midday.
function nextDays(info) {
    const today = GLib.DateTime.new_now_local().format('%F');
    const days = new Map();
    for (const entry of info.get_forecast_list()) {
        const [ok, when] = entry.get_value_update();
        const value = degrees(entry);
        if (!ok || value === null)
            continue;
        const date = GLib.DateTime.new_from_unix_local(when);
        const key = date.format('%F');
        if (key <= today)
            continue;
        const day = days.get(key) ?? {date, high: value, low: value, icon: null, far: Infinity};
        day.high = Math.max(day.high, value);
        day.low = Math.min(day.low, value);
        const far = Math.abs(date.get_hour() - MIDDAY);
        if (far < day.far) {
            day.far = far;
            day.icon = entry.get_symbolic_icon_name();
        }
        days.set(key, day);
    }
    return [...days.values()].slice(0, DAYS);
}

export class WeatherStrip {
    // onOpen: called when the Weather app or the preferences are opened from here (the calendar closes).
    constructor(onOpen, settings) {
        this._client = Main.panel.statusArea.dateMenu?._weatherItem?._weatherClient ?? null;
        this.actor = new St.Button({style_class: 'isla-cal-clima', can_focus: true, x_expand: true,
            accessible_name: _('Abrir Meteorología')});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const now = new St.BoxLayout({style_class: 'isla-cal-clima-ahora'});
        this._icon = new St.Icon({style_class: 'isla-cal-clima-icono', y_align: Clutter.ActorAlign.CENTER});
        this._temp = new St.Label({style_class: 'isla-cal-clima-temp', y_align: Clutter.ActorAlign.CENTER});
        const words = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._sky = new St.Label({style_class: 'isla-cal-clima-cielo'});
        this._place = new St.Label();
        const place = new St.Button({style_class: 'isla-cal-clima-lugar', child: this._place, can_focus: true,
            x_align: Clutter.ActorAlign.START, accessible_name: _('Cambiar la ciudad del clima')});
        place.connect('clicked', () => {
            settings.set_string('preferencias-abrir', 'clima');
            Extension.lookupByURL(import.meta.url)?.openPreferences();
            onOpen();
        });
        words.add_child(this._sky);
        words.add_child(place);
        now.add_child(this._icon);
        now.add_child(this._temp);
        now.add_child(words);
        this._days = new St.BoxLayout({style_class: 'isla-cal-clima-dias', x_expand: true});
        box.add_child(now);
        box.add_child(this._days);
        this.actor.child = box;
        this.actor.connect('clicked', () => {
            this._client.activateApp();
            onOpen();
        });

        this.actor.visible = false;
        if (!this._client)
            return;
        const id = this._client.connect('changed', () => this._sync());
        this.actor.connect('destroy', () => this._client.disconnect(id));
        this._sync();
        this._client.update();
    }

    _sync() {
        const client = this._client;
        const info = client.info;
        const ok = client.available && client.hasLocation && info.is_valid() && degrees(info) !== null;
        this.actor.visible = ok;
        if (!ok)
            return;
        this._icon.icon_name = info.get_symbolic_icon_name();
        this._temp.text = `${degrees(info)}°`;
        const conditions = info.get_conditions();
        this._sky.text = capital(conditions && conditions !== '-' ? conditions : info.get_sky());
        this._place.text = info.get_location_name();

        this._days.destroy_all_children();
        for (const day of nextDays(info)) {
            const column = new St.BoxLayout({style_class: 'isla-cal-clima-dia', orientation: Clutter.Orientation.VERTICAL,
                x_expand: true});
            column.add_child(new St.Label({style_class: 'isla-cal-clima-nombre', x_align: Clutter.ActorAlign.CENTER,
                text: capital(day.date.format('%a')).replace(/\.$/, '')}));
            column.add_child(new St.Icon({style_class: 'isla-cal-clima-dia-icono', icon_name: day.icon,
                x_align: Clutter.ActorAlign.CENTER}));
            const range = new St.BoxLayout({style_class: 'isla-cal-clima-rango', x_align: Clutter.ActorAlign.CENTER});
            range.add_child(new St.Label({style_class: 'isla-cal-clima-alta', text: `${day.high}°`}));
            range.add_child(new St.Label({style_class: 'isla-cal-clima-baja', text: `${day.low}°`}));
            column.add_child(range);
            this._days.add_child(column);
        }
        this._days.visible = this._days.get_n_children() > 0;
    }
}
