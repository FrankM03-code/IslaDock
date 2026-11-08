// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// IslaDock's Preferences window, centered. Opened from Extension Manager on
// X11 it becomes a child of that app's window and Mutter places it on the left
// edge or corner (partly off screen): it is moved to the middle of its monitor once shown.
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

const PREFS_CLASS = 'org.gnome.Shell.Extensions';

export class PrefsWindow {
    constructor({title}) {
        this._title = title;
        this._windows = new Map();   // window -> [[object, signal id]]
        this._timeouts = new Set();
        this._id = global.display.connect('window-created', (_display, metaWindow) => this._watch(metaWindow));
    }

    _watch(metaWindow) {
        if (metaWindow.get_wm_class() !== PREFS_CLASS || this._windows.has(metaWindow))
            return;
        // On X11, opened as a child of Extension Manager, Mutter may place it again after it shows
        // (top left corner): centered when it shows and again a moment later.
        const handlers = [];
        const done = () => {
            handlers.forEach(([object, handlerId]) => object.disconnect(handlerId));
            this._windows.delete(metaWindow);
        };
        const center = () => {
            done();
            if (metaWindow.get_title() !== this._title)
                return;
            this._center(metaWindow);
            this._later(metaWindow, 150);
            this._later(metaWindow, 400);
        };
        handlers.push([metaWindow, metaWindow.connect('shown', center)]);
        handlers.push([metaWindow, metaWindow.connect('unmanaged', done)]);
        this._windows.set(metaWindow, handlers);
    }

    _later(metaWindow, delay) {
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeouts.delete(timeoutId);
            if (metaWindow.get_compositor_private())
                this._center(metaWindow);
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(timeoutId);
    }

    _center(metaWindow) {
        const area = metaWindow.get_work_area_current_monitor();
        const frame = metaWindow.get_frame_rect();
        const left = area.x + Math.round((area.width - frame.width) / 2);
        const top = area.y + Math.max(0, Math.round((area.height - frame.height) / 2));
        // GNOME 49 replaced get_maximized() with is_maximized().
        const maximized = metaWindow.is_maximized ? metaWindow.is_maximized() : metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH;
        if (!maximized)
            metaWindow.move_frame(true, left, top);
    }

    destroy() {
        global.display.disconnect(this._id);
        for (const handlers of this._windows.values())
            handlers.forEach(([object, handlerId]) => object.disconnect(handlerId));
        this._windows.clear();
        this._timeouts.forEach(timeoutId => GLib.source_remove(timeoutId));
        this._timeouts.clear();
    }
}
