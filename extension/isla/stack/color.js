// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// '#RRGGBB' or 'rgba(r, g, b, a)' -> [r, g, b, a] in 0..1, for cairo.
export function parseColor(text) {
    const hex = /^#([0-9a-f]{6})$/i.exec(text);
    if (hex)
        return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16) / 255).concat(1);
    const m = /^rgba?\(([^)]+)\)$/.exec(text);
    if (m) {
        const [r, g, b, a = 1] = m[1].split(',').map(Number);
        return [r / 255, g / 255, b / 255, a];
    }
    return [0, 0, 0, 1];
}

export function setSource(cr, text, alpha = 1) {
    const [r, g, b, a] = parseColor(text);
    cr.setSourceRGBA(r, g, b, a * alpha);
}
