// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The symbols of the three accent buttons, drawn with cairo on a 24 px grid. Plain
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
};
