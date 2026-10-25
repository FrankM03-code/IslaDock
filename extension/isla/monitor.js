// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The monitor the dock lives on ('monitor-isla': -1 = the primary one, or a
// monitor's number). One place to ask, so the island, its blur, its panels
// and popups all agree. A monitor that is gone means the primary one.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

let settings = null;

export function setDockSettings(s) {
    settings = s;
}

export function dockMonitorIndex() {
    const wanted = settings?.get_int('monitor-isla') ?? -1;
    const monitors = Main.layoutManager.monitors;
    return wanted >= 0 && wanted < monitors.length ? wanted : Main.layoutManager.primaryIndex;
}

export function dockMonitor() {
    return Main.layoutManager.monitors[dockMonitorIndex()] ?? Main.layoutManager.primaryMonitor;
}

export function dockWorkArea() {
    return Main.layoutManager.getWorkAreaForMonitor(dockMonitorIndex());
}

// x of a panel `w` wide kept within the open dock's edges (as the Ajustes panel sits), when the
// dock is at least as wide; a wider panel is centered on the dock instead.
export function insideDock(x, w, capsule) {
    if (!capsule?.get_stage())
        return x;
    const [cx] = capsule.get_transformed_position();
    const [cw] = capsule.get_transformed_size();
    if (w > cw)
        return cx + cw / 2 - w / 2;
    return Math.min(Math.max(x, cx), cx + cw - w);
}
