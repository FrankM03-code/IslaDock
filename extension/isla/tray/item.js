// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Bandeja, part 2: one tray icon (a StatusNotifierItem). Reads the app's
// properties (title, status, icon by name, by file or as raw pixels, its
// menu) and calls it back on clicks. Apps announce changes with NewIcon,
// NewStatus… signals, often without PropertiesChanged: any of them reads the
// properties again.
//
// Signals: 'changed'.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {splitKey} from './watcher.js';

const IFACE = 'org.kde.StatusNotifierItem';
const ICON_SIZE = 32;          // pixels wanted from a pixmap (it is drawn smaller)
const REFRESH_DELAY = 100;     // signals come in bursts

// The property bag of an icon pixmap: a(iiay), ARGB in network byte order.
function pixmapIcon(pixmaps) {
    if (!pixmaps?.length)
        return null;
    const best = pixmaps.reduce((a, b) => {
        const score = ([w]) => (w >= ICON_SIZE ? w - ICON_SIZE : (ICON_SIZE - w) * 4);
        return score(b) < score(a) ? b : a;
    });
    const [width, height, data] = best;
    const argb = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!width || !height || argb.length < width * height * 4)
        return null;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < rgba.length; i += 4) {
        rgba[i] = argb[i + 1];
        rgba[i + 1] = argb[i + 2];
        rgba[i + 2] = argb[i + 3];
        rgba[i + 3] = argb[i];
    }
    const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(rgba), GdkPixbuf.Colorspace.RGB, true, 8,
        width, height, width * 4);
    const [ok, png] = pixbuf.save_to_bufferv('png', [], []);
    return ok ? Gio.BytesIcon.new(new GLib.Bytes(png)) : null;
}

// A name inside the app's own icon folder, or one from the icon theme.
function namedIcon(name, themePath) {
    if (!name)
        return null;
    if (name.startsWith('/'))
        return Gio.FileIcon.new(Gio.File.new_for_path(name));
    if (themePath) {
        const found = findIcon(themePath, name, 4);
        if (found)
            return Gio.FileIcon.new(Gio.File.new_for_path(found));
    }
    return new Gio.ThemedIcon({name});
}

function findIcon(dir, name, depth) {
    for (const ext of ['svg', 'png']) {
        const path = GLib.build_filenamev([dir, `${name}.${ext}`]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;
    }
    if (depth <= 0)
        return null;
    let children;
    try {
        children = Gio.File.new_for_path(dir).enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return null;
    }
    let info, found = null;
    while (!found && (info = children.next_file(null))) {
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            found = findIcon(GLib.build_filenamev([dir, info.get_name()]), name, depth - 1);
    }
    children.close(null);
    return found;
}

export class TrayItem extends Signals.EventEmitter {
    constructor(key) {
        super();
        this.key = key;
        [this.bus, this.path] = splitKey(key);
        this._conn = Gio.DBus.session;
        this.props = {};
        this.gicon = null;
        this._cancel = new Gio.Cancellable();
        this._signalId = this._conn.signal_subscribe(this.bus, IFACE, null, this.path, null, Gio.DBusSignalFlags.NONE,
            () => this._queueRefresh());
        this._propsId = this._conn.signal_subscribe(this.bus, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
            this.path, IFACE, Gio.DBusSignalFlags.NONE, () => this._queueRefresh());
        this._refresh();
    }

    get title() {
        return this.props.Title || this.props.ToolTip?.[2] || this.props.Id || '';
    }

    // Passive icons ask to stay out of sight.
    get visible() {
        return !!this.gicon && this.props.Status !== 'Passive';
    }

    get menuPath() {
        const menu = this.props.Menu;
        return menu && menu !== '/' ? menu : null;
    }

    _queueRefresh() {
        if (this._refreshId)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        this._conn.call(this.bus, this.path, 'org.freedesktop.DBus.Properties', 'GetAll', new GLib.Variant('(s)', [IFACE]),
            null, Gio.DBusCallFlags.NONE, -1, this._cancel, (conn, res) => {
                let props;
                try {
                    [props] = conn.call_finish(res).deepUnpack();
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`isla-dock: bandeja ${this.key}: ${e.message}`);
                    return;
                }
                const plain = {};
                for (const [name, value] of Object.entries(props))
                    plain[name] = value.recursiveUnpack();
                this.props = plain;
                this._updateIcon();
                this.emit('changed');
            });
    }

    _updateIcon() {
        const p = this.props;
        const attention = p.Status === 'NeedsAttention';
        try {
            this.gicon = (attention && (namedIcon(p.AttentionIconName, p.IconThemePath) ?? pixmapIcon(p.AttentionIconPixmap))) ||
                namedIcon(p.IconName, p.IconThemePath) || pixmapIcon(p.IconPixmap);
        } catch (e) {
            console.warn(`isla-dock: bandeja ${this.key}: ícono: ${e.message}`);
            this.gicon = null;
        }
    }

    _call(method, params) {
        return new Promise((resolve, reject) => {
            this._conn.call(this.bus, this.path, IFACE, method, params, null, Gio.DBusCallFlags.NONE, -1, this._cancel,
                (conn, res) => {
                    try {
                        resolve(conn.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    // Left click. False when the app has no Activate (then its menu is the answer).
    async activate(x, y) {
        if (this.props.ItemIsMenu && this.menuPath)
            return false;
        try {
            await this._call('Activate', new GLib.Variant('(ii)', [x, y]));
            return true;
        } catch {
            return false;
        }
    }

    secondaryActivate(x, y) {
        this._call('SecondaryActivate', new GLib.Variant('(ii)', [x, y])).catch(() => {});
    }

    // Right click on an app without a D-Bus menu: it draws its own.
    contextMenu(x, y) {
        this._call('ContextMenu', new GLib.Variant('(ii)', [x, y])).catch(() => {});
    }

    scroll(delta, vertical) {
        this._call('Scroll', new GLib.Variant('(is)', [delta, vertical ? 'vertical' : 'horizontal'])).catch(() => {});
    }

    destroy() {
        this._cancel.cancel();
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
        this._conn.signal_unsubscribe(this._signalId);
        this._conn.signal_unsubscribe(this._propsId);
        this.disconnectAll();
    }
}
