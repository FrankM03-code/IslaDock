// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// One knob for every animation of IslaDock (Preferences → "Velocidad de las
// animaciones"): durations and waits are multiplied by this factor.
let factor = 1;

export function setSpeed(value) {
    factor = Math.max(0.3, Math.min(3, value || 1));
}

// A duration in ms, slowed down or sped up.
export function ms(value) {
    return Math.round(value * factor);
}
