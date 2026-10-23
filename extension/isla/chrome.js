// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// GNOME 50 is Wayland only: it dropped the input region and now rejects the
// 'affectsInputRegion' parameter of addChrome / trackChrome.
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

const NO_INPUT_REGION = parseInt(Config.PACKAGE_VERSION) >= 50;

export function chromeParams(params) {
    if (!NO_INPUT_REGION)
        return params;
    const {affectsInputRegion: _unused, ...rest} = params;
    return rest;
}
