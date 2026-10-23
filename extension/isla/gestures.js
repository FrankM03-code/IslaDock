// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Mouse gestures on the island (A4): wheel = system volume, Shift + wheel =
// previous/next song, middle click = pause/play, long press = do not disturb,
// drag upwards = applications view. Icons keep their own clicks.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

import {onButton} from './press.js';

const STEP = 0.05;
const LONG_PRESS = 600;
const DRAG_UP = 40;

export class Gestures {
    constructor({capsule, state, settings}) {
        this._capsule = capsule;
        this._state = state;
        this._settings = settings;
        this._smooth = 0;
        this._ids = [
            capsule.connect('scroll-event', (_a, event) => this._onScroll(event)),
            capsule.connect('button-press-event', (_a, event) => this._onPress(event)),
            capsule.connect('motion-event', (_a, event) => this._onMotion(event)),
            capsule.connect('button-release-event', (_a, event) => this._onRelease(event)),
        ];
    }

    // ---------- wheel ----------
    _onScroll(event) {
        const dir = event.get_scroll_direction();
        let step = 0;
        if (dir === Clutter.ScrollDirection.UP)
            step = 1;
        else if (dir === Clutter.ScrollDirection.DOWN)
            step = -1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            // Touchpads send many small deltas: one step per notch.
            const [, dy] = event.get_scroll_delta();
            this._smooth -= dy;
            if (Math.abs(this._smooth) < 1)
                return Clutter.EVENT_STOP;
            step = Math.sign(this._smooth);
            this._smooth = 0;
        }
        if (!step)
            return Clutter.EVENT_PROPAGATE;
        if (event.get_state() & Clutter.ModifierType.SHIFT_MASK) {
            this._state.command('media', step > 0 ? 'next' : 'previous');
            return Clutter.EVENT_STOP;
        }
        if (!this._settings.get_boolean('isla-rueda-volumen'))
            return Clutter.EVENT_PROPAGATE;
        this._changeVolume(step);
        return Clutter.EVENT_STOP;
    }

    _changeVolume(step) {
        const control = Volume.getMixerControl();
        const sink = control?.get_default_sink();
        if (!sink)
            return;
        const max = control.get_vol_max_norm();
        const volume = Math.max(0, Math.min(max, sink.volume + step * STEP * max));
        sink.volume = volume;
        sink.push_volume();
        if (sink.is_muted && volume > 0)
            sink.change_is_muted(false);
        this._state.command('volume-level', volume / max);
    }

    // ---------- presses on the island itself ----------
    _onPress(event) {
        const button = event.get_button();
        if (button !== Clutter.BUTTON_PRIMARY && button !== Clutter.BUTTON_MIDDLE)
            return Clutter.EVENT_PROPAGATE;
        if (onButton(event, this._capsule))
            return Clutter.EVENT_PROPAGATE;
        this._cancelPress();
        const [, y] = event.get_coords();
        this._press = {button, y, used: false};
        // Follow the pointer even when it leaves the island while dragging up.
        this._grab = global.stage.grab(this._capsule);
        if (button === Clutter.BUTTON_PRIMARY) {
            this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS, () => {
                this._timer = 0;
                if (this._press && !this._press.used) {
                    this._press.used = true;
                    this._state.command('toggle-dnd');
                }
                return GLib.SOURCE_REMOVE;
            });
        }
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._press || this._press.used)
            return Clutter.EVENT_PROPAGATE;
        const [, y] = event.get_coords();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        if (this._press.y - y > DRAG_UP * sf) {
            this._press.used = true;
            this._cancelPress();
            Main.overview.showApps();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onRelease(event) {
        const press = this._press;
        this._cancelPress();
        if (!press)
            return Clutter.EVENT_PROPAGATE;
        if (!press.used && press.button === Clutter.BUTTON_MIDDLE && event.get_button() === Clutter.BUTTON_MIDDLE)
            this._state.command('media', 'playpause');
        else if (!press.used && press.button === Clutter.BUTTON_PRIMARY)
            this._state.command('island-click');
        return Clutter.EVENT_STOP;
    }

    _cancelPress() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._grab?.dismiss();
        this._grab = null;
        this._press = null;
    }

    destroy() {
        this._cancelPress();
        this._ids.forEach(id => this._capsule.disconnect(id));
        this._ids = [];
    }
}
