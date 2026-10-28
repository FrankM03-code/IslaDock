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
        this._id = global.display.connect('window-created', (_d, w) => this._watch(w));
    }

    _watch(w) {
        if (w.get_wm_class() !== PREFS_CLASS || this._windows.has(w))
            return;
        // On X11, opened as a child of Extension Manager, Mutter may place it again after it shows
        // (top left corner): centered when it shows and again a moment later.
        const ids = [];
        const done = () => {
            ids.forEach(([obj, id]) => obj.disconnect(id));
            this._windows.delete(w);
        };
        const center = () => {
            done();
            if (w.get_title() !== this._title)
                return;
            this._center(w);
            this._later(w, 150);
            this._later(w, 400);
        };
        ids.push([w, w.connect('shown', center)]);
        ids.push([w, w.connect('unmanaged', done)]);
        this._windows.set(w, ids);
    }

    _later(w, delay) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeouts.delete(id);
            if (w.get_compositor_private())
                this._center(w);
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    _center(w) {
        const area = w.get_work_area_current_monitor();
        const f = w.get_frame_rect();
        const x = area.x + Math.round((area.width - f.width) / 2);
        const y = area.y + Math.max(0, Math.round((area.height - f.height) / 2));
        // GNOME 49 replaced get_maximized() with is_maximized().
        const maximized = w.is_maximized ? w.is_maximized() : w.get_maximized() === Meta.MaximizeFlags.BOTH;
        if (!maximized)
            w.move_frame(true, x, y);
    }

    destroy() {
        global.display.disconnect(this._id);
        for (const ids of this._windows.values())
            ids.forEach(([obj, id]) => obj.disconnect(id));
        this._windows.clear();
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
    }
}
