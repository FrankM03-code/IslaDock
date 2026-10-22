// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The island's look, for the pieces that float apart from it (the Energía
// panel, the floating notifications) so everything reads as one set: its
// background as painted (color × its opacity, which carries
// 'isla-transparencia'), its edge, its shadow, whether it is light, and the
// blur behind it when the island has one.
import St from 'gi://St';

const css = (c, alpha = c.alpha / 255) => `rgba(${c.red}, ${c.green}, ${c.blue}, ${alpha.toFixed(3)})`;

// -> {light, style (CSS for the widget), blur (a skin's blur look, or null)}
export function islandLook(state) {
    const skin = state.skin;
    const isla = skin?.isla;
    const style = skin?.getStackStyle?.();
    const bg = isla?._bg;
    // Vidrio oscuro paints its glass with a lens, its background stays clear: use the skin's panel colors.
    const clear = !bg?.get_stage() || bg.get_theme_node().get_background_color().alpha < 10;
    if (clear) {
        return {light: false, blur: null,
            style: style ? `background-color: ${style.panelFill}; border-color: ${style.panelBorder};` : ''};
    }
    const node = bg.get_theme_node();
    const fill = node.get_background_color();
    const edge = node.get_border_color(St.Side.TOP);
    const opacity = (isla._bgOpacity ?? 255) / 255;
    const light = 0.299 * fill.red + 0.587 * fill.green + 0.114 * fill.blue >= 128;
    let rule = `background-color: ${css(fill, fill.alpha / 255 * opacity)};`;
    if (edge.alpha)
        rule += ` border-color: ${css(edge)};`;
    if (style)
        rule += ` box-shadow: 0 6px 20px ${style.shadow};`;
    const blurred = !!isla._blur?.visible && !!isla._blurOk;
    return {light, style: rule, blur: blurred ? skin.blur : null};
}
