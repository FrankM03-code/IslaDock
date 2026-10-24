// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// GNOME's accent color (Settings → Appearance → Style): every accent detail of
// IslaDock (the dock's buttons, the Ajustes panel, the clocks, the calendar)
// takes it. The stylesheet uses -st-accent-color and follows by itself; this is
// for what is drawn or styled from code.
import GLib from 'gi://GLib';
import St from 'gi://St';

// [r, g, b], 0-255.
export function accentRGB() {
    const [color] = St.ThemeContext.get_for_stage(global.stage).get_accent_color();
    return [color.red, color.green, color.blue];
}

// fn() once the new accent is in place; returns the function that stops it.
export function watchAccent(fn) {
    const settings = St.Settings.get();
    let idle = 0;
    const id = settings.connect('notify::accent-color', () => {
        if (idle)
            return;
        idle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            idle = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    });
    return () => {
        settings.disconnect(id);
        if (idle)
            GLib.source_remove(idle);
        idle = 0;
    };
}
