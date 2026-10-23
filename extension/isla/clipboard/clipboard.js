// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Portapapeles: the clipboard button at the end of the dock (before Energía)
// opens the history panel above it, dressed like the island (the same as the
// Energía panel). Super+V (key 'atajo-portapapeles') opens it from anywhere.
// GNOME uses Super+V for the notification list ('toggle-message-tray'); while
// this module runs that binding gives it up, and gets it back when it stops
// (what was taken is kept in 'portapapeles-liberado', so it is put back even
// after a crash). The button bounces each time something is copied.
//
// Commands it listens to: 'clipboard-toggle' (anchor actor).
// Commands it sends: 'clipboard-open' (from the shortcut), 'clipboard-bounce'.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClipboardHistory} from './history.js';
import {ClipboardPanel, shortcutLabel} from './panel.js';
import {dressFrame, islandLook} from '../look.js';
import {dockWorkArea} from '../monitor.js';
import {Mode} from '../state.js';
import {ms} from '../timing.js';

const GAP = 9;
const IN_TIME = 180;
const OUT_TIME = 120;
const SHIFT = 8;
const RADIUS = 18;
const CLOSE_AFTER_COPY = 450;   // long enough to read "Copiado: …"
const KEY = 'atajo-portapapeles';
const TRAY_SCHEMA = 'org.gnome.shell.keybindings';
const TRAY_KEY = 'toggle-message-tray';

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

export class Clipboard {
    constructor({state, settings, capsule, uuid}) {
        this._state = state;
        this._settings = settings;
        this._capsule = capsule;
        this._panel = null;
        this._closeId = 0;
        this.history = new ClipboardHistory(GLib.build_filenamev([GLib.get_user_cache_dir(), uuid ?? 'isla-dock@frankm', 'clipboard']));
        this._ids = [
            [this.history, this.history.connect('captured', () => state.command('clipboard-bounce'))],
            [state, state.connect('command', (_s, name, ...args) => {
                if (name === 'clipboard-toggle')
                    this.toggle(args[0]);
            })],
            [state, state.connect('skin-changed', () => this.close(false))],
            [state, state.connect('mode-changed', (_s, mode) => mode !== Mode.EXPANDED && this.close())],
            [Main.overview, Main.overview.connect('showing', () => this.close(false))],
        ];
        this._freeShortcut();
        Main.wm.addKeybinding(KEY, settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._fromShortcut());
    }

    // ---------- Super+V ----------
    _freeShortcut() {
        try {
            this._tray = new Gio.Settings({schema_id: TRAY_SCHEMA});
        } catch {
            this._tray = null;
            return;
        }
        const ours = this._settings.get_strv(KEY);
        const current = this._tray.get_strv(TRAY_KEY);
        const taken = current.filter(a => ours.some(b => same(a, b)));
        if (!taken.length)
            return;
        const kept = this._settings.get_strv('portapapeles-liberado');
        this._settings.set_strv('portapapeles-liberado', [...new Set([...kept, ...taken])]);
        this._tray.set_strv(TRAY_KEY, current.filter(a => !taken.includes(a)));
    }

    _giveBackShortcut() {
        const taken = this._settings.get_strv('portapapeles-liberado');
        if (!this._tray || !taken.length)
            return;
        const current = this._tray.get_strv(TRAY_KEY);
        const missing = taken.filter(a => !current.some(b => same(a, b)));
        if (missing.length)
            this._tray.set_strv(TRAY_KEY, [...missing, ...current]);
        this._settings.set_strv('portapapeles-liberado', []);
    }

    _fromShortcut() {
        if (this._panel) {
            this.close();
            return;
        }
        if (Main.overview.visible)
            Main.overview.hide();
        this._state.command('clipboard-open');
    }

    // ---------- open / close ----------
    get isOpen() {
        return !!this._panel;
    }

    toggle(anchor) {
        if (this._panel)
            this.close();
        else
            this.open(anchor);
    }

    open(anchor) {
        if (this._panel || this._state.mode !== Mode.EXPANDED)
            return;
        this._tooltip = new St.Label({style_class: 'isla-pd-tooltip', visible: false});
        const content = new ClipboardPanel({
            history: this.history,
            shortcut: shortcutLabel(this._settings.get_strv(KEY)[0]),
            on: {
                copy: item => this.history.copy(item.id),
                close: () => this._closeSoon(),
                tooltip: (actor, text, hidden) => this._tooltipFor(actor, text, hidden),
            },
        });
        this._content = content;
        const frame = this._panel = new St.Widget({layout_manager: new Clutter.BinLayout(), reactive: true});
        const look = islandLook(this._state);
        if (look.light) {
            content.actor.add_style_class_name('clara');
            this._tooltip.add_style_class_name('clara');
        }
        if (look.style)
            content.actor.style = look.style;
        dressFrame(look, frame, content.actor, RADIUS);
        this._anchor = anchor;
        Main.layoutManager.addTopChrome(frame);
        Main.layoutManager.addTopChrome(this._tooltip);
        this._place();
        // The list grows and shrinks with the search and the filter: stay above the button.
        frame.connect('notify::height', () => this._place());
        frame.connect('captured-event', (_a, event) => this._onEvent(event));
        frame.connect('key-press-event', (_a, event) => this._onKey(event));
        this._grab = Main.pushModal(frame, {actionMode: Shell.ActionMode.POPUP});
        content.entry.grab_key_focus();
        frame.set({opacity: 0, translation_y: SHIFT});
        frame.ease({opacity: 255, translation_y: 0, duration: ms(IN_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._state.hold('clipboard');
        this._state.command('hide-tooltip');
    }

    // Centered over the button, 9 px above the island, inside the work area.
    _place() {
        const frame = this._panel;
        if (!frame)
            return;
        const anchor = this._anchor;
        const [ax] = anchor.get_transformed_position();
        const [aw] = anchor.get_transformed_size();
        const [, cy] = this._capsule?.get_transformed_position() ?? anchor.get_transformed_position();
        const [, w] = frame.get_preferred_width(-1);
        const [, h] = frame.get_preferred_height(w);
        const area = dockWorkArea();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let x = ax + aw / 2 - w / 2;
        x = Math.min(Math.max(x, area.x + 4 * sf), area.x + area.width - w - 4 * sf);
        const y = Math.max(cy - GAP * sf - h, area.y + 4 * sf);
        frame.set_position(Math.round(x), Math.round(y));
    }

    // The filter segments show only their icon: the name as a tooltip (not on the active one).
    _tooltipFor(button, text, hidden) {
        const show = () => {
            const tip = this._tooltip;
            if (!tip)
                return;
            if (!(button.hover || button.has_key_focus()) || hidden()) {
                if (tip._owner === button) {
                    tip.hide();
                    tip._owner = null;
                }
                return;
            }
            tip._owner = button;
            tip.text = text;
            tip.show();
            const [bx, by] = button.get_transformed_position();
            const [bw] = button.get_transformed_size();
            const [, tw] = tip.get_preferred_width(-1);
            const [, th] = tip.get_preferred_height(-1);
            tip.set_position(Math.round(bx + bw / 2 - tw / 2), Math.round(by - th - 6));
        };
        for (const signal of ['notify::hover', 'key-focus-in', 'key-focus-out', 'clicked'])
            button.connect(signal, show);
    }

    _onEvent(event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        if (this._panel.contains(global.stage.get_event_actor(event)))
            return Clutter.EVENT_PROPAGATE;
        // Outside (the clipboard button too: its click would open it again).
        this.close();
        return Clutter.EVENT_STOP;
    }

    _onKey(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        return this._content.navigate(symbol) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _closeSoon() {
        if (this._closeId)
            return;
        this._panel.reactive = false;
        this._closeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLOSE_AFTER_COPY, () => {
            this._closeId = 0;
            this.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    close(animate = true) {
        const frame = this._panel;
        if (!frame)
            return;
        this._panel = null;
        this._content = null;
        if (this._closeId)
            GLib.source_remove(this._closeId);
        this._closeId = 0;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        const tooltip = this._tooltip;
        this._tooltip = null;
        Main.layoutManager.removeChrome(tooltip);
        tooltip.destroy();
        frame.reactive = false;
        const done = () => {
            Main.layoutManager.removeChrome(frame);
            frame.destroy();
        };
        if (animate) {
            frame.ease({opacity: 0, translation_y: SHIFT, duration: ms(OUT_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: done});
        } else {
            done();
        }
        this._state.release('clipboard');
    }

    destroy() {
        this.close(false);
        Main.wm.removeKeybinding(KEY);
        this._giveBackShortcut();
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
        this.history.destroy();
        this.history = null;
    }
}
