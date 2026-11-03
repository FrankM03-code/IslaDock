// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// No "“App” is ready" notice for apps opened from IslaDock. On X11 GNOME may
// refuse the focus to a window that maps late (Extension Manager does), and
// shows that notice instead. An app opened from the dock, the bar or the
// launcher a few seconds ago is what the user wants in front: its window is
// raised instead. Any other window still gets GNOME's notice.
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const GRACE_US = 15 * GLib.USEC_PER_SEC;
const recent = new Map();

// Called right where IslaDock opens an app.
export function markLaunched(app) {
    const id = app?.get_id();
    if (id)
        recent.set(id, GLib.get_monotonic_time() + GRACE_US);
}

export class ReadyNotice {
    constructor() {
        this._handler = Main.windowAttentionHandler;
        if (!this._handler)
            return;
        // GNOME's handler is a bound function: take its place and pass on what is not ours.
        global.display.disconnectObject(this._handler);
        global.display.connectObject(
            'window-demands-attention', (display, window) => this._onAttention(display, window),
            'window-marked-urgent', (display, window) => this._onAttention(display, window),
            this);
    }

    _onAttention(display, window) {
        const app = window && Shell.WindowTracker.get_default().get_window_app(window);
        const until = app ? recent.get(app.get_id()) : 0;
        if (until && GLib.get_monotonic_time() < until && !window.is_skip_taskbar()) {
            Main.activateWindow(window);
            return;
        }
        this._handler._onWindowDemandsAttention(display, window);
    }

    destroy() {
        global.display.disconnectObject(this);
        recent.clear();
        const handler = this._handler;
        if (!handler)
            return;
        this._handler = null;
        global.display.connectObject(
            'window-demands-attention', handler._onWindowDemandsAttention.bind(handler),
            'window-marked-urgent', handler._onWindowDemandsAttention.bind(handler),
            handler);
    }
}
