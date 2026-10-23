// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Screen recording. With the top bar hidden, GNOME's own red indicator is gone,
// so the island shows it: folded, a pulsing red dot and the time; open, a red
// capsule with the time and a stop button. GNOME saves the video as usual.
// Checked against GNOME Shell 48 (js/ui/screenshot.js): Main.screenshotUI has
// the 'screencast-in-progress' property and stopScreencast().
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {pillSizes, pillStyle, roundButton} from './pill.js';
import {Priority} from './state.js';

function elapsed(seconds) {
    const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
    const two = n => String(n).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

export class Recording {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._ui = Main.screenshotUI;
        this._start = 0;
        this._tickId = 0;
        this._buildActors();
        this._ids = [
            [this._ui, this._ui.connect('notify::screencast-in-progress', () => this._sync())],
            [settings, settings.connect('changed::tamano-base', () => {
                this._applySize();
                state.command('resize');
            })],
            [state, state.connect('compact-changed', (_s, compact) => (this._time.visible = !compact))],
        ];
        this._time.visible = !state.compact;
        this._applySize();
        this._sync();
    }

    _buildActors() {
        this._mini = new St.BoxLayout({style_class: 'isla-grabacion-mini', y_align: Clutter.ActorAlign.CENTER});
        this._miniDot = new St.Widget({style_class: 'isla-grabacion-punto', y_align: Clutter.ActorAlign.CENTER});
        this._miniTime = new St.Label({style_class: 'isla-grabacion-hora', y_align: Clutter.ActorAlign.CENTER});
        this._mini.add_child(this._miniDot);
        this._mini.add_child(this._miniTime);

        this._panel = new St.BoxLayout({style_class: 'isla-grabacion', y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Grabando la pantalla'});
        this._dot = new St.Widget({style_class: 'isla-grabacion-punto blanco', y_align: Clutter.ActorAlign.CENTER});
        this._time = new St.Label({style_class: 'isla-grabacion-tiempo', y_align: Clutter.ActorAlign.CENTER});
        const stop = this._stop = new St.Button({style_class: 'isla-grabacion-stop', can_focus: false, y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Detener grabación',
            child: new St.Widget({style_class: 'isla-grabacion-cuadro', x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER})});
        stop.connect('clicked', () => this._ui.stopScreencast());
        for (const actor of [this._dot, this._time, stop])
            this._panel.add_child(actor);
    }

    // As tall as the icons ('tamano-base').
    _applySize() {
        const z = pillSizes(this._settings);
        this._panel.style = pillStyle(z, {left: 14});
        const dot = z.px(9);
        this._dot.style = `width: ${dot}px; height: ${dot}px; border-radius: ${Math.ceil(dot / 2)}px;`;
        this._time.style = `font-size: ${z.font(14)}px;`;
        roundButton(this._stop, z, 28);
        const square = z.px(10);
        this._stop.child.style = `width: ${square}px; height: ${square}px;`;
    }

    _sync() {
        if (this._ui.screencast_in_progress) {
            if (this._tickId)
                return;
            this._start = GLib.get_monotonic_time();
            this._paint();
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._paint();
                return GLib.SOURCE_CONTINUE;
            });
            for (const dot of [this._miniDot, this._dot]) {
                dot.opacity = 255;
                dot.ease({opacity: 70, duration: 600, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    repeatCount: -1, autoReverse: true});
            }
            this._state.setActivity('recording', {priority: Priority.RECORDING, mini: this._mini, panel: this._panel});
        } else {
            this._stopTicking();
            this._state.removeActivity('recording');
        }
    }

    _paint() {
        const text = elapsed(Math.floor((GLib.get_monotonic_time() - this._start) / 1e6));
        this._miniTime.text = text;
        this._time.text = text;
    }

    _stopTicking() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        for (const dot of [this._miniDot, this._dot]) {
            dot.remove_all_transitions();
            dot.opacity = 255;
        }
    }

    destroy() {
        this._stopTicking();
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
        this._state.removeActivity('recording');
        this._mini.destroy();
        this._panel.destroy();
        this._ui = null;
    }
}
