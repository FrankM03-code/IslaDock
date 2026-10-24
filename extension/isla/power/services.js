// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What the Energía panel's toggles switch. Network and Bluetooth reuse GNOME's
// own Quick Settings toggles (still alive with the top bar hidden), so they
// behave and update exactly like the native ones. Power mode, night light,
// dark style and caffeine are read and written here.
//
// Every toggle: {visible, on, icon (Gio.Icon), title, click(), settings?, connect(fn) -> disconnect}
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {_, N_, fmt} from '../i18n.js';

const PROFILES = {
    'power-saver': [N_('Ahorro de energía'), 'power-profile-power-saver-symbolic'],
    'balanced': [N_('Equilibrado'), 'power-profile-balanced-symbolic'],
    'performance': [N_('Rendimiento'), 'power-profile-performance-symbolic'],
};
const ROTATION = ['power-saver', 'balanced', 'performance'];
// Inhibit idle (8) and suspend (4), like the Caffeine extension.
const INHIBIT_FLAGS = 4 | 8;

function themed(name) {
    return new Gio.ThemedIcon({name});
}

export function openSettings(panel) {
    try {
        GLib.spawn_command_line_async(panel ? `gnome-control-center ${panel}` : 'gnome-control-center');
    } catch (e) {
        Main.notifyError(_('No se pudo abrir Configuración'), e.message);
    }
}

// A GNOME Quick Settings toggle seen through the panel's interface.
class NativeToggle {
    constructor(find, fallbackIcon, settingsPanel) {
        this._find = find;
        this._fallback = themed(fallbackIcon);
        this.settings = () => openSettings(settingsPanel);
    }

    get _toggle() {
        try {
            return this._find() ?? null;
        } catch {
            return null;
        }
    }

    get visible() {
        return !!this._toggle?.visible;
    }

    get on() {
        return !!this._toggle?.checked;
    }

    get icon() {
        const t = this._toggle;
        return t?.gicon ?? (t?.iconName ? themed(t.iconName) : this._fallback);
    }

    get title() {
        const t = this._toggle;
        if (!t)
            return '';
        return t.subtitle ? `${t.title}: ${t.subtitle}` : t.title;
    }

    click() {
        this._toggle?.emit('clicked', 1);
    }

    connect(fn) {
        const t = this._toggle;
        if (!t)
            return () => {};
        const ids = ['checked', 'visible', 'gicon', 'icon-name', 'title', 'subtitle'].map(p => t.connect(`notify::${p}`, fn));
        return () => ids.forEach(id => t.disconnect(id));
    }
}

const quickSettings = () => Main.panel.statusArea.quickSettings;

// Wired, or Wi-Fi when there is no cable (a laptop).
class NetworkToggle {
    constructor() {
        this._wired = new NativeToggle(() => quickSettings()._network?.quickSettingsItems
            .find(t => t.constructor.name === 'NMWiredToggle'), 'network-wired-symbolic', 'network');
        this._wifi = new NativeToggle(() => quickSettings()._network?.quickSettingsItems
            .find(t => t.constructor.name === 'NMWirelessToggle'), 'network-wireless-symbolic', 'wifi');
    }

    get _current() {
        return this._wired.visible || !this._wifi.visible ? this._wired : this._wifi;
    }

    get visible() {
        return this._current.visible;
    }

    get on() {
        return this._current.on;
    }

    get icon() {
        return this._current.icon;
    }

    get title() {
        return this._current.title || _('Red cableada');
    }

    click() {
        this._current.click();
    }

    settings() {
        this._current.settings();
    }

    connect(fn) {
        const a = this._wired.connect(fn), b = this._wifi.connect(fn);
        return () => {
            a();
            b();
        };
    }
}

// A boolean in GSettings, read and written as is.
class SettingToggle {
    constructor(schema, key, icon, title, settingsPanel, {on = v => v, set = v => v} = {}) {
        this._gs = new Gio.Settings({schema_id: schema});
        this._key = key;
        this._map = {on, set};
        this.icon = themed(icon);
        this.title = title;
        this.visible = true;
        this.settings = () => openSettings(settingsPanel);
    }

    get on() {
        return this._map.on(this._gs.get_value(this._key).recursiveUnpack());
    }

    click() {
        const value = this._map.set(!this.on);
        if (typeof value === 'boolean')
            this._gs.set_boolean(this._key, value);
        else
            this._gs.set_string(this._key, value);
    }

    connect(fn) {
        const id = this._gs.connect(`changed::${this._key}`, fn);
        return () => this._gs.disconnect(id);
    }
}

// net.hadess.PowerProfiles: a click goes ahorro → equilibrado → rendimiento → ahorro.
class PowerModeToggle extends Signals.EventEmitter {
    constructor() {
        super();
        this._proxy = null;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'net.hadess.PowerProfiles', '/net/hadess/PowerProfiles', 'net.hadess.PowerProfiles', null, (_o, res) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                    // Switched off before the answer came.
                    if (this._destroyed)
                        return;
                    this._proxy = proxy;
                    this._proxyId = this._proxy.connect('g-properties-changed', () => this.emit('changed'));
                    this.emit('changed');
                } catch (e) {
                    console.debug(`isla-dock: sin modos de energía: ${e.message}`);
                }
            });
        this.settings = () => openSettings('power');
    }

    get _active() {
        return this._proxy?.get_cached_property('ActiveProfile')?.unpack() ?? null;
    }

    get _profiles() {
        const list = this._proxy?.get_cached_property('Profiles')?.recursiveUnpack() ?? [];
        return ROTATION.filter(p => list.some(item => item.Profile === p));
    }

    get visible() {
        return !!this._proxy?.g_name_owner && !!this._active;
    }

    get on() {
        return this.visible && this._active !== 'balanced';
    }

    get icon() {
        return themed((PROFILES[this._active] ?? PROFILES.balanced)[1]);
    }

    get title() {
        return fmt(_('Modo de energía: {modo}'), {modo: this.state});
    }

    // Just the mode's name ("Equilibrado"), for the panel styles that show a state.
    get state() {
        return _((PROFILES[this._active] ?? PROFILES.balanced)[0]);
    }

    click() {
        const list = this._profiles;
        if (!this._proxy || list.length < 2)
            return;
        const next = list[(list.indexOf(this._active) + 1) % list.length];
        this._proxy.call('org.freedesktop.DBus.Properties.Set',
            new GLib.Variant('(ssv)', ['net.hadess.PowerProfiles', 'ActiveProfile', new GLib.Variant('s', next)]),
            Gio.DBusCallFlags.NONE, -1, null, (p, res) => {
                try {
                    p.call_finish(res);
                } catch (e) {
                    Main.notifyError(_('No se pudo cambiar el modo de energía'), e.message);
                }
            });
    }

    connect(fn) {
        const id = super.connect('changed', fn);
        return () => this.disconnect(id);
    }

    destroy() {
        this._destroyed = true;
        if (this._proxyId)
            this._proxy.disconnect(this._proxyId);
        this._proxy = null;
    }
}

// Cafeína: our own inhibitor in GNOME's session manager (no suspend, no screen
// blank). It is remembered in 'cafeina-activa', so it comes back after a GNOME
// restart or the lock screen (which switches extensions off and on). The
// panel's button and the switch in Preferences both just write that key.
class CaffeineToggle extends Signals.EventEmitter {
    constructor(dir, settings) {
        super();
        this._settings = settings;
        this._cookie = 0;
        this._pending = false;
        this.icon = new Gio.FileIcon({file: dir.get_child('icons').get_child('isla-cafeina-symbolic.svg')});
        this.visible = true;
        this._keyId = settings.connect('changed::cafeina-activa', () => this._sync());
        this._sync();
    }

    get on() {
        return !!this._cookie || this._pending;
    }

    get title() {
        return this.on ? _('Cafeína: la pantalla no se apaga') : _('Cafeína');
    }

    _call(method, params, done) {
        Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
            method, params, null, Gio.DBusCallFlags.NONE, -1, null, (bus, res) => {
                try {
                    done?.(bus.call_finish(res));
                } catch (e) {
                    console.error(`isla-dock: cafeína: ${e.message}`);
                    done?.(null);
                }
            });
    }

    _sync() {
        const want = this._settings.get_boolean('cafeina-activa');
        if (want && !this._cookie && !this._pending)
            this._inhibit();
        else if (!want && this._cookie)
            this._uninhibit();
    }

    _inhibit() {
        this._pending = true;
        this.emit('changed');
        this._call('Inhibit', new GLib.Variant('(susu)', ['isla-dock', 0, 'Cafeína (IslaDock)', INHIBIT_FLAGS]), reply => {
            this._pending = false;
            if (reply)
                this._cookie = reply.deepUnpack()[0];
            // It could not be switched on: the key goes back, so the button can try again.
            else if (!this._destroyed)
                this._settings.set_boolean('cafeina-activa', false);
            // Switched off (or the extension was) while the answer was on its way.
            if (this._cookie && (this._destroyed || !this._settings.get_boolean('cafeina-activa'))) {
                this._uninhibit();
                return;
            }
            if (!this._destroyed)
                this.emit('changed');
        });
    }

    _uninhibit() {
        this._call('Uninhibit', new GLib.Variant('(u)', [this._cookie]));
        this._cookie = 0;
        if (!this._destroyed)
            this.emit('changed');
    }

    click() {
        if (!this._pending)
            this._settings.set_boolean('cafeina-activa', !this._cookie);
    }

    connect(fn) {
        const id = super.connect('changed', fn);
        return () => this.disconnect(id);
    }

    // The key stays as it is: switched off with the extension is not switched off by the user.
    destroy() {
        this._destroyed = true;
        this._settings.disconnect(this._keyId);
        if (this._cookie)
            this._uninhibit();
    }
}

// Row 1, in order: red, bluetooth, modo de energía, luz nocturna, estilo oscuro, cafeína.
export function createToggles(dir, settings) {
    return [
        new NetworkToggle(),
        new NativeToggle(() => quickSettings()._bluetooth?.quickSettingsItems[0], 'bluetooth-active-symbolic', 'bluetooth'),
        new PowerModeToggle(),
        new SettingToggle('org.gnome.settings-daemon.plugins.color', 'night-light-enabled', 'night-light-symbolic',
            _('Luz nocturna'), 'display'),
        new SettingToggle('org.gnome.desktop.interface', 'color-scheme', 'dark-mode-symbolic', _('Estilo oscuro'), 'appearance',
            {on: v => v === 'prefer-dark', set: on => (on ? 'prefer-dark' : 'default')}),
        new CaffeineToggle(dir, settings),
    ];
}
