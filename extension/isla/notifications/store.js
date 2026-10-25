// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Every notification that reaches GNOME, in IslaDock's own list: app, title,
// body, icon, time, urgency and the app's own actions, read or not. Saved in
// ~/.local/share/isla-dock/notificaciones.json, so the list outlives the
// session (the actions and the exact "open what it points to" only work while
// GNOME still has the notification; after that a click opens the app).
// Dismissed ones go to the history (the last 50). Transient notifications
// (GNOME doesn't keep them either) are not kept.
// Signals: 'changed', 'arrived' (entry: new, or updated to say something new).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const MAX_KEPT = 100;
const MAX_HISTORY = 50;
const SAVE_DELAY = 800;
const MESSAGE_APPS = /(^|;)(InstantMessaging|Chat|Email|Telephony|ContactManagement)(;|$)/;
const DOWNLOAD_TEXT = /descarg|download/i;

// What kind of notice an entry is: 'mensajes', 'descargas' or 'sistema' (the colors);
// the filters only tell messages from the rest.
function kindOf(app, title) {
    if (MESSAGE_APPS.test(app?.get_app_info()?.get_categories() ?? ''))
        return 'mensajes';
    return DOWNLOAD_TEXT.test(title ?? '') ? 'descargas' : 'sistema';
}

const appOf = source => source?.app ?? source?._app ?? null;
const iconString = gicon => {
    try {
        return gicon?.to_string() ?? null;
    } catch {
        return null;
    }
};

export class NotificationStore extends Signals.EventEmitter {
    constructor(path) {
        super();
        this._file = Gio.File.new_for_path(path);
        this._serial = 0;
        this.entries = [];        // newest first, not dismissed
        this.history = [];        // dismissed, newest first
        this._live = new Map();   // id -> notification
        this._ids = new Map();    // notification -> id
        this._notes = new Map();  // notification -> [signal ids]
        this._sources = new Map();
        this._load();
        this._trayIds = [
            Main.messageTray.connect('source-added', (_t, source) => this._watch(source)),
            Main.messageTray.connect('source-removed', (_t, source) => this._unwatch(source)),
        ];
        Main.messageTray.getSources().forEach(s => {
            this._watch(s);
            // Already there when we start (an extension restart): taken in, no popup.
            s.notifications.forEach(n => this._take(s, n, false));
        });
    }

    get unread() {
        return this.entries.filter(e => !e.read).length;
    }

    // ---------- capture ----------
    _watch(source) {
        if (this._sources.has(source))
            return;
        this._sources.set(source, source.connect('notification-added', (_s, n) => this._take(source, n, true)));
    }

    _unwatch(source) {
        const id = this._sources.get(source);
        if (id)
            source.disconnect(id);
        this._sources.delete(source);
    }

    _take(source, notification, fresh) {
        if (this._notes.has(notification) || notification.isTransient)
            return;
        const app = appOf(source);
        let entry = {
            id: `${Date.now()}-${++this._serial}`,
            appId: app?.get_id() ?? null,
            appName: app?.get_name() ?? source.title ?? '',
            title: '', body: '', icon: null, time: Date.now(), urgency: notification.urgency,
            kind: 'sistema', read: false, actions: [],
        };
        this._fill(entry, source, notification);
        // After a restart (the screen lock turns extensions off) GNOME still has the ones saved on disk:
        // the saved entry gets its notification back instead of a copy.
        const saved = fresh ? null : this.entries.find(e => !this._live.has(e.id) && e.appId === entry.appId &&
            e.title === entry.title && e.body === entry.body);
        if (saved) {
            this._fill(saved, source, notification);
            entry = saved;
        }
        this._ids.set(notification, entry.id);
        this._live.set(entry.id, notification);
        this._notes.set(notification, [
            // An update of the same notification asks again by clearing "acknowledged".
            notification.connect('notify::acknowledged', () => {
                if (!notification.acknowledged)
                    this._updated(source, notification);
            }),
            notification.connect('action-added', () => this._fill(entry, source, notification)),
            notification.connect('destroy', () => this._gone(notification)),
        ]);
        if (!saved) {
            this.entries.unshift(entry);
            this.entries.splice(MAX_KEPT);
        }
        this._changed();
        if (fresh)
            this.emit('arrived', entry, notification);
    }

    _fill(entry, source, notification) {
        const app = appOf(source);
        entry.title = (notification.title || source.title || '').trim();
        entry.body = (notification.body ?? '').trim();
        entry.icon = iconString(notification.gicon) ?? iconString(source.icon) ?? iconString(app?.get_icon());
        entry.urgency = notification.urgency;
        entry.kind = kindOf(app, entry.title);
        entry.actions = notification.actions.map(a => a.label);
        entry.time = notification.datetime?.to_unix() * 1000 || entry.time;
    }

    // The app said something new on the same notification: on top again, unread.
    _updated(source, notification) {
        const entry = this.get(this._ids.get(notification));
        if (!entry)
            return;
        this._fill(entry, source, notification);
        entry.time = Date.now();
        entry.read = false;
        this.entries = [entry, ...this.entries.filter(e => e !== entry)];
        this._changed();
        this.emit('arrived', entry, notification);
    }

    // GNOME let it go (the app withdrew it, or it was opened): our entry stays, without its actions.
    _gone(notification) {
        const id = this._ids.get(notification);
        this._notes.get(notification)?.forEach(sig => notification.disconnect(sig));
        this._notes.delete(notification);
        this._ids.delete(notification);
        this._live.delete(id);
        const entry = this.get(id);
        if (entry) {
            entry.actions = [];
            this._changed();
        }
    }

    // ---------- use ----------
    get(id) {
        return this.entries.find(e => e.id === id) ?? null;
    }

    gicon(entry) {
        try {
            return entry.icon ? Gio.Icon.new_for_string(entry.icon) : null;
        } catch {
            return null;
        }
    }

    // What the notification points to; once GNOME let it go, the app.
    activate(id) {
        const entry = this.get(id) ?? this.history.find(e => e.id === id);
        if (!entry)
            return;
        entry.read = true;
        const notification = this._live.get(id);
        if (notification) {
            notification.activate();
        } else if (entry.appId) {
            Shell.AppSystem.get_default().lookup_app(entry.appId)?.activate();
        }
        this._changed();
    }

    runAction(id, index) {
        const action = this._live.get(id)?.actions[index];
        const entry = this.get(id);
        if (entry)
            entry.read = true;
        action?.activate();
        this._changed();
    }

    markAllRead() {
        if (!this.entries.some(e => !e.read))
            return;
        this.entries.forEach(e => (e.read = true));
        this._changed();
    }

    // Out of the list (into the history), and out of GNOME.
    dismiss(id) {
        const entry = this.get(id);
        if (!entry)
            return;
        this.entries = this.entries.filter(e => e !== entry);
        entry.read = true;
        entry.actions = [];
        this.history.unshift(entry);
        this.history.splice(MAX_HISTORY);
        const notification = this._live.get(id);
        if (notification)
            notification.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
        this._changed();
    }

    dismissAll() {
        [...this.entries].forEach(e => this.dismiss(e.id));
    }

    clearHistory() {
        this.history = [];
        this._changed();
    }

    // ---------- disk ----------
    _load() {
        try {
            const [, bytes] = this._file.load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            // Saved actions belonged to notifications that are gone.
            this.entries = (data.entries ?? []).map(e => ({...e, actions: []}));
            this.history = data.history ?? [];
        } catch {
            this.entries = [];
            this.history = [];
        }
    }

    _changed() {
        this.emit('changed');
        if (!this._saveId) {
            this._saveId = GLib.timeout_add(GLib.PRIORITY_LOW, SAVE_DELAY, () => {
                this._saveId = 0;
                this._save();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _save() {
        try {
            GLib.mkdir_with_parents(this._file.get_parent().get_path(), 0o700);
            const data = JSON.stringify({entries: this.entries, history: this.history});
            this._file.replace_contents(new TextEncoder().encode(data), null, false, Gio.FileCreateFlags.PRIVATE, null);
        } catch (e) {
            console.warn(`isla-dock: no se pudieron guardar las notificaciones: ${e.message}`);
        }
    }

    destroy() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._save();
        }
        this._trayIds.forEach(id => Main.messageTray.disconnect(id));
        this._trayIds = [];
        for (const source of [...this._sources.keys()])
            this._unwatch(source);
        for (const [notification, ids] of this._notes)
            ids.forEach(id => notification.disconnect(id));
        this._notes.clear();
        this._live.clear();
        this._ids.clear();
    }
}
