// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Bandeja, part 1: who keeps the list of tray icons. Apps register their icon
// (StatusNotifierItem) with org.kde.StatusNotifierWatcher on the session bus.
// If nobody owns that name, IslaDock becomes the watcher; if someone does
// (the AppIndicator extension, for one), IslaDock only reads that watcher's
// list, so the icons are never registered twice.
//
// Signals: 'item-added' (key), 'item-removed' (key). A key is "bus-name/object/path".
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const NAME = 'org.kde.StatusNotifierWatcher';
const PATH = '/StatusNotifierWatcher';
const DEFAULT_ITEM_PATH = '/StatusNotifierItem';
const IFACE = `<node>
  <interface name="${NAME}">
    <method name="RegisterStatusNotifierItem"><arg type="s" direction="in" name="service"/></method>
    <method name="RegisterStatusNotifierHost"><arg type="s" direction="in" name="service"/></method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
    <signal name="StatusNotifierItemUnregistered"><arg type="s"/></signal>
    <signal name="StatusNotifierHostRegistered"/>
    <signal name="StatusNotifierHostUnregistered"/>
  </interface>
</node>`;

// "bus/path" → [bus, path]
export function splitKey(key) {
    const at = key.indexOf('/');
    return at < 0 ? [key, DEFAULT_ITEM_PATH] : [key.slice(0, at), key.slice(at)];
}

export class Watcher extends Signals.EventEmitter {
    constructor() {
        super();
        this._bus = Gio.DBus.session;
        this._items = new Map();        // key -> name watch id (0 when someone else is the watcher)
        this._ownId = Gio.bus_own_name_on_connection(this._bus, NAME, Gio.BusNameOwnerFlags.NONE,
            () => this._becameWatcher(), () => this._lostName());
    }

    get keys() {
        return [...this._items.keys()];
    }

    get isOwner() {
        return !!this._exported;
    }

    // ---------- IslaDock is the watcher ----------
    _becameWatcher() {
        this._dropForeign();
        this._exported = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._exported.export(this._bus, PATH);
        // Apps already running register again when they see the name come.
        this._exported.emit_signal('StatusNotifierHostRegistered', null);
    }

    RegisterStatusNotifierItemAsync([service], invocation) {
        const sender = invocation.get_sender();
        // Some pass their object path, others a bus name (well-known or unique).
        const key = service.startsWith('/') ? `${sender}${service}`
            : service.includes('/') ? service : `${service}${DEFAULT_ITEM_PATH}`;
        invocation.return_value(null);
        this._addOwned(key);
    }

    RegisterStatusNotifierHostAsync(_params, invocation) {
        invocation.return_value(null);
    }

    get RegisteredStatusNotifierItems() {
        return this.keys;
    }

    get IsStatusNotifierHostRegistered() {
        return true;
    }

    get ProtocolVersion() {
        return 0;
    }

    _addOwned(key) {
        if (this._items.has(key))
            return;
        const [bus] = splitKey(key);
        // The app leaving the bus takes its icon with it.
        const watchId = Gio.bus_watch_name_on_connection(this._bus, bus, Gio.BusNameWatcherFlags.NONE, null,
            () => this._remove(key));
        this._items.set(key, watchId);
        this._exported?.emit_signal('StatusNotifierItemRegistered', new GLib.Variant('(s)', [key]));
        this._exported?.emit_property_changed('RegisteredStatusNotifierItems', new GLib.Variant('as', this.keys));
        this.emit('item-added', key);
    }

    _remove(key) {
        if (!this._items.has(key))
            return;
        const watchId = this._items.get(key);
        if (watchId)
            Gio.bus_unwatch_name(watchId);
        this._items.delete(key);
        this._exported?.emit_signal('StatusNotifierItemUnregistered', new GLib.Variant('(s)', [key]));
        this._exported?.emit_property_changed('RegisteredStatusNotifierItems', new GLib.Variant('as', this.keys));
        this.emit('item-removed', key);
    }

    // ---------- someone else is the watcher: read its list ----------
    _lostName() {
        if (this._exported) {
            this._exported.unexport();
            this._exported = null;
            for (const key of this.keys)
                this._remove(key);
        }
        if (this._foreignIds)
            return;
        this._foreignIds = [
            this._bus.signal_subscribe(null, NAME, 'StatusNotifierItemRegistered', PATH, null, Gio.DBusSignalFlags.NONE,
                (_c, _s, _p, _i, _n, params) => this._addForeign(params.deepUnpack()[0])),
            this._bus.signal_subscribe(null, NAME, 'StatusNotifierItemUnregistered', PATH, null, Gio.DBusSignalFlags.NONE,
                (_c, _s, _p, _i, _n, params) => this._remove(this._normal(params.deepUnpack()[0]))),
        ];
        this._bus.call(NAME, PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [NAME, 'RegisteredStatusNotifierItems']), null, Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    const [value] = conn.call_finish(res).deepUnpack();
                    value.deepUnpack().forEach(key => this._addForeign(key));
                } catch (e) {
                    console.warn(`isla-dock: bandeja: ${e.message}`);
                }
            });
    }

    _normal(key) {
        return key.includes('/') ? key : `${key}${DEFAULT_ITEM_PATH}`;
    }

    _addForeign(key) {
        key = this._normal(key);
        if (this._items.has(key))
            return;
        this._items.set(key, 0);
        this.emit('item-added', key);
    }

    _dropForeign() {
        this._foreignIds?.forEach(id => this._bus.signal_unsubscribe(id));
        this._foreignIds = null;
        for (const key of this.keys)
            this._remove(key);
    }

    destroy() {
        this._dropForeign();
        for (const key of this.keys)
            this._remove(key);
        this._exported?.unexport();
        this._exported = null;
        Gio.bus_unown_name(this._ownId);
        this.disconnectAll();
    }
}
