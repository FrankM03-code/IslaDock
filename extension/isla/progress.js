// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Task progress (C1): apps publish progress and counters with the
// com.canonical.Unity.LauncherEntry "Update" signal (the standard Dash to Dock
// and Plank read). Folded: a 2 px line fills along the bottom of the island;
// open: one row per app with its icon, name, percentage and bar. `count` is a
// badge on the app's icon. Apps that do not publish it show nothing: no
// progress is ever made up.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Priority} from './state.js';

const ROW_WIDTH = 220;

export class Progress {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._entries = new Map();     // app id -> {sender, progress, visible, count, countVisible}
        this._panel = new St.BoxLayout({style_class: 'isla-progreso', orientation: Clutter.Orientation.VERTICAL});
        const bus = Gio.DBus.session;
        this._updateId = bus.signal_subscribe(null, 'com.canonical.Unity.LauncherEntry', 'Update', null, null,
            Gio.DBusSignalFlags.NONE, (_c, sender, _path, _iface, _signal, params) => {
                try {
                    const [uri, props] = params.recursiveUnpack();
                    this._onUpdate(sender, uri, props);
                } catch (e) {
                    console.warn(`isla-dock: progreso: ${e.message}`);
                }
            });
        // An app that leaves the bus takes its progress with it.
        this._ownerId = bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _sig, params) => {
                const [name, , owner] = params.deepUnpack();
                if (owner)
                    return;
                for (const [id, e] of this._entries) {
                    if (e.sender === name)
                        this._drop(id);
                }
                this._refresh();
            });
    }

    _onUpdate(sender, uri, props) {
        const id = uri.replace(/^application:\/\//, '');
        const e = this._entries.get(id) ?? {sender, progress: 0, visible: false, count: 0, countVisible: false};
        e.sender = sender;
        if ('progress' in props)
            e.progress = Math.max(0, Math.min(1, Number(props.progress)));
        if ('progress-visible' in props)
            e.visible = !!props['progress-visible'];
        if ('count' in props)
            e.count = Number(props.count);
        if ('count-visible' in props)
            e.countVisible = !!props['count-visible'];
        this._entries.set(id, e);
        this._state.command('badge', id, e.countVisible && e.count > 0 ? e.count : null);
        if (!e.visible && !e.countVisible)
            this._entries.delete(id);
        this._refresh();
    }

    _drop(id) {
        this._entries.delete(id);
        this._state.command('badge', id, null);
    }

    _refresh() {
        const shown = [...this._entries].filter(([, e]) => e.visible);
        // The Downloads stack matches a browser's progress with its download.
        this._state.launcherProgress = shown.map(([id, e]) => ({id, progress: e.progress}));
        this._state.emit('launcher-progress');
        if (!shown.length || !this._settings.get_boolean('isla-progreso')) {
            this._state.command('progress', null);
            this._state.removeActivity('progress');
            return;
        }
        const average = shown.reduce((sum, [, e]) => sum + e.progress, 0) / shown.length;
        this._state.command('progress', average);
        this._panel.destroy_all_children();
        for (const [id, e] of shown)
            this._panel.add_child(this._row(id, e));
        this._state.setActivity('progress', {priority: Priority.PROGRESS, mini: null, panel: this._panel});
        this._state.command('resize');
    }

    _row(id, e) {
        const app = Shell.AppSystem.get_default().lookup_app(id);
        const row = new St.BoxLayout({style_class: 'isla-progreso-fila', orientation: Clutter.Orientation.VERTICAL});
        const top = new St.BoxLayout({style_class: 'isla-progreso-cabecera'});
        top.add_child(new St.Icon({style_class: 'isla-progreso-icono', gicon: app?.get_icon() ?? null,
            fallback_icon_name: 'application-x-executable-symbolic', y_align: Clutter.ActorAlign.CENTER}));
        const name = new St.Label({style_class: 'isla-progreso-nombre', text: app?.get_name() ?? id.replace(/\.desktop$/, ''),
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        top.add_child(name);
        top.add_child(new St.Label({style_class: 'isla-progreso-porcentaje', text: `${Math.round(e.progress * 100)} %`,
            y_align: Clutter.ActorAlign.CENTER}));
        row.add_child(top);
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const track = new St.Widget({style_class: 'isla-progreso-pista', layout_manager: new Clutter.BinLayout()});
        track.set_width(ROW_WIDTH * sf);
        const fill = new St.Widget({style_class: 'isla-progreso-relleno', x_align: Clutter.ActorAlign.START,
            x_expand: true, y_expand: true});
        fill.set_width(Math.round(ROW_WIDTH * sf * e.progress));
        track.add_child(fill);
        row.add_child(track);
        return row;
    }

    destroy() {
        Gio.DBus.session.signal_unsubscribe(this._updateId);
        Gio.DBus.session.signal_unsubscribe(this._ownerId);
        for (const id of [...this._entries.keys()])
            this._drop(id);
        this._state.command('progress', null);
        this._state.removeActivity('progress');
        this._panel.destroy();
    }
}
