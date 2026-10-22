// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Discreet notices (A6): each new GNOME notification opens the island for a
// moment with the app icon, the title and one line of the body. GNOME's own
// banners stay. The app's dot keeps a ring until the app is opened or the
// notification is read (removed) in GNOME's list.
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {iconColor} from './dots.js';

function appIdOf(source) {
    const app = source?.app ?? source?._app ?? null;
    if (app?.get_id)
        return app.get_id();
    const id = source?.policy?.id;
    return id && id !== 'generic' ? `${id}.desktop` : null;
}

export class Notices {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._sources = new Map();       // source -> [signal ids]
        this._unread = new Map();        // app id -> Set(notification)
        this._watched = new Map();       // notification -> destroy signal id
        this._trayIds = [
            Main.messageTray.connect('source-added', (_t, source) => this._watch(source)),
            Main.messageTray.connect('source-removed', (_t, source) => this._unwatch(source)),
        ];
        Main.messageTray.getSources().forEach(s => this._watch(s));
        this._tracker = Shell.WindowTracker.get_default();
        this._focusId = this._tracker.connect('notify::focus-app', () => {
            const id = this._tracker.focus_app?.get_id();
            if (id && this._unread.has(id))
                this._clear(id);
        });
    }

    _watch(source) {
        if (this._sources.has(source))
            return;
        this._sources.set(source, [source.connect('notification-added', (_s, n) => this._onNotification(source, n))]);
    }

    _unwatch(source) {
        this._sources.get(source)?.forEach(id => source.disconnect(id));
        this._sources.delete(source);
    }

    _onNotification(source, notification) {
        const appId = appIdOf(source);
        if (appId && this._state.runningApps?.some(a => a.id === appId)) {
            if (!this._unread.has(appId))
                this._unread.set(appId, new Set());
            this._unread.get(appId).add(notification);
            const id = notification.connect('destroy', () => {
                this._watched.delete(notification);
                const set = this._unread.get(appId);
                set?.delete(notification);
                if (set && !set.size)
                    this._clear(appId);
            });
            this._watched.set(notification, id);
            this._state.command('unread', appId, true);
        }
        if (this._state.dnd || !this._settings.get_boolean('isla-avisos'))
            return;
        const gicon = notification.gicon ?? source.icon ?? null;
        this._state.command('notice', {
            actor: this._buildActor(source, notification),
            // The app's color (some skins paint a stripe with it).
            color: iconColor(appId ?? source.title ?? 'aviso', source.app?.get_icon?.() ?? gicon),
            activate: () => {
                Main.overview.hide();
                notification.activate();
            },
        });
    }

    _buildActor(source, notification) {
        const box = new St.BoxLayout({style_class: 'isla-aviso'});
        const gicon = notification.gicon ?? source.icon ?? null;
        box.add_child(new St.Icon({style_class: 'isla-aviso-icono', gicon, fallback_icon_name: 'dialog-information-symbolic',
            y_align: Clutter.ActorAlign.CENTER}));
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        const oneLine = s => (s ?? '').replace(/\s+/g, ' ').trim();
        const title = new St.Label({style_class: 'isla-aviso-titulo', text: oneLine(notification.title || source.title)});
        const body = new St.Label({style_class: 'isla-aviso-cuerpo', text: oneLine(notification.body)});
        for (const label of [title, body])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        body.visible = !!body.text;
        text.add_child(title);
        text.add_child(body);
        box.add_child(text);
        return box;
    }

    _clear(appId) {
        this._unread.delete(appId);
        this._state.command('unread', appId, false);
    }

    destroy() {
        this._trayIds.forEach(id => Main.messageTray.disconnect(id));
        this._trayIds = [];
        for (const source of [...this._sources.keys()])
            this._unwatch(source);
        this._tracker.disconnect(this._focusId);
        for (const [notification, id] of this._watched)
            notification.disconnect(id);
        this._watched.clear();
        for (const appId of [...this._unread.keys()])
            this._clear(appId);
    }
}
