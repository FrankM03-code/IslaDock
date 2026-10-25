// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The button families of 'accent-style': Burbuja, Galleta cuadrada, Bento, Pétalos
// and Mosaico draw the launcher, Portapapeles and Ajustes as one family, shape
// and symbol together, with cairo on a 46 px canvas, in GNOME's accent color,
// light or dark ('accent-palette'). Plain functions, shared by the dock
// (dockButtons.js) and the style cards in Preferences.
// t (0 at rest, 1 open) is each button's gesture while its panel or the app grid
// is open: the launcher's tiles turn a quarter and fill in while its shape sways,
// the clipboard's pages trade places, the dial's knob goes round, the switches flip.
import Cairo from 'cairo';

import {bellPath, clapperPath, moonPath} from './symbols.js';

export const FAMILIES = ['burbuja', 'galleta-cuadrada', 'bento', 'petalos', 'mosaico'];

const C = 23;
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const DOCK = {dark: [0x1c, 0x22, 0x33], light: [0xf5, 0xf6, 0xf9]};
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
// t of a, the rest of b.
export const mix = (a, b, t) => a.map((v, i) => v * t + b[i] * (1 - t));

// The colors of one palette, [r, g, b] 0-255.
function tokens(accent, dark) {
    const dock = dark ? DOCK.dark : DOCK.light;
    return {
        ac: accent,
        tint: dark ? mix(accent, dock, 0.20) : mix(accent, WHITE, 0.14),
        tintBorder: dark ? mix(accent, dock, 0.50) : mix(accent, WHITE, 0.38),
        glyph: hex(dark ? '#e9eaf0' : '#2a3043'),
        acGlyph: dark ? mix(accent, WHITE, 0.80) : mix(accent, BLACK, 0.85),
        glow: dark ? 0.55 : 0.35,
    };
}

// The families on a solid accent (the badge goes white on them).
export const SOLID = ['burbuja', 'galleta-cuadrada', 'petalos'];

const source = (cr, c, a = 1) => cr.setSourceRGBA(c[0] / 255, c[1] / 255, c[2] / 255, a);

function roundRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function fillRect(cr, c, a, x, y, w, h, r) {
    roundRect(cr, x, y, w, h, r);
    source(cr, c, a);
    cr.fill();
}

// A shape around the center, r(angle), 240 points (worked out once per key).
const cache = new Map();
function radial(cr, key, r) {
    let pts = key && cache.get(key);
    if (!pts) {
        pts = [];
        for (let i = 0; i < 240; i++) {
            const a = i / 240 * 2 * Math.PI;
            pts.push([C + r(a) * Math.cos(a), C + r(a) * Math.sin(a)]);
        }
        if (key)
            cache.set(key, pts);
    }
    cr.newPath();
    pts.forEach(([x, y], i) => (i ? cr.lineTo(x, y) : cr.moveTo(x, y)));
    cr.closePath();
}

// ---------- symbols, on a 24 px grid ----------
// The launcher: four tiles; open, they turn a quarter and the faint ones fill in.
function mosaic(cr, c, t) {
    cr.translate(12, 12);
    cr.rotate(t * Math.PI / 2);
    cr.translate(-12, -12);
    const faint = 0.55 + 0.45 * Math.min(1, t);
    for (const [x, y, r, a] of [[3, 3, 2.5, 1], [13, 3, 4, faint], [3, 13, 4, faint], [13, 13, 2.5, 1]])
        fillRect(cr, c, a, x, y, 8, 8, r);
}

// Two pages; open, the one behind comes forward.
function stack(cr, c, t) {
    const k = Math.min(1, Math.max(0, t));
    fillRect(cr, c, 0.55 + 0.45 * k, 8.5, 3, 12.5, 12.5, 3.5);
    fillRect(cr, c, 1 - 0.45 * k, 3 - 1.5 * t, 8.5 + 1.5 * t, 12.5, 12.5, 3.5);
}

// A ring with a knob; open, the knob goes half way round.
function dial(cr, c, t) {
    cr.arc(12, 12, 8, 0, 2 * Math.PI);
    cr.setLineWidth(2.4);
    source(cr, c, 0.55);
    cr.stroke();
    const a = -Math.PI / 4 + t * Math.PI;
    cr.arc(12 + 8 * Math.cos(a), 12 + 8 * Math.sin(a), 3, 0, 2 * Math.PI);
    source(cr, c);
    cr.fill();
    cr.arc(12, 12, 2, 0, 2 * Math.PI);
    cr.fill();
}

// The launcher in Bento: a tall accent piece and two; open, the small ones swap.
function bento(cr, g, a, t) {
    fillRect(cr, a, 1, 3, 3, 8, 18, 3);
    fillRect(cr, g, 1, 13, 3 + 10 * t, 8, 8, 3);
    fillRect(cr, g, 0.6, 13, 13 - 10 * t, 8, 8, 4);
}

// Portapapeles in Bento: an accent piece and three lines; open, the last one grows.
function bentoClip(cr, g, a, t) {
    fillRect(cr, a, 1, 3, 3, 8, 18, 3);
    fillRect(cr, g, 1, 13, 4, 8, 4, 2);
    fillRect(cr, g, 0.6, 13, 10, 8, 4, 2);
    fillRect(cr, g, 0.35 + 0.25 * Math.min(1, t), 13, 16, 5 + 3 * t, 4, 2);
}

// Ajustes in Bento: a switch off and one on; open, they flip.
function bentoToggle(cr, g, a, t) {
    const k = Math.min(1, Math.max(0, t));
    fillRect(cr, mix(a, g, k), 0.3 + 0.7 * k, 3, 4, 18, 7, 3.5);
    cr.arc(6.8 + 10.4 * t, 7.5, 2.4, 0, 2 * Math.PI);
    source(cr, k > 0.5 ? WHITE : g);
    cr.fill();
    fillRect(cr, mix(g, a, k), 1 - 0.7 * k, 3, 13, 18, 7, 3.5);
    cr.arc(17.2 - 10.4 * t, 16.5, 2.4, 0, 2 * Math.PI);
    source(cr, k > 0.5 ? g : WHITE);
    cr.fill();
}

// Four quarter petals; open, they turn a quarter.
function petals(cr, t) {
    cr.translate(12, 12);
    cr.rotate(t * Math.PI / 2);
    cr.translate(-12, -12);
    for (const [x, y, a0, a1, a] of [[11, 11, Math.PI, 1.5 * Math.PI, 1], [13, 11, 1.5 * Math.PI, 2 * Math.PI, 0.7],
        [11, 13, Math.PI / 2, Math.PI, 0.7], [13, 13, 0, Math.PI / 2, 1]]) {
        cr.newPath();
        cr.moveTo(x, y);
        cr.arc(x, y, 8, a0, a1);
        cr.closePath();
        source(cr, WHITE, a);
        cr.fill();
    }
}

// A petal: square at (x, y) towards one corner, rounded (6) on the other two.
function petal(cr, x, y, flip) {
    cr.newPath();
    if (!flip) {   // M9 3h6a6 6 0 0 1 6 6v6h-6a6 6 0 0 1-6-6z
        cr.moveTo(x, y);
        cr.lineTo(x + 6, y);
        cr.arc(x + 6, y + 6, 6, -Math.PI / 2, 0);
        cr.lineTo(x + 12, y + 12);
        cr.lineTo(x + 6, y + 12);
        cr.arc(x + 6, y + 6, 6, Math.PI / 2, Math.PI);
    } else {       // M3 15a6 6 0 0 1 6-6h6v6a6 6 0 0 1-6 6H3z
        cr.moveTo(x, y + 6);
        cr.arc(x + 6, y + 6, 6, Math.PI, 1.5 * Math.PI);
        cr.lineTo(x + 12, y);
        cr.lineTo(x + 12, y + 6);
        cr.arc(x + 6, y + 6, 6, 0, Math.PI / 2);
        cr.lineTo(x, y + 12);
    }
    cr.closePath();
}

// Portapapeles in Pétalos: two petals; open, the one behind slides in front.
function petalClip(cr, t) {
    const k = Math.min(1, Math.max(0, t));
    petal(cr, 9 - 1.5 * t, 3 + 1.5 * t, false);
    source(cr, WHITE, 0.6 + 0.4 * k);
    cr.fill();
    petal(cr, 3, 9, true);
    source(cr, WHITE, 1 - 0.4 * k);
    cr.fill();
}

// Ajustes in Pétalos: a ring and a petal wedge that turns.
function petalDial(cr, t) {
    cr.arc(12, 12, 8.5, 0, 2 * Math.PI);
    cr.setLineWidth(2.2);
    source(cr, WHITE, 0.6);
    cr.stroke();
    cr.save();
    cr.translate(12, 12);
    cr.rotate(t * Math.PI);
    cr.newPath();
    cr.moveTo(0, 0);
    cr.lineTo(6, 0);
    cr.arcNegative(0, 0, 6, 0, -Math.PI / 2);
    cr.closePath();
    cr.restore();
    source(cr, WHITE);
    cr.fill();
    cr.arc(12, 12, 1.6, 0, 2 * Math.PI);
    cr.fill();
}

// The symbol at `size` px of the 46 canvas, centered.
function inBox(cr, size, draw) {
    cr.save();
    const o = (46 - size) / 2;
    cr.translate(o, o);
    cr.scale(size / 24, size / 24);
    draw();
    cr.restore();
}

// ---------- shapes ----------
function bubble(cr, phase, t) {
    // Open, the bubble sways (its waves shift), drawn fresh each frame.
    const ph = phase + 0.9 * t;
    radial(cr, t ? null : `b${phase}`, a => 18.5 + 1.8 * Math.cos(3 * a + ph) + 1.1 * Math.sin(2 * a + ph * 0.7));
}

function squareCookie(cr, t) {
    cr.save();
    cr.translate(C, C);
    cr.rotate(t * Math.PI / 4);
    cr.translate(-C, -C);
    radial(cr, 'galleta', a => 19 + 2.2 * Math.cos(4 * (a + Math.PI / 4)));
    cr.restore();
}

const PHASE = {apps: 0.6, clipboard: 2.3, power: 4.1, notifications: 3.2};

// Notifications in every family: a solid bell (its clapper swings while open), or the moon.
function bell(cr, c, t, quiet) {
    source(cr, c);
    if (quiet) {
        moonPath(cr);
        cr.fill();
        return;
    }
    bellPath(cr);
    cr.fill();
    cr.save();
    cr.translate(2 * Math.sin(t * Math.PI), 0);
    clapperPath(cr);
    cr.fill();
    cr.restore();
}

// Draws `kind` ('apps', 'clipboard', 'power' or 'notifications') of `family` on a 46 px
// canvas (the caller scales). level: 0 rest, 1 hover or open (the main fill a little
// lighter, or darker on the light palette). t: the gesture. accent: [r, g, b] 0-255.
// quiet: the notifications button in do not disturb (the moon).
export function drawFamily(cr, family, kind, level, t, dark, accent, quiet = false) {
    const p = tokens(accent, dark);
    const lit = c => (level ? dark ? mix(c, WHITE, 0.92) : mix(c, BLACK, 0.96) : c);
    const big = kind === 'apps' ? 20 : 27;
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineCap(Cairo.LineCap.ROUND);
    switch (family) {
    case 'burbuja':
    case 'galleta-cuadrada':
        if (family === 'burbuja')
            bubble(cr, PHASE[kind], t);
        else
            squareCookie(cr, t);
        source(cr, lit(p.ac));
        cr.fill();
        if (kind === 'notifications')
            inBox(cr, 24, () => bell(cr, WHITE, t, quiet));
        else
            inBox(cr, big, () => (kind === 'apps' ? mosaic : kind === 'clipboard' ? stack : dial)(cr, WHITE, t));
        break;
    case 'bento':
    case 'mosaico':
        cr.newPath();
        roundRect(cr, 2.5, 2.5, 41, 41, 14);
        source(cr, lit(p.tint));
        cr.fillPreserve();
        source(cr, p.tintBorder);
        cr.setLineWidth(1);
        cr.stroke();
        if (kind === 'notifications') {
            inBox(cr, 24, () => bell(cr, family === 'bento' ? p.glyph : p.acGlyph, t, quiet));
        } else if (family === 'bento') {
            inBox(cr, kind === 'apps' ? 20 : 25, () =>
                (kind === 'apps' ? bento : kind === 'clipboard' ? bentoClip : bentoToggle)(cr, p.glyph, p.ac, t));
        } else {
            inBox(cr, big, () => (kind === 'apps' ? mosaic : kind === 'clipboard' ? stack : dial)(cr, p.acGlyph, t));
        }
        break;
    case 'petalos': {
        // The glow breathes out a little while open.
        const [r, g, b] = p.ac.map(v => v / 255);
        const glow = new Cairo.RadialGradient(C, C, 0, C, C, 23);
        const strength = p.glow * (1 + 0.35 * Math.min(1, t));
        glow.addColorStopRGBA(0, r, g, b, strength);
        glow.addColorStopRGBA(0.55, r, g, b, strength);
        glow.addColorStopRGBA(1, r, g, b, 0);
        cr.setSource(glow);
        cr.arc(C, C, 23, 0, 2 * Math.PI);
        cr.fill();
        cr.arc(C, C, 19, 0, 2 * Math.PI);
        source(cr, lit(p.ac));
        cr.fill();
        if (kind === 'notifications')
            inBox(cr, 24, () => bell(cr, WHITE, t, quiet));
        else
            inBox(cr, big, () => (kind === 'apps' ? petals : kind === 'clipboard' ? petalClip : petalDial)(cr, t));
        break;
    }
    }
}
