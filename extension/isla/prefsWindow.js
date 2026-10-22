// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// IslaDock's Preferences window, centered. Opened from Extension Manager on
// X11 it becomes a child of that app's window and Mutter places it on the left
// edge (partly off screen): it is moved to the middle of its monitor once shown.
import Meta from 'gi://Meta';

const PREFS_CLASS = 'org.gnome.Shell.Extensions';

export class PrefsWindow {
    constructor({title}) {
        this._title = title;
        this._windows = new Map();   // window -> signal id
        this._id = global.display.connect('window-created', (_d, w) => this._watch(w));
    }

    _watch(w) {
        if (w.get_wm_class() !== PREFS_CLASS || this._windows.has(w))
            return;
        // The title arrives with the first frame: check it then.
        const id = w.connect('shown', () => {
            w.disconnect(id);
            this._windows.delete(w);
            if (w.get_title() === this._title)
                this._center(w);
        });
        this._windows.set(w, id);
    }

    _center(w) {
        const area = w.get_work_area_current_monitor();
        const f = w.get_frame_rect();
        const x = area.x + Math.round((area.width - f.width) / 2);
        const y = area.y + Math.max(0, Math.round((area.height - f.height) / 2));
        if (w.get_maximized() !== Meta.MaximizeFlags.BOTH)
            w.move_frame(true, x, y);
    }

    destroy() {
        global.display.disconnect(this._id);
        for (const [w, id] of this._windows)
            w.disconnect(id);
        this._windows.clear();
    }
}
