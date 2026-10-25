// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// GNOME 50 is Wayland only: it dropped the input region and now rejects the
// 'affectsInputRegion' parameter of addChrome / trackChrome.
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const NO_INPUT_REGION = parseInt(Config.PACKAGE_VERSION) >= 50;

export function chromeParams(params) {
    if (!NO_INPUT_REGION)
        return params;
    const {affectsInputRegion: _unused, ...rest} = params;
    return rest;
}

// A floating panel over everything that leaves with a closing animation (dropChrome at its end).
export function addPanelChrome(actor) {
    Main.layoutManager.addTopChrome(actor);
    actor.connect('destroy', () => (actor._islaGone = true));
}

// destroy() also takes it off the screen and out of the layout manager. On logout the shell tears
// the stage down in the middle of the animation, which then ends here with the panel already gone:
// taking it off once more made Clutter abort ("Bail out! … destroy_all_children").
export function dropChrome(actor) {
    if (!actor._islaGone)
        actor.destroy();
}
