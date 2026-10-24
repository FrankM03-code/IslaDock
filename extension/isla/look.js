// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The island's look, for the pieces that float apart from it (the Ajustes and
// Portapapeles panels, the floating notifications) so everything reads as one
// set: its background color with one light transparency for every panel
// (PANEL_ALPHA), its edge, its shadow and whether it is light. No wallpaper blur
// behind them: over a window it showed the wallpaper and stained the corners.
// The calendar and the Downloads/Carpetas stack wear the same.
import Clutter from 'gi://Clutter';
import St from 'gi://St';


import {BlurLayer} from './blur.js';
import {dockMonitorIndex} from './monitor.js';

export const PANEL_ALPHA = 0.86;

const css = (c, alpha = c.alpha / 255) => `rgba(${c.red}, ${c.green}, ${c.blue}, ${alpha.toFixed(3)})`;

// -> {light, style (CSS for the widget), blur (a skin's blur look, or null),
//     layers(radius) (the skin's own pieces: Aurora's halo) or null}
export function islandLook(state) {
    const look = baseLook(state);
    const extra = state.skin?.floatingLook?.();
    if (extra?.style)
        look.style = extra.style;
    look.layers = extra?.layers ?? null;
    return look;
}

function baseLook(state) {
    const skin = state.skin;
    const isla = skin?.isla;
    const style = skin?.getStackStyle?.();
    const bg = isla?._bg;
    // A skin whose background stays clear: use its panel colors.
    const clear = !bg?.get_stage() || bg.get_theme_node().get_background_color().alpha < 10;
    if (clear) {
        return {light: false, blur: null,
            style: style ? `background-color: ${style.panelFill}; border-color: ${style.panelBorder};` : ''};
    }
    const node = bg.get_theme_node();
    const fill = node.get_background_color();
    const edge = node.get_border_color(St.Side.TOP);
    const light = 0.299 * fill.red + 0.587 * fill.green + 0.114 * fill.blue >= 128;
    let rule = `background-color: ${css(fill, PANEL_ALPHA)};`;
    if (edge.alpha)
        rule += ` border-color: ${css(edge)};`;
    if (style)
        rule += ` box-shadow: 0 6px 20px ${style.shadow};`;
    return {light, style: rule, blur: null};
}

// Fills a frame (St.Widget with a BinLayout): the blur, the skin's layers
// (bound to the content, `_around` px bigger on each side) and the content on top.
export function dressFrame(look, frame, content, radius) {
    const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    if (look.blur) {
        const blur = new BlurLayer(dockMonitorIndex());
        frame.add_child(blur);
        if (!blur.configure(true, radius, 'all', sf, look.blur))
            blur.destroy();
    }
    for (const layer of look.layers?.(radius) ?? []) {
        const m = layer._around ?? 0;
        layer.add_constraint(new Clutter.BindConstraint({source: content, coordinate: Clutter.BindCoordinate.POSITION, offset: -m}));
        layer.add_constraint(new Clutter.BindConstraint({source: content, coordinate: Clutter.BindCoordinate.SIZE, offset: 2 * m}));
        frame.add_child(layer);
    }
    frame.add_child(content);
}
