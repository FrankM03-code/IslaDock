// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The notifications the top island shows (Frank's isla-notificaciones design): it
// follows GNOME's message tray like the floating notices do and keeps the ones still
// waiting to be seen, newest first. Same rules as GNOME's banners (wantsBanner): in do
// not disturb only critical ones ask to be shown; the rest are just counted (the
// status dot). A notification closed elsewhere leaves by itself.
// onChange(asksToShow): the list changed; asksToShow = a new one wants the island to widen.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {wantsBanner} from '../banners.js';

export class NotchNotices {
    constructor({state, onChange}) {
        this._state = state;
        this._onChange = onChange;
        this.list = [];                  // [{notification, source, at}] newest first
        this._sources = new Map();       // source -> signal id
        this._notes = new Map();         // notification -> [signal ids]
        this._trayIds = [
            Main.messageTray.connect('source-added', (_t, source) => this._watch(source)),
            Main.messageTray.connect('source-removed', (_t, source) => this._unwatch(source)),
        ];
        Main.messageTray.getSources().forEach(s => this._watch(s));
    }

    _watch(source) {
        if (!this._sources.has(source))
            this._sources.set(source, source.connect('notification-added', (_s, n) => this._add(source, n)));
    }

    _unwatch(source) {
        const id = this._sources.get(source);
        if (id)
            source.disconnect(id);
        this._sources.delete(source);
    }

    _add(source, notification) {
        if (!this._notes.has(notification)) {
            this._notes.set(notification, [
                // An app saying something new in the same notification clears "acknowledged".
                notification.connect('notify::acknowledged', () => !notification.acknowledged && this._push(source, notification)),
                notification.connect('destroy', () => this._remove(notification)),
            ]);
        }
        this._push(source, notification);
    }

    _push(source, notification) {
        if (notification.urgency === MessageTray.Urgency.LOW)
            return;
        // Seen here: GNOME won't queue it as a banner.
        notification.acknowledged = true;
        this.list = [{notification, source, at: Date.now()}, ...this.list.filter(e => e.notification !== notification)];
        const critical = notification.urgency === MessageTray.Urgency.CRITICAL;
        this._onChange(wantsBanner(notification) && (!this._state.dnd || critical));
    }

    _forget(notification) {
        this._notes.get(notification)?.forEach(id => notification.disconnect(id));
        this._notes.delete(notification);
    }

    _remove(notification) {
        this._forget(notification);
        const before = this.list.length;
        this.list = this.list.filter(e => e.notification !== notification);
        if (this.list.length !== before)
            this._onChange(false);
    }

    get critical() {
        return this.list.some(e => e.notification.urgency === MessageTray.Urgency.CRITICAL);
    }

    // Opens what it points to (the app, the chat) and takes it off the island.
    open(entry) {
        const {notification} = entry;
        this._drop(entry);
        try {
            notification.activate();
        } catch (e) {
            console.warn(`isla-dock: isla superior: ${e.message}`);
        }
    }

    // Closes it for good.
    dismiss(entry) {
        const {notification} = entry;
        this._drop(entry);
        notification.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
    }

    // Seen: off the island, but still in GNOME's list (and IslaDock's center).
    clear() {
        if (!this.list.length)
            return;
        this.list = [];
        this._onChange(false);
    }

    _drop(entry) {
        this.list = this.list.filter(e => e !== entry);
        this._onChange(false);
    }

    destroy() {
        this._trayIds.forEach(id => Main.messageTray.disconnect(id));
        this._trayIds = [];
        for (const source of [...this._sources.keys()])
            this._unwatch(source);
        for (const notification of [...this._notes.keys()])
            this._forget(notification);
        this.list = [];
    }
}
