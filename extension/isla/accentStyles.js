// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The looks of the three accent buttons ('accent-style'), on a 40 px button. Plain
// data, shared by the dock (dockButtons.js) and the style cards in Preferences:
//  · cristal: a circle of translucent accent glass with a thin edge;
//  · marcador: a rounded glass square with a short accent bar on its outer edge;
//  · hoja: a leaf, three round corners and a nearly square one, low and towards
//    the outer end of the dock.
// Hoja comes in a light and a dark palette ('accent-palette': auto follows GNOME's
// light/dark style); the other two follow the island. The color is GNOME's
// accent (Settings → Appearance), passed in by whoever draws.
// The button families (families.js) are styles too, drawn whole with cairo.
import {FAMILIES} from './families.js';

export const ACCENT_STYLES = ['cristal', 'marcador', 'hoja', ...FAMILIES];
export const DEFAULT_ACCENT = 'marcador';

// IslaDock's own coral, for when GNOME's accent is not known.
export const CORAL_RGB = [255, 138, 76];

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
// t of the way from c to w.
const mix = (c, w, t) => c.map((v, i) => Math.round(v + (w[i] - v) * t));
const css = (c, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${+a.toFixed(3)})`;
const luminance = c => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;

// The shades of an accent [r, g, b] (0-255; GNOME's, Settings → Appearance):
// main, light and lighter (the symbol over a dark island, at rest and on hover),
// deep (over a light one), and the text over it (dark over a pale accent).
export function shades(accent = CORAL_RGB) {
    return {main: css(accent), light: css(mix(accent, WHITE, 0.15)), lighter: css(mix(accent, WHITE, 0.28)),
        deep: css(mix(accent, BLACK, 0.10)), on: luminance(accent) > 0.55 ? css(mix(accent, BLACK, 0.83)) : '#FFFFFF',
        tint: (t, a = 1) => css(mix(WHITE, accent, t), a), alpha: a => css(accent, a),
        lightAlpha: a => css(mix(accent, WHITE, 0.25), a)};
}

// level: 0 rest, 1 hover, 2 pressed or open. light: over a light island.
// dark: Hoja's dark palette. accent: [r, g, b] (IslaDock's coral if left out).
// -> {shape ('circle' | 'square' | 'leaf'), fill, border, borderBottom, ink, marker (its color or null),
//     badge: [background, text]}
export function accentLook(style, level, light, dark, accent = CORAL_RGB) {
    const hover = level === 1;
    const a = shades(accent);
    switch (style) {
    case 'cristal':
        return {shape: 'circle', fill: a.alpha([0.16, 0.28, 0.38][level]),
            border: hover ? a.lightAlpha(0.70) : a.lightAlpha(0.45),
            // Over a light island the pale accent needs a deeper symbol to read.
            ink: light ? a.deep : hover ? a.lighter : a.light, badge: [a.main, a.on]};
    case 'hoja':
        // Dark: a soft edge only (a lighter top edge looked like a white rim).
        if (dark) {
            return {shape: 'leaf', fill: ['#2C3346', '#353D54', '#252B3C'][level], border: 'rgba(255, 255, 255, 0.06)',
                ink: hover ? a.lighter : a.light, badge: [a.main, a.on]};
        }
        return {shape: 'leaf', fill: [a.tint(0), a.tint(0.05), a.tint(0.10)][level], border: hover ? a.tint(0.35) : '#DFE2EA',
            borderBottom: hover ? null : '#CFD3DE', ink: a.deep, badge: [a.deep, '#FFFFFF']};
    default: {   // marcador
        const glass = [0.08, 0.14, 0.20][level];
        return {shape: 'square', fill: light ? `rgba(28, 29, 32, ${(glass * 0.75).toFixed(3)})` : `rgba(255, 255, 255, ${glass})`,
            border: light ? 'rgba(28, 29, 32, 0.14)' : 'rgba(255, 255, 255, 0.12)',
            ink: light ? '#1C1D20' : '#F2F2F5', marker: a.main, badge: [a.main, a.on]};
    }
    }
}

// '#RRGGBB' or 'rgba(r, g, b, a)' -> [r, g, b, a], each 0..1 (for cairo).
export function rgba(color) {
    if (color.startsWith('#'))
        return [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).concat(1);
    const [r, g, b, a = 1] = color.match(/[\d.]+/g).map(Number);
    return [r / 255, g / 255, b / 255, a];
}
