// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The looks of the three accent buttons ('accent-style'), on a 40 px button. Plain
// data, shared by the dock (dockButtons.js) and the style cards in Preferences:
//  · cristal: a circle of translucent orange glass with a thin edge;
//  · marcador: a rounded glass square with a short coral bar on its outer edge;
//  · hoja: a leaf, three round corners and a nearly square one, low and towards
//    the outer end of the dock.
// Hoja comes in a light and a dark palette ('accent-palette': auto follows GNOME's
// light/dark style); the other two follow the island.
export const ACCENT_STYLES = ['cristal', 'marcador', 'hoja'];
export const DEFAULT_ACCENT = 'marcador';

export const CORAL = '#FF8A4C';
const ORANGE = ['#FF9A6B', '#FFAB84'];        // the symbol, at rest and on hover

// level: 0 rest, 1 hover, 2 pressed or open. light: over a light island.
// dark: Hoja's dark palette.
// -> {shape ('circle' | 'square' | 'leaf'), fill, border, borderBottom, ink, marker, badge: [background, text]}
export function accentLook(style, level, light, dark) {
    const hover = level === 1;
    switch (style) {
    case 'cristal':
        return {shape: 'circle', fill: `rgba(255, 122, 69, ${[0.16, 0.28, 0.38][level]})`,
            border: hover ? 'rgba(255, 160, 110, 0.70)' : 'rgba(255, 140, 90, 0.45)',
            // Over a light island the pale orange needs a deeper symbol to read.
            ink: light ? '#E0662A' : ORANGE[hover ? 1 : 0], badge: [CORAL, '#2A1206']};
    case 'hoja':
        // Dark: a soft edge only (a lighter top edge looked like a white rim).
        if (dark) {
            return {shape: 'leaf', fill: ['#2C3346', '#353D54', '#252B3C'][level], border: 'rgba(255, 255, 255, 0.06)',
                ink: ORANGE[hover ? 1 : 0], badge: [CORAL, '#2A1206']};
        }
        return {shape: 'leaf', fill: ['#FFFFFF', '#FBF6F2', '#F3EBE4'][level], border: hover ? '#F0C9B3' : '#DFE2EA',
            borderBottom: hover ? null : '#CFD3DE', ink: '#E2662E', badge: ['#E8642A', '#FFFFFF']};
    default: {   // marcador
        const glass = [0.08, 0.14, 0.20][level];
        return {shape: 'square', fill: light ? `rgba(28, 29, 32, ${(glass * 0.75).toFixed(3)})` : `rgba(255, 255, 255, ${glass})`,
            border: light ? 'rgba(28, 29, 32, 0.14)' : 'rgba(255, 255, 255, 0.12)',
            ink: light ? '#1C1D20' : '#F2F2F5', marker: true, badge: [CORAL, '#2A1206']};
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
