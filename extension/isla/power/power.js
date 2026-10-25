// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Ajustes (it was called Energía): the round button at the end of the dock opens a small floating
// panel above the dock, aligned to the button's right edge. Four looks to choose from in
// Preferences ('panel-style'), all with the same pieces and the same functions:
//   agrupada  square toggles; Captura, Ajustes and the session actions together in a capsule
//   tarjetas  toggles as tiles with their names (3 per row); actions with a caption under each
//   finas     tiles with name and state; sliders with their percentage in a soft card; a short
//             bottom row whose Apagar opens Suspender · Reiniciar · Cerrar sesión · Apagar
//   lineas    no backgrounds: bare icons, an accent dot under what is on
// The toggles: red · bluetooth · modo de energía · luz nocturna · estilo oscuro · modo activo; then
// volume (and the sound output: speakers, headphones, HDMI…) and the microphone, while there is one.
// With a battery, a line on top says its charge, state and time left. Icons: Tabler (MIT, icons/).
// It wears the island's own solid color and edge (Aurora's halo too, skin.floatingLook), with
// light pieces over a light island. Reiniciar, outside Tarjetas finas, is in GNOME's Apagar dialog.
// Esc, a click outside, the button again or an action close it. The system
// actions go through GNOME's SystemActions (its own confirmation dialogs).
//
// Commands it listens to: 'power-toggle' (anchor actor), 'power-suspend'.
// Commands it sends: 'panel-open' ('power', open).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {showScreenshotUI} from 'resource:///org/gnome/shell/ui/screenshot.js';

import {addPanelChrome, dropChrome} from '../chrome.js';
import {dressFrame, islandLook} from '../look.js';
import {dockWorkArea, insideDock} from '../monitor.js';
import {createToggles, openSettings} from './services.js';
import {acquireBattery, describe, releaseBattery} from './battery.js';
import {Mode} from '../state.js';
import {ms} from '../timing.js';
import {_, N_, fmt} from '../i18n.js';

const GAP = 9;            // between the island and the panel
const IN_TIME = 180;
const OUT_TIME = 120;
const SHIFT = 8;
const RADIUS = 20;          // .isla-quick-panel

// The toggles, in createToggles' order: short name, Tabler icon (on, off) and the state words of
// Tarjetas finas (the power mode says its own: Ahorro de energía, Equilibrado, Rendimiento).
const TOGGLES = [
    {name: N_('Red'), icon: ['network', 'network'], states: [N_('Conectada'), N_('Desconectada')]},
    {name: N_('Bluetooth'), icon: ['bluetooth', 'bluetooth-off'], states: [N_('Encendido'), N_('Apagado')]},
    {name: N_('Energía'), icon: ['gauge', 'gauge'], states: null},
    {name: N_('Nocturna'), icon: ['sun-low', 'sun-low'], states: [N_('Activa'), N_('Apagada')]},
    {name: N_('Oscuro'), icon: ['moon', 'moon'], states: [N_('Activo'), N_('Apagado')]},
    {name: N_('Modo activo'), icon: ['coffee', 'coffee'], states: [N_('Activo'), N_('Apagado')]},
];

// id: [Tabler icon, tooltip, caption (Tarjetas con nombre), action, SystemActions property that hides it]
const ACTIONS = {
    captura: ['screenshot', N_('Captura de pantalla'), N_('Captura'), () => showScreenshotUI(), null],
    ajustes: ['settings', N_('Configuración'), N_('Ajustes'), () => openSettings(), null],
    bloquear: ['lock', N_('Bloquear'), N_('Bloquear'), a => a.activateLockScreen(), 'can-lock-screen'],
    salir: ['logout', N_('Cerrar sesión'), N_('Salir'), a => a.activateLogout(), 'can-logout'],
    suspender: ['zzz', N_('Suspender'), N_('Suspender'), a => a.activateSuspend(), 'can-suspend'],
    reiniciar: ['refresh', N_('Reiniciar'), N_('Reiniciar'), a => a.activateRestart(), 'can-restart'],
    apagar: ['power', N_('Apagar'), N_('Apagar'), a => a.activatePowerOff(), 'can-power-off'],
};

export const PANEL_STYLES = ['agrupada', 'tarjetas', 'finas', 'lineas'];

export class Power {
    constructor({state, settings, capsule, dir}) {
        this._state = state;
        this._settings = settings;
        this._dir = dir;
        this._capsule = capsule;
        this._actions = SystemActions.getDefault();
        this._toggles = createToggles(dir, settings);
        this._panel = null;
        this._ids = [
            // The dock narrows when the hover zoom ends: the open panel keeps within its edges.
            [capsule, capsule.connect('notify::width', () => this._panel && this._place())],
            [state, state.connect('command', (_s, name, ...args) => {
                if (name === 'power-toggle')
                    this.toggle(args[0]);
                else if (name === 'power-suspend')
                    this._suspend();
            })],
            [state, state.connect('skin-changed', () => this.close(false))],
            [state, state.connect('mode-changed', (_s, mode) => mode !== Mode.EXPANDED && this.close())],
            [Main.overview, Main.overview.connect('showing', () => this.close(false))],
            // Another look chosen while it is open: built again at once.
            [settings, settings.connect('changed::panel-style', () => {
                const anchor = this._anchor;
                if (!this._panel)
                    return;
                this.close(false);
                this.open(anchor);
            })],
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
            // The focus open() gives the first button comes before the panel has a place:
            // no tooltip then (its position would be NaN).
            if (!button.has_allocation())
                return;
            this._tooltip._owner = button;
            this._tooltip.text = button._tip;
            this._tooltip.show();
            const [bx, by] = button.get_transformed_position();
            const [bw] = button.get_transformed_size();
            const [, tw] = this._tooltip.get_preferred_width(-1);
            const [, th] = this._tooltip.get_preferred_height(-1);
            const area = dockWorkArea();
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

    // Icon and "85 % · Cargando · 1 h 20 min para llenarse"; hidden with no battery.
    _batteryRow() {
        const row = new St.BoxLayout({style_class: 'isla-pd-bateria'});
        const icon = new St.Icon({style_class: 'isla-pd-bateria-icono', y_align: Clutter.ActorAlign.CENTER});
        const label = new St.Label({style_class: 'isla-pd-bateria-texto', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(icon);
        row.add_child(label);
        const battery = acquireBattery();
        const sync = () => {
            const info = battery.info;
            row.visible = !!info;
            if (!info)
                return;
            icon.icon_name = info.iconName;
            icon.fallback_icon_name = info.fallback;
            label.text = describe(info);
            if (info.low)
                row.add_style_class_name('baja');
            else
                row.remove_style_class_name('baja');
        };
        const id = battery.connect('changed', sync);
        sync();
        this._unwatch.push(() => {
            battery.disconnect(id);
            releaseBattery();
        });
        return row;
    }

    // Every sound output GNOME knows (its ids count up from 1), the one in use marked.
    _outputDevices(control) {
        const devices = [];
        for (let id = 1, misses = 0; misses < 20 && id < 400; id++) {
            const device = control.lookup_output_id(id);
            if (!device) {
                misses++;
                continue;
            }
            misses = 0;
            if (device.port_available !== false)
                devices.push(device);
        }
        return devices;
    }

    _activeOutput(control) {
        const sink = control.get_default_sink();
        return sink ? control.lookup_device_from_stream(sink) : null;
    }

    _syncOutputButton(control, button) {
        const active = this._activeOutput(control);
        button.child.gicon = active?.get_gicon() ?? null;
        button.child.fallback_icon_name = 'audio-speakers-symbolic';
        button._tip = active ? fmt(_('Salida: {nombre}'), {nombre: active.description}) : _('Salida de sonido');
        button.visible = this._outputDevices(control).length > 1;
    }

    _fillOutputs(box, control, button) {
        box.destroy_all_children();
        const active = this._activeOutput(control);
        for (const device of this._outputDevices(control)) {
            const name = device.origin ? `${device.description} – ${device.origin}` : device.description;
            const row = new St.Button({style_class: 'isla-pd-salida', can_focus: true, reactive: true, track_hover: true,
                x_expand: true, accessible_name: name});
            const content = new St.BoxLayout({style_class: 'isla-pd-salida-caja'});
            content.add_child(new St.Icon({style_class: 'isla-pd-volumen-icono', gicon: device.get_gicon(),
                fallback_icon_name: 'audio-speakers-symbolic', y_align: Clutter.ActorAlign.CENTER}));
            const label = new St.Label({text: name, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            content.add_child(label);
            if (active && device.get_id() === active.get_id()) {
                row.add_style_pseudo_class('checked');
                content.add_child(new St.Icon({style_class: 'isla-pd-volumen-icono', icon_name: 'object-select-symbolic',
                    y_align: Clutter.ActorAlign.CENTER}));
            }
            row.set_child(content);
            row.connect('clicked', () => {
                control.change_output(device);
                box.visible = false;
                this._place();
            });
            box.add_child(row);
        }
    }

    // ---------- pieces shared by the four styles ----------
    _gicon(name) {
        return new Gio.FileIcon({file: this._dir.get_child('icons').get_child(`isla-${name}-symbolic.svg`)});
    }

    _icon(name, cls = 'isla-q-icono') {
        return new St.Icon({style_class: cls, gicon: this._gicon(name)});
    }

    // Each row spread evenly across the panel: equal cells, the button centered in its own.
    _spread(children, cls = 'isla-q-fila') {
        const row = new St.BoxLayout({style_class: cls, x_expand: true});
        row.layout_manager.homogeneous = true;
        for (const child of children) {
            child.x_align = Clutter.ActorAlign.CENTER;
            const cell = new St.Bin({x_expand: true, child});
            // A hidden button hides its cell too, so the others close the gap.
            child.bind_property('visible', cell, 'visible', GObject.BindingFlags.SYNC_CREATE);
            row.add_child(cell);
        }
        return row;
    }

    // A grid of tiles, `columns` per row, every tile as wide as the others.
    _grid(tiles, columns) {
        const grid = new St.BoxLayout({style_class: 'isla-q-rejilla', orientation: Clutter.Orientation.VERTICAL});
        for (let i = 0; i < tiles.length; i += columns) {
            const row = new St.BoxLayout({style_class: 'isla-q-rejilla-fila'});
            row.layout_manager.homogeneous = true;
            for (const tile of tiles.slice(i, i + columns)) {
                tile.x_expand = true;
                row.add_child(tile);
            }
            grid.add_child(row);
        }
        return grid;
    }

    // One of the six toggles, dressed for the style: a square, a tile with its name,
    // a tile with name and state, or a bare icon with a dot.
    _toggle(toggle, meta, style) {
        const tile = style === 'tarjetas' || style === 'finas';
        const button = new St.Button({style_class: tile ? 'isla-q-tile' : 'isla-q-toggle', can_focus: true, track_hover: true,
            reactive: true, button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE});
        const icon = this._icon(meta.icon[0]);
        let state = null, dot = null;
        if (style === 'tarjetas') {
            const box = new St.BoxLayout({style_class: 'isla-q-tile-caja', x_expand: true});
            box.add_child(icon);
            box.add_child(new St.Label({style_class: 'isla-q-tile-nombre', text: _(meta.name), y_align: Clutter.ActorAlign.CENTER}));
            button.set_child(box);
        } else if (style === 'finas') {
            // Filling the tile, everything against its left edge.
            const box = new St.BoxLayout({style_class: 'isla-q-tile-caja', orientation: Clutter.Orientation.VERTICAL,
                x_expand: true});
            icon.x_align = Clutter.ActorAlign.START;
            box.add_child(icon);
            box.add_child(new St.Label({style_class: 'isla-q-tile-nombre', text: _(meta.name), x_align: Clutter.ActorAlign.START}));
            state = new St.Label({style_class: 'isla-q-tile-estado', x_align: Clutter.ActorAlign.START});
            box.add_child(state);
            button.set_child(box);
        } else if (style === 'lineas') {
            const box = new St.BoxLayout({style_class: 'isla-q-toggle-caja', orientation: Clutter.Orientation.VERTICAL});
            box.add_child(icon);
            // Always there, so nothing jumps when it lights up.
            dot = new St.Widget({style_class: 'isla-q-punto', x_align: Clutter.ActorAlign.CENTER});
            box.add_child(dot);
            button.set_child(box);
        } else {
            button.set_child(icon);
        }
        button.connect('clicked', (_b, mouse) => {
            if (mouse !== 3) {
                toggle.click();
            } else if (toggle.settings) {
                this.close();
                toggle.settings();
            }
        });
        const refreshTip = this._tooltipFor(button, toggle.title);
        const sync = () => {
            button.visible = toggle.visible;
            const on = toggle.on;
            if (on)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
            icon.gicon = this._gicon(meta.icon[on ? 0 : 1]);
            if (state)
                state.text = meta.states ? _(meta.states[on ? 0 : 1]) : toggle.state ?? '';
            button._tip = toggle.title;
            button.accessible_name = toggle.title;
            if (this._tooltip?._owner === button)
                refreshTip();
        };
        sync();
        this._unwatch.push(toggle.connect(sync));
        return button;
    }

    // A system action (captura, ajustes, bloquear…); hidden when GNOME says it can't be done.
    _action(id, cls) {
        const [iconName, tip, , action, can] = ACTIONS[id];
        const button = new St.Button({style_class: `${cls} ${id === 'apagar' ? 'power' : ''}`.trim(), can_focus: true,
            track_hover: true, reactive: true, accessible_name: _(tip), child: this._icon(iconName)});
        button.connect('clicked', () => {
            this.close(false);
            action(this._actions);
        });
        this._tooltipFor(button, _(tip));
        this._watchCan(button, can);
        return button;
    }

    _watchCan(actor, can) {
        if (!can)
            return;
        const sync = () => (actor.visible = this._actions[can.replace(/-(\w)/g, (_m, c) => c.toUpperCase())]);
        const id = this._actions.connect(`notify::${can}`, sync);
        this._unwatch.push(() => this._actions.disconnect(id));
        sync();
    }

    // Volume (with the sound output button) or microphone: mute button, slider and, if asked, its percentage.
    _levelRow(kind, percent) {
        const mic = kind === 'mic';
        const row = new St.BoxLayout({style_class: 'isla-q-nivel'});
        const control = Volume.getMixerControl();
        const icon = this._icon(mic ? 'microphone' : 'volume', 'isla-q-nivel-icono');
        const mute = new St.Button({style_class: 'isla-q-nivel-boton', can_focus: true, reactive: true, track_hover: true,
            child: icon, accessible_name: mic ? _('Silenciar el micrófono') : _('Silenciar'), y_align: Clutter.ActorAlign.CENTER});
        this._tooltipFor(mute, mic ? _('Silenciar el micrófono') : _('Silenciar'));
        const slider = new Slider(0);
        slider.add_style_class_name('isla-q-slider');
        slider.x_expand = true;
        slider.y_align = Clutter.ActorAlign.CENTER;
        slider.accessible_name = mic ? _('Micrófono') : _('Volumen');
        row.add_child(mute);
        row.add_child(slider);
        const value = percent ? new St.Label({style_class: 'isla-q-valor', y_align: Clutter.ActorAlign.CENTER}) : null;
        if (value)
            row.add_child(value);
        if (!mic) {
            // The outputs, in a list that opens inside the panel (never a popup over it).
            const outputs = new St.BoxLayout({style_class: 'isla-pd-salidas', orientation: Clutter.Orientation.VERTICAL,
                visible: false});
            const outputButton = new St.Button({style_class: 'isla-q-salida', can_focus: true, reactive: true,
                track_hover: true, accessible_name: _('Salida de sonido'), y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({style_class: 'isla-q-nivel-icono', icon_name: 'audio-speakers-symbolic'})});
            outputButton.connect('clicked', () => {
                outputs.visible = !outputs.visible;
                if (outputs.visible)
                    this._fillOutputs(outputs, control, outputButton);
                this._place();
            });
            row.add_child(outputButton);
            this._tooltipFor(outputButton, _('Salida de sonido'));
            row._outputs = outputs;
            const id = control.connect('default-sink-changed', () => {
                this._syncOutputButton(control, outputButton);
                if (outputs.visible)
                    this._fillOutputs(outputs, control, outputButton);
            });
            this._syncOutputButton(control, outputButton);
            this._unwatch.push(() => control.disconnect(id));
        }

        let stream = null, streamIds = [], syncing = false;
        const max = () => control.get_vol_max_norm();
        const showValue = () => value && (value.text = `${Math.round(slider.value * 100)} %`);
        const sync = () => {
            row.visible = !!stream;
            if (!stream)
                return;
            const level = mic ? stream.volume / max() : stream.is_muted ? 0 : stream.volume / max();
            syncing = true;
            slider.value = Math.min(1, level);
            syncing = false;
            showValue();
            const off = stream.is_muted || (!mic && level <= 0);
            icon.gicon = this._gicon(`${mic ? 'microphone' : 'volume'}${off ? '-off' : ''}`);
            if (mic && stream.is_muted)
                mute.add_style_pseudo_class('checked');
            else
                mute.remove_style_pseudo_class('checked');
        };
        const follow = () => {
            streamIds.forEach(id => stream?.disconnect(id));
            stream = mic ? control.get_default_source() : control.get_default_sink();
            streamIds = stream ? [stream.connect('notify::volume', sync), stream.connect('notify::is-muted', sync)] : [];
            sync();
        };
        slider.connect('notify::value', () => {
            showValue();
            if (syncing || !stream)
                return;
            const volume = slider.value * max();
            stream.volume = volume;
            if (!mic) {
                const off = volume < 1;
                if (off !== stream.is_muted)
                    stream.change_is_muted(off);
            }
            stream.push_volume();
        });
        mute.connect('clicked', () => stream?.change_is_muted(!stream.is_muted));
        const id = control.connect(mic ? 'default-source-changed' : 'default-sink-changed', follow);
        follow();
        this._unwatch.push(() => {
            control.disconnect(id);
            streamIds.forEach(sid => stream?.disconnect(sid));
        });
        return row;
    }

    _separator() {
        return new St.Widget({style_class: 'isla-q-separador'});
    }

    // Volume, its outputs and the microphone, one under the other (in a soft card for Tarjetas finas).
    _levels(box, percent) {
        const volume = this._levelRow('volume', percent);
        box.add_child(volume);
        box.add_child(volume._outputs);
        box.add_child(this._levelRow('mic', percent));
    }

    // ---------- the four styles ----------
    _build() {
        this._unwatch = [];
        const style = PANEL_STYLES.includes(this._settings.get_string('panel-style'))
            ? this._settings.get_string('panel-style') : 'agrupada';
        this._style = style;
        const panel = new St.BoxLayout({style_class: `isla-pd-panel isla-quick-panel panel-${style}`,
            orientation: Clutter.Orientation.VERTICAL, reactive: true});
        panel.add_child(this._batteryRow());
        const toggles = this._toggles.map((t, i) => this._toggle(t, TOGGLES[i], style));
        ({agrupada: this._buildAgrupada, tarjetas: this._buildTarjetas, finas: this._buildFinas,
            lineas: this._buildLineas})[style].call(this, panel, toggles);
        return panel;
    }

    // Square toggles in a row; Captura and Ajustes, then the session actions together in a capsule.
    _buildAgrupada(panel, toggles) {
        panel.add_child(this._spread(toggles));
        this._levels(panel, false);
        panel.add_child(this._separator());
        const bottom = new St.BoxLayout({style_class: 'isla-q-fila'});
        bottom.add_child(this._action('captura', 'isla-q-herramienta'));
        bottom.add_child(this._action('ajustes', 'isla-q-herramienta'));
        const session = this._spread(['bloquear', 'salir', 'suspender', 'apagar'].map(id => this._action(id, 'isla-q-sesion')),
            'isla-q-sesion-grupo');
        bottom.add_child(session);
        panel.add_child(bottom);
        this._step = toggles.length;
    }

    // Tiles with their names, three per row; the actions with a caption under each.
    _buildTarjetas(panel, toggles) {
        panel.add_child(this._grid(toggles, 3));
        this._levels(panel, false);
        panel.add_child(this._separator());
        const columns = ['captura', 'ajustes', 'bloquear', 'salir', 'suspender', 'apagar'].map(id => {
            const column = new St.BoxLayout({style_class: 'isla-q-columna', orientation: Clutter.Orientation.VERTICAL});
            const button = this._action(id, 'isla-q-herramienta');
            button.x_align = Clutter.ActorAlign.CENTER;
            column.add_child(button);
            column.add_child(new St.Label({style_class: 'isla-q-pie', text: _(ACTIONS[id][2]), x_align: Clutter.ActorAlign.CENTER}));
            button.bind_property('visible', column, 'visible', GObject.BindingFlags.SYNC_CREATE);
            return column;
        });
        panel.add_child(this._spread(columns));
        this._step = 3;
    }

    // Tiles with name and state; the sliders in a soft card with their percentage; a short bottom row
    // whose Apagar opens, inside the panel, Suspender · Reiniciar · Cerrar sesión · Apagar.
    _buildFinas(panel, toggles) {
        panel.add_child(this._grid(toggles, 3));
        const card = new St.BoxLayout({style_class: 'isla-q-tarjeta-niveles', orientation: Clutter.Orientation.VERTICAL});
        this._levels(card, true);
        panel.add_child(card);
        const bottom = new St.BoxLayout({style_class: 'isla-q-fila'});
        bottom.add_child(this._action('captura', 'isla-q-herramienta'));
        bottom.add_child(this._action('ajustes', 'isla-q-herramienta'));
        bottom.add_child(new St.Widget({x_expand: true}));
        bottom.add_child(this._action('bloquear', 'isla-q-herramienta'));
        const menu = new St.BoxLayout({style_class: 'isla-q-menu-apagar', orientation: Clutter.Orientation.VERTICAL,
            visible: false});
        for (const id of ['suspender', 'reiniciar', 'salir', 'apagar']) {
            const [iconName, tip, , action, can] = ACTIONS[id];
            const item = new St.Button({style_class: `isla-q-menu-item ${id === 'apagar' ? 'power' : ''}`.trim(),
                can_focus: true, track_hover: true, reactive: true, x_expand: true, accessible_name: _(tip)});
            const box = new St.BoxLayout({style_class: 'isla-q-menu-caja', x_expand: true});
            box.add_child(this._icon(iconName));
            box.add_child(new St.Label({text: _(tip), y_align: Clutter.ActorAlign.CENTER}));
            item.set_child(box);
            item.connect('clicked', () => {
                this.close(false);
                action(this._actions);
            });
            this._watchCan(item, can);
            menu.add_child(item);
        }
        const power = new St.Button({style_class: 'isla-q-herramienta power', can_focus: true, track_hover: true,
            reactive: true, accessible_name: _('Apagar…'), child: this._icon('power')});
        power.connect('clicked', () => {
            menu.visible = !menu.visible;
            if (menu.visible)
                power.add_style_pseudo_class('checked');
            else
                power.remove_style_pseudo_class('checked');
            this._place();
        });
        this._tooltipFor(power, _('Suspender, reiniciar, cerrar sesión o apagar'));
        bottom.add_child(power);
        panel.add_child(bottom);
        panel.add_child(menu);
        this._step = 3;
    }

    // No backgrounds: bare icons, an accent dot under what is on, thin lines between the parts.
    _buildLineas(panel, toggles) {
        panel.add_child(this._spread(toggles));
        panel.add_child(this._separator());
        this._levels(panel, false);
        panel.add_child(this._separator());
        panel.add_child(this._spread(['captura', 'ajustes', 'bloquear', 'salir', 'suspender', 'apagar']
            .map(id => this._action(id, 'isla-q-herramienta'))));
        this._step = toggles.length;
    }

    // ---------- open / close ----------
    open(anchor) {
        if (this._panel || this._state.mode !== Mode.EXPANDED)
            return;
        const content = this._build();
        // A frame holds the blurred wallpaper (when the island has it) under the panel.
        const panel = this._panel = new St.Widget({layout_manager: new Clutter.BinLayout(), reactive: true});
        this._state.command('panel-open', 'power', true);
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
        addPanelChrome(panel);
        Main.layoutManager.addTopChrome(this._tooltip);
        this._place();
        panel.connect('notify::width', () => this._panel === panel && this._place());
        panel.connect('captured-event', (_a, event) => this._onEvent(event));
        panel.connect('key-press-event', (_a, event) => this._onKey(event));
        this._grab = Main.pushModal(panel, {actionMode: Shell.ActionMode.POPUP});
        this._focusFirst();
        panel.set({opacity: 0, translation_y: SHIFT});
        panel.ease({opacity: 255, translation_y: 0, duration: ms(IN_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._state.hold('power');
        this._state.command('hide-tooltip');
    }

    // Right edge with the button's (never past the dock's), 9 px above the island, inside the work area.
    _place() {
        const panel = this._panel;
        const [ax] = this._anchor.get_transformed_position();
        const [aw] = this._anchor.get_transformed_size();
        const [, cy] = this._capsule?.get_transformed_position() ?? this._anchor.get_transformed_position();
        const [, w] = panel.get_preferred_width(-1);
        const [, h] = panel.get_preferred_height(w);
        const area = dockWorkArea();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let x = insideDock(ax + aw - w, w, this._capsule);
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
        // The Ajustes button itself: closes (its click would open it again).
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
            step = symbol === Clutter.KEY_Down ? this._step ?? 6 : -(this._step ?? 6);
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
        const done = () => dropChrome(panel);
        if (animate) {
            panel.ease({opacity: 0, translation_y: SHIFT, duration: ms(OUT_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: done});
        } else {
            done();
        }
        this._state.command('panel-open', 'power', false);
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
