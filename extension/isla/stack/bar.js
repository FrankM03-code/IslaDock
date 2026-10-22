// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The strip of a download in progress: a real percentage when the app
// publishes one, otherwise a segment that keeps running across it (never a
// made-up number).
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {parseColor} from './color.js';

const RUN_TIME = 1100;

export function progressBar(width, height, accent, progress) {
    const [r, g, b] = parseColor(accent).map(v => Math.round(v * 255));
    const track = new St.Widget({clip_to_allocation: true, style: `background-color: rgba(${r}, ${g}, ${b}, 0.22);`});
    track.set_size(width, height);
    const fill = new St.Widget({style: `background-color: ${accent};`});
    track.add_child(fill);
    if (progress !== null) {
        fill.set_size(Math.round(width * progress), height);
        return track;
    }
    const seg = Math.round(width * 0.35);
    fill.set_size(seg, height);
    fill.translation_x = Math.round((width - seg) / 2);
    // Clutter does not animate actors that are not on screen yet.
    const id = track.connect('notify::mapped', () => {
        if (!track.mapped || !St.Settings.get().enable_animations)
            return;
        track.disconnect(id);
        fill.translation_x = -seg;
        fill.ease({translation_x: width, duration: RUN_TIME, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            repeatCount: -1});
    });
    track.connect('destroy', () => fill.remove_all_transitions());
    return track;
}
