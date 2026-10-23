// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The panels of the open island (recording, timer, music) are capsules as tall
// as the row of icons. Their sizes are designed for 40 px icons ('tamano-base'
// default) and grow or shrink with it; text changes less so it stays readable.
const DESIGN = 40;

export function pillSizes(settings) {
    const f = settings.get_int('tamano-base') / DESIGN;
    const t = Math.min(1.4, Math.max(0.85, f));
    return {
        px: n => Math.round(n * f),
        font: n => Math.round(n * t),
    };
}

// The capsule itself: height, rounded ends, inner padding and spacing.
export function pillStyle(z, {left = 6, right = 6, spacing = 8} = {}) {
    const h = z.px(40);
    return `height: ${h}px; border-radius: ${Math.round(h / 2)}px; padding: 0 ${z.px(right)}px 0 ${z.px(left)}px; spacing: ${z.px(spacing)}px;`;
}

// A round button of `size` px with its icon.
export function roundButton(button, z, size = 32, icon = 16) {
    const b = z.px(size);
    button.style = `width: ${b}px; height: ${b}px; border-radius: ${Math.round(b / 2)}px;`;
    if (button.child?.set_icon_size)
        button.child.icon_size = z.px(icon);
}
