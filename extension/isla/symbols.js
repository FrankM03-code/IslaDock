// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The symbols of the accent buttons, drawn with cairo on a 24 px grid. Plain
// functions, shared by the dock (dockButtons.js) and the style cards in Preferences.

// A rounded rectangle path on a 24 px grid.
export function roundRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// The notification bell: its body (closed path) and the clapper below it.
export function bellPath(cr) {
    cr.newSubPath();
    cr.moveTo(18, 9);
    cr.arcNegative(12, 9, 6, 0, Math.PI);
    cr.curveTo(6, 14.5, 4.5, 16.2, 3.5, 17);
    cr.lineTo(20.5, 17);
    cr.curveTo(19.5, 16.2, 18, 14.5, 18, 9);
    cr.closePath();
}

export function clapperPath(cr) {
    cr.newSubPath();
    cr.arc(12, 19.6, 2.1, 0, Math.PI);
    cr.closePath();
}

// Do not disturb: a crescent, circle A (12, 12, 8) less circle B (16.5, 8, 6.5).
export function moonPath(cr) {
    const [ax, ay, ar, bx, by, br] = [12, 12.5, 8, 17, 8, 6.5];
    const d = Math.hypot(bx - ax, by - ay);
    const a = (ar * ar - br * br + d * d) / (2 * d);
    const h = Math.sqrt(ar * ar - a * a);
    const [mx, my] = [ax + a * (bx - ax) / d, ay + a * (by - ay) / d];
    const p1 = [mx + h * (by - ay) / d, my - h * (bx - ax) / d];
    const p2 = [mx - h * (by - ay) / d, my + h * (bx - ax) / d];
    const angle = (cx, cy, [x, y]) => Math.atan2(y - cy, x - cx);
    cr.newSubPath();
    cr.arc(ax, ay, ar, angle(ax, ay, p2), angle(ax, ay, p1) + 2 * Math.PI);
    cr.arcNegative(bx, by, br, angle(bx, by, p1), angle(bx, by, p2));
    cr.closePath();
}

// t: 0 at rest, 1 open (it overshoots a little on the way).
export const SYMBOLS = {
    // Four dots that turn 45° into a diamond.
    apps(cr, t) {
        cr.translate(12, 12);
        cr.rotate(t * Math.PI / 4);
        for (const [x, y] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) {
            cr.arc(x, y, 3, 0, 2 * Math.PI);
            cr.fill();
        }
    },
    // A clipboard; its short line grows to match the long one.
    clipboard(cr, t) {
        roundRect(cr, 5, 4.5, 14, 16.5, 3.5);
        cr.stroke();
        roundRect(cr, 9, 2.5, 6, 4, 1.5);
        cr.fillPreserve();
        cr.stroke();
        cr.moveTo(9, 12);
        cr.lineTo(15, 12);
        cr.moveTo(9, 16);
        cr.lineTo(9 + 4 * (1 + 0.5 * t), 16);
        cr.stroke();
    },
    // Two sliders whose knobs cross (±8 px).
    power(cr, t) {
        cr.moveTo(3, 8);
        cr.lineTo(21, 8);
        cr.moveTo(3, 16);
        cr.lineTo(21, 16);
        cr.stroke();
        for (const [x, y] of [[8 + 8 * t, 8], [16 - 8 * t, 16]]) {
            cr.arc(x, y, 3, 0, 2 * Math.PI);
            cr.fillPreserve();
            cr.stroke();
        }
    },
    // Notifications: the bell, its clapper swinging a little while the panel is open.
    notifications(cr, t) {
        bellPath(cr);
        cr.stroke();
        cr.save();
        cr.translate(2 * Math.sin(t * Math.PI), 0);
        clapperPath(cr);
        cr.fill();
        cr.restore();
    },
    // Notifications in do not disturb: the moon.
    quiet(cr) {
        moonPath(cr);
        cr.stroke();
    },
};
