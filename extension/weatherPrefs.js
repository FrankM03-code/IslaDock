// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Clima, in the preferences: pick the place of the weather by name. GNOME's own search only
// knows the cities in libgweather's list, so small towns are missing; here the name is looked
// up online (Open-Meteo, free and without an account) and the place is saved by its
// coordinates, next to the nearest weather station, in the Weather app and in the top bar's
// weather (which the island's calendar shows). Once saved, no internet is needed for it.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import GWeather from 'gi://GWeather?version=4.0';
import Soup from 'gi://Soup?version=3.0';

import {_, fmt} from './isla/i18n.js';

const SEARCH_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const RESULTS = 8;
const KEPT = 8;          // places remembered in each list
const WAIT = 500;        // ms after the last key before searching

const radians = d => d * Math.PI / 180;

function schema(id) {
    return Gio.SettingsSchemaSource.get_default().lookup(id, true) ? new Gio.Settings({schema_id: id}) : null;
}

// The closest station libgweather knows, for the weather of now: [code, latitude, longitude].
function nearestStation(lat, lon) {
    const city = GWeather.Location.get_world()?.find_nearest_city(lat, lon);
    for (let child = city?.next_child(null); child; child = city.next_child(child)) {
        if (child.get_level() === GWeather.LocationLevel.WEATHER_STATION && child.has_coords())
            return [child.get_code(), ...child.get_coords()];
    }
    return ['', lat, lon];
}

// The same form GNOME saves (the Weather app and the Shell read it back with deserialize).
function serialize(name, lat, lon) {
    const [code, slat, slon] = nearestStation(lat, lon);
    return new GLib.Variant('(uv)', [2, new GLib.Variant('(ssba(dd)a(dd))',
        [name, code, true, [[radians(lat), radians(lon)]], [[radians(slat), radians(slon)]]])]);
}

const placeName = v => v.get_child_value(1).get_variant().get_child_value(0).get_string()[0];

// The new place goes first (the one both use); the same name further down is dropped.
function putFirst(settings, place) {
    const name = placeName(place);
    const old = settings.get_value('locations').deepUnpack().filter(v => placeName(v) !== name);
    settings.set_value('locations', new GLib.Variant('av', [place, ...old].slice(0, KEPT)));
}

export class WeatherGroup {
    constructor(window) {
        this._window = window;
        this._shell = schema('org.gnome.shell.weather');
        this._app = schema('org.gnome.Weather');
        this._session = new Soup.Session({timeout: 15});
        this._cancel = null;
        this._timer = 0;
        this._rows = [];

        this.group = new Adw.PreferencesGroup({
            title: _('Clima'),
            description: _('La ciudad del clima del calendario y de Meteorología. Busca cualquier pueblo o ciudad (necesita internet).'),
        });
        this._current = new Adw.ActionRow({title: _('Ciudad del clima'), subtitle_selectable: true});
        this._current.add_prefix(new Gtk.Image({icon_name: 'find-location-symbolic'}));
        this.group.add(this._current);
        this.entry = new Adw.EntryRow({title: _('Buscar ciudad')});
        this.group.add(this.entry);
        this._status = new Adw.ActionRow({visible: false});
        this.group.add(this._status);

        this._syncCurrent();
        const id = this._shell?.connect('changed::locations', () => this._syncCurrent());
        this.entry.connect('changed', () => this._schedule());
        this.entry.connect('entry-activated', () => this._search());
        this.group.connect('destroy', () => {
            if (id)
                this._shell.disconnect(id);
            this._stop();
        });
    }

    _syncCurrent() {
        const list = this._shell?.get_value('locations').deepUnpack() ?? [];
        this._current.subtitle = this._shell?.get_boolean('automatic-location') && !list.length
            ? _('Automática') : list.length ? placeName(list[0]) : _('Ninguna todavía');
    }

    _stop() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._cancel?.cancel();
        this._cancel = null;
    }

    _schedule() {
        this._stop();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WAIT, () => {
            this._timer = 0;
            this._search();
            return GLib.SOURCE_REMOVE;
        });
    }

    _show(rows, status = '') {
        this._rows.forEach(r => this.group.remove(r));
        this._rows = rows;
        rows.forEach(r => this.group.add(r));
        this._status.visible = !!status;
        this._status.title = status;
    }

    _search() {
        this._stop();
        const text = this.entry.text.trim();
        if (text.length < 2) {
            this._show([]);
            return;
        }
        this._show([], _('Buscando…'));
        const query = Soup.form_encode_hash({name: text, count: `${RESULTS}`, language: 'es', format: 'json'});
        const message = Soup.Message.new('GET', `${SEARCH_URL}?${query}`);
        const cancel = this._cancel = new Gio.Cancellable();
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancel, (session, res) => {
            if (cancel.is_cancelled())
                return;
            this._cancel = null;
            let found;
            try {
                const bytes = session.send_and_read_finish(res);
                if (message.get_status() !== Soup.Status.OK)
                    throw new Error(`${message.get_status()}`);
                found = JSON.parse(new TextDecoder().decode(bytes.get_data())).results ?? [];
            } catch {
                this._show([], _('No se pudo buscar. ¿Hay internet?'));
                return;
            }
            if (!found.length) {
                this._show([], fmt(_('No se encontró «{nombre}»'), {nombre: text}));
                return;
            }
            this._show(found.map(place => this._resultRow(place)));
        });
    }

    _resultRow(place) {
        const where = [place.admin1, place.country].filter(Boolean).join(', ');
        const row = new Adw.ActionRow({title: GLib.markup_escape_text(place.name, -1),
            subtitle: GLib.markup_escape_text(where, -1)});
        const use = new Gtk.Button({label: _('Usar esta'), valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
        use.connect('clicked', () => this._use(place));
        row.add_suffix(use);
        row.activatable_widget = use;
        return row;
    }

    _use(place) {
        const saved = serialize(place.name, place.latitude, place.longitude);
        if (this._shell) {
            this._shell.set_boolean('automatic-location', false);
            putFirst(this._shell, saved);
        }
        if (this._app)
            putFirst(this._app, saved);
        this._show([]);
        this.entry.text = '';
        this._stop();
        this._window.add_toast(new Adw.Toast({timeout: 4,
            title: GLib.markup_escape_text(fmt(_('Clima de {nombre}'), {nombre: place.name}), -1)}));
    }
}
