// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// GNOME 49 moved St.Button to Clutter gestures: a press on a button no longer
// stops there and also reaches the island under it. Such a press belongs to
// the button (as it always did on GNOME 48).
import St from 'gi://St';

export function onButton(event, top) {
    const bit = 1 << (event.get_button() - 1);
    for (let actor = global.stage.get_event_actor(event); actor && actor !== top; actor = actor.get_parent()) {
        if (actor instanceof St.Button && actor.button_mask & bit)
            return true;
    }
    return false;
}
