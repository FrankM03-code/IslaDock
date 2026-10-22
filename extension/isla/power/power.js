// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Energía: the round button at the end of the dock opens a small floating
// panel with icons only, above the dock and aligned to the button's right edge:
//   row 1  red · bluetooth · modo de energía · luz nocturna · estilo oscuro · cafeína
//          volume
//   row 2  captura · configuración · bloquear · cerrar sesión · reiniciar · apagar
// It looks like the island itself: the same background color and see-through
// amount ('isla-transparencia'), the same edge and, when the island is blurred,
// the same blurred wallpaper behind; Aurora's halo and Vidrio oscuro's lens
// too (skin.floatingLook); light buttons over a light island, the
// design's greys over a dark one.
// Esc, a click outside, the button again or an action close it. The system
// actions go through GNOME's SystemActions (its own confirmation dialogs).
//
// Commands it listens to: 'power-toggle' (anchor actor), 'power-suspend'.
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {dressFrame, islandLook} from '../look.js';
import {createToggles, openSettings} from './services.js';
import {Mode} from '../state.js';
import {ms} from '../timing.js';

const GAP = 9;            // between the island and the panel
const IN_TIME = 180;
const OUT_TIME = 120;
const SHIFT = 8;
const RADIUS = 18;

// [icon, fallback, title, extra class, action, SystemActions property that hides it]
const SYSTEM = [
    ['screenshot-ui-area-symbolic', 'camera-photo-symbolic', 'Captura de pantalla', '', a => a.activateScreenshotUI(), null],
    ['preferences-system-symbolic', 'emblem-system-symbolic', 'Configuración', '', () => openSettings(), null],
    ['system-lock-screen-symbolic', null, 'Bloquear', 'isla-pd-bloquear', a => a.activateLockScreen(), 'can-lock-screen'],
    ['system-log-out-symbolic', null, 'Cerrar sesión', 'isla-pd-salir', a => a.activateLogout(), 'can-logout'],
    ['system-reboot-symbolic', null, 'Reiniciar', 'isla-pd-reiniciar', a => a.activateRestart(), 'can-restart'],
    ['system-shutdown-symbolic', null, 'Apagar', 'isla-pd-apagar', a => a.activatePowerOff(), 'can-power-off'],
];


export class Power {
    constructor({state, settings, capsule, dir}) {
        this._state = state;
        this._capsule = capsule;
        this._actions = SystemActions.getDefault();
        this._toggles = createToggles(dir, settings);
        this._panel = null;
        this._ids = [
            [state, state.connect('command', (_s, name, ...args) => {
                if (name === 'power-toggle')
                    this.toggle(args[0]);
                else if (name === 'power-suspend')
                    this._suspend();
            })],
            [state, state.connect('skin-changed', () => this.close(false))],
            [state, state.connect('mode-changed', (_s, mode) => mode !== Mode.EXPANDED && this.close())],
            [Main.overview, Main.overview.connect('showing', () => this.close(false))],
        ];
    }

    get isOpen() {
        return !!this._panel;
    }

    toggle(anchor) {
        if (this._panel)
            this.close();
        else
            this.open(anchor);
    }

    _suspend() {
        this.close(false);
        if (this._actions.canSuspend)
            this._actions.activateSuspend();
    }

    // ---------- building ----------
    _tooltipFor(button, text) {
        button._tip = text;
        const show = () => {
            if (!this._tooltip)
                return;
            if (!(button.hover || button.has_key_focus())) {
                if (this._tooltip._owner === button)
                    this._hideTooltip();
                return;
            }
            this._tooltip._owner = button;
            this._tooltip.text = button._tip;
            this._tooltip.show();
            const [bx, by] = button.get_transformed_position();
            const [bw] = button.get_transformed_size();
            const [, tw] = this._tooltip.get_preferred_width(-1);
            const [, th] = this._tooltip.get_preferred_height(-1);
            const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            const x = Math.min(Math.max(bx + bw / 2 - tw / 2, area.x + 4), area.x + area.width - tw - 4);
            this._tooltip.set_position(Math.round(x), Math.round(by - th - 6));
        };
        button.connect('notify::hover', show);
        button.connect('key-focus-in', show);
        button.connect('key-focus-out', show);
        return show;
    }

    _hideTooltip() {
        if (this._tooltip) {
            this._tooltip.hide();
            this._tooltip._owner = null;
        }
    }

    _button(icon, fallback, title, cls, onClick, onMenu = null) {
        const button = new St.Button({style_class: `isla-pd-btn ${cls}`.trim(), can_focus: true, track_hover: true,
            reactive: true, button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE, accessible_name: title});
        const child = new St.Icon({style_class: 'isla-pd-icono', fallback_icon_name: fallback ?? 'image-missing'});
        if (typeof icon === 'string')
            child.icon_name = icon;
        else
            child.gicon = icon;
        button.set_child(child);
        button._icon = child;
        button.connect('clicked', (_b, mouse) => {
            if (mouse === 3)
                onMenu?.();
            else
                onClick();
        });
        button._refreshTip = this._tooltipFor(button, title);
        return button;
    }

    _toggleButton(toggle) {
        const button = this._button(toggle.icon, null, toggle.title, '', () => toggle.click(),
            toggle.settings ? () => {
                this.close();
                toggle.settings();
            } : null);
        const sync = () => {
            button.visible = toggle.visible;
            button._icon.gicon = toggle.icon;
            button._tip = toggle.title;
            if (toggle.on)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
            button.accessible_name = toggle.title;
            if (this._tooltip?._owner === button)
                button._refreshTip();
        };
        sync();
        this._unwatch.push(toggle.connect(sync));
        return button;
    }

    _volumeRow() {
        const row = new St.BoxLayout({style_class: 'isla-pd-volumen'});
        const control = Volume.getMixerControl();
        const icon = new St.Icon({style_class: 'isla-pd-volumen-icono', icon_name: 'audio-volume-medium-symbolic'});
        const mute = new St.Button({style_class: 'isla-pd-volumen-boton', can_focus: true, reactive: true, track_hover: true,
            child: icon, accessible_name: 'Silenciar', y_align: Clutter.ActorAlign.CENTER});
        const slider = new Slider(0);
        slider.add_style_class_name('isla-pd-slider');
        slider.x_expand = true;
        slider.y_align = Clutter.ActorAlign.CENTER;
        slider.accessible_name = 'Volumen';
        row.add_child(mute);
        row.add_child(slider);

        let stream = null, streamIds = [], syncing = false;
        const max = () => control.get_vol_max_norm();
        const sync = () => {
            row.visible = !!stream;
            if (!stream)
                return;
            const value = stream.is_muted ? 0 : stream.volume / max();
            syncing = true;
            slider.value = Math.min(1, value);
            syncing = false;
            const n = value <= 0 ? 'muted' : value < 1 / 3 ? 'low' : value < 2 / 3 ? 'medium' : 'high';
            icon.icon_name = `audio-volume-${n}-symbolic`;
        };
        const follow = () => {
            streamIds.forEach(id => stream?.disconnect(id));
            stream = control.get_default_sink();
            streamIds = stream ? [stream.connect('notify::volume', sync), stream.connect('notify::is-muted', sync)] : [];
            sync();
        };
        slider.connect('notify::value', () => {
            if (syncing || !stream)
                return;
            const volume = slider.value * max();
            const off = volume < 1;
            stream.volume = volume;
            if (off !== stream.is_muted)
                stream.change_is_muted(off);
            stream.push_volume();
        });
        mute.connect('clicked', () => stream?.change_is_muted(!stream.is_muted));
        const id = control.connect('default-sink-changed', follow);
        follow();
        this._unwatch.push(() => {
            control.disconnect(id);
            streamIds.forEach(sid => stream?.disconnect(sid));
        });
        return row;
    }

    _build() {
        this._unwatch = [];
        const panel = new St.BoxLayout({style_class: 'isla-pd-panel', orientation: Clutter.Orientation.VERTICAL,
            reactive: true});
        const row1 = new St.BoxLayout({style_class: 'isla-pd-fila'});
        for (const toggle of this._toggles)
            row1.add_child(this._toggleButton(toggle));
        const row2 = new St.BoxLayout({style_class: 'isla-pd-fila'});
        for (const [icon, fallback, title, cls, action, can] of SYSTEM) {
            const button = this._button(icon, fallback, title, cls, () => {
                this.close(false);
                action(this._actions);
            });
            if (can) {
                const sync = () => (button.visible = this._actions[can.replace(/-(\w)/g, (_m, c) => c.toUpperCase())]);
                const id = this._actions.connect(`notify::${can}`, sync);
                this._unwatch.push(() => this._actions.disconnect(id));
                sync();
            }
            row2.add_child(button);
        }
        panel.add_child(row1);
        panel.add_child(this._volumeRow());
        panel.add_child(new St.Widget({style_class: 'isla-pd-sep'}));
        panel.add_child(row2);
        return panel;
    }

    // ---------- open / close ----------
    open(anchor) {
        if (this._panel || this._state.mode !== Mode.EXPANDED)
            return;
        const content = this._build();
        // A frame holds the blurred wallpaper (when the island has it) under the panel.
        const panel = this._panel = new St.Widget({layout_manager: new Clutter.BinLayout(), reactive: true});
        this._anchor = anchor;
        this._tooltip = new St.Label({style_class: 'isla-pd-tooltip', visible: false});
        const look = islandLook(this._state);
        if (look.light) {
            content.add_style_class_name('clara');
            this._tooltip.add_style_class_name('clara');
        }
        if (look.style)
            content.style = look.style;
        dressFrame(look, panel, content, RADIUS);
        Main.layoutManager.addTopChrome(panel);
        Main.layoutManager.addTopChrome(this._tooltip);
        this._place();
        panel.connect('captured-event', (_a, event) => this._onEvent(event));
        panel.connect('key-press-event', (_a, event) => this._onKey(event));
        this._grab = Main.pushModal(panel, {actionMode: Shell.ActionMode.POPUP});
        this._focusFirst();
        panel.set({opacity: 0, translation_y: SHIFT});
        panel.ease({opacity: 255, translation_y: 0, duration: ms(IN_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._state.hold('power');
        this._state.command('hide-tooltip');
    }

    // Right edge with the button's, 9 px above the island, inside the work area.
    _place() {
        const panel = this._panel;
        const [ax] = this._anchor.get_transformed_position();
        const [aw] = this._anchor.get_transformed_size();
        const [, cy] = this._capsule?.get_transformed_position() ?? this._anchor.get_transformed_position();
        const [, w] = panel.get_preferred_width(-1);
        const [, h] = panel.get_preferred_height(w);
        const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let x = ax + aw - w;
        x = Math.min(Math.max(x, area.x + 4 * sf), area.x + area.width - w - 4 * sf);
        const y = Math.max(cy - GAP * sf - h, area.y + 4 * sf);
        panel.set_position(Math.round(x), Math.round(y));
    }

    _buttons() {
        const list = [];
        const walk = actor => {
            for (const child of actor.get_children()) {
                if (!child.visible)
                    continue;
                if (child.can_focus)
                    list.push(child);
                else
                    walk(child);
            }
        };
        walk(this._panel);
        return list;
    }

    _focusFirst() {
        this._buttons()[0]?.grab_key_focus();
    }

    _onEvent(event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        const target = global.stage.get_event_actor(event);
        if (this._panel.contains(target))
            return Clutter.EVENT_PROPAGATE;
        // The Energía button itself: closes (its click would open it again).
        this.close();
        return Clutter.EVENT_STOP;
    }

    // Tab / Shift+Tab and the arrows move between the buttons; the slider keeps ← →.
    _onKey(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        const buttons = this._buttons();
        const focus = global.stage.get_key_focus();
        const i = buttons.indexOf(focus);
        const back = symbol === Clutter.KEY_ISO_Left_Tab || (symbol === Clutter.KEY_Tab && event.get_state() & Clutter.ModifierType.SHIFT_MASK);
        let step = 0;
        if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab)
            step = back ? -1 : 1;
        else if (!(focus instanceof Slider) && (symbol === Clutter.KEY_Right || symbol === Clutter.KEY_Left))
            step = symbol === Clutter.KEY_Right ? 1 : -1;
        else if (symbol === Clutter.KEY_Down || symbol === Clutter.KEY_Up)
            step = symbol === Clutter.KEY_Down ? 6 : -6;
        if (!step)
            return Clutter.EVENT_PROPAGATE;
        const n = buttons.length;
        let next = i < 0 ? 0 : i + step;
        if (Math.abs(step) === 1)
            next = (next + n) % n;
        else
            next = Math.max(0, Math.min(n - 1, next));
        buttons[next]?.grab_key_focus();
        return Clutter.EVENT_STOP;
    }

    close(animate = true) {
        const panel = this._panel;
        if (!panel)
            return;
        this._panel = null;
        this._unwatch.forEach(fn => fn());
        this._unwatch = [];
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        const tooltip = this._tooltip;
        this._tooltip = null;
        Main.layoutManager.removeChrome(tooltip);
        tooltip.destroy();
        panel.reactive = false;
        const done = () => {
            Main.layoutManager.removeChrome(panel);
            panel.destroy();
        };
        if (animate) {
            panel.ease({opacity: 0, translation_y: SHIFT, duration: ms(OUT_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: done});
        } else {
            done();
        }
        this._state.release('power');
    }

    destroy() {
        this.close(false);
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
        this._toggles.forEach(t => t.destroy?.());
        this._toggles = [];
    }
}
