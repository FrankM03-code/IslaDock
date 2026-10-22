// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Unread notifications: the app's dot keeps a ring until the app is opened or
// the notification is read (removed) in GNOME's list. The notifications
// themselves show at the top (floating.js or GNOME's banners), not in the island.
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

function appIdOf(source) {
    const app = source?.app ?? source?._app ?? null;
    if (app?.get_id)
        return app.get_id();
    const id = source?.policy?.id;
    return id && id !== 'generic' ? `${id}.desktop` : null;
}

export class Notices {
    constructor({state}) {
        this._state = state;
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
