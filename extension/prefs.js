// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Preferences. Every change is saved at once and the island applies it live.
import Adw from 'gi://Adw';
import Cairo from 'cairo';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import PangoCairo from 'gi://PangoCairo';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {USER_DOCK_ICONS, listIconThemes} from './iconThemes.js';
import {_, N_, fmt} from './isla/i18n.js';
import {ACCENT_STYLES, CORAL, accentLook, rgba} from './isla/accentStyles.js';
import {SYMBOLS} from './isla/symbols.js';

const PAYPAL_DONATION_URL = 'https://paypal.me/frankmolina29';

// Skin cards, all three in one row: [id, skin key, dark (Clásica only, null = untouched), name, about].
const SKINS = [
    ['clasica', 'clasica', false, N_('Clásica'), N_('Vidrio claro y desenfocado')],
    ['clasica-oscura', 'clasica', true, N_('Clásica oscura'), N_('El mismo vidrio, en tono oscuro')],
    ['aurora', 'aurora', null, N_('Aurora'), N_('Cápsula oscura con un halo que fluye')],
];

function roundRect(cr, x, y, w, h, r) {
    cr.newPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

const DOTS = [[0.93, 0.45, 0.20], [0.25, 0.70, 0.45], [0.30, 0.50, 0.90]];

// A drawing of the folded island in each skin, over a blue "wallpaper".
function drawPreview(key, cr, w, h) {
    const sky = new Cairo.LinearGradient(0, 0, w, h);
    sky.addColorStopRGBA(0, 0.16, 0.32, 0.50, 1);
    sky.addColorStopRGBA(1, 0.20, 0.45, 0.62, 1);
    cr.setSource(sky);
    cr.paint();
    const cw = 92, ch = 30, x = (w - cw) / 2, y = (h - ch) / 2;
    const dots = (color = null) => DOTS.forEach((c, i) => {
        cr.arc(x + 22 + i * 16, y + ch / 2, 4, 0, 2 * Math.PI);
        const [r, g, b] = color ?? c;
        cr.setSourceRGBA(r, g, b, 1);
        cr.fill();
    });
    if (key === 'aurora') {
        const halo = new Cairo.LinearGradient(x, y, x + cw, y + ch);
        [[0, 0.24, 0.90, 0.77], [0.35, 0.48, 0.36, 1], [0.7, 1, 0.44, 0.68], [1, 1, 0.76, 0.37]]
            .forEach(([p, r, g, b]) => halo.addColorStopRGBA(p, r, g, b, 0.9));
        roundRect(cr, x - 4, y - 4, cw + 8, ch + 8, ch / 2 + 4);
        cr.setSource(halo);
        cr.setLineWidth(4);
        cr.stroke();
        roundRect(cr, x, y, cw, ch, ch / 2);
        cr.setSourceRGBA(0.05, 0.05, 0.10, 0.95);
        cr.fill();
        dots();
        return;
    }
    const dark = key === 'clasica-oscura';
    roundRect(cr, x, y + 4, cw, ch, ch / 2);
    cr.setSourceRGBA(0.04, 0.03, 0.16, dark ? 0.35 : 0.25);
    cr.fill();
    roundRect(cr, x, y, cw, ch, ch / 2);
    if (dark)
        cr.setSourceRGBA(0.11, 0.12, 0.17, 0.86);
    else
        cr.setSourceRGBA(1, 1, 1, 0.62);
    cr.fillPreserve();
    cr.setSourceRGBA(1, 1, 1, dark ? 0.14 : 0.3);
    cr.setLineWidth(1);
    cr.stroke();
    dots();
}


function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// Drop-down bound to a string key: options = [[value, label], ...].
// Settings that are state, not choices: never copied.
const NOT_EXPORTED = ['temporizador-fin', 'temporizador-modo', 'banners-previos', 'portapapeles-liberado',
    'calendario-liberado', 'no-molestar', 'cafeina-activa'];

export function exportSettings(settings, metadata) {
    const values = {};
    for (const key of settings.settings_schema.list_keys()) {
        if (!NOT_EXPORTED.includes(key))
            values[key] = settings.get_value(key).print(false);
    }
    return {app: 'IslaDock', version: metadata?.['version-name'] ?? '', settings: values};
}

// Checks the whole file before touching anything; returns how many were set.
export function importSettings(settings, text) {
    const data = JSON.parse(text);
    if (data?.app !== 'IslaDock' || typeof data.settings !== 'object' || !data.settings)
        throw new Error('falta la marca de IslaDock');
    const schema = settings.settings_schema;
    const parsed = [];
    let skipped = 0;
    for (const [key, value] of Object.entries(data.settings)) {
        if (NOT_EXPORTED.includes(key) || !schema.has_key(key) || typeof value !== 'string') {
            skipped++;
            continue;
        }
        const schemaKey = schema.get_key(key);
        try {
            const variant = GLib.Variant.parse(schemaKey.get_value_type(), value, null, null);
            if (!schemaKey.range_check(variant))
                throw new Error('fuera de rango');
            parsed.push([key, variant]);
        } catch {
            skipped++;
        }
    }
    if (!parsed.length)
        throw new Error(_('no trae ninguna opción válida'));
    settings.delay();
    for (const [key, variant] of parsed)
        settings.set_value(key, variant);
    settings.apply();
    return {applied: parsed.length, skipped};
}

function comboRow(settings, key, title, options, subtitle = '') {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(options.map(([, label]) => label))});
    const sync = () => {
        row.selected = Math.max(0, options.findIndex(([value]) => value === settings.get_string(key)));
    };
    sync();
    row.connect('notify::selected', () => {
        const value = options[row.selected]?.[0];
        if (value !== undefined && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

// Accent style cards: [style, name, about].
const ACCENT_CARDS = [
    ['cristal', N_('Cristal tintado'), N_('Círculo de vidrio naranja translúcido')],
    ['marcador', N_('Marcador lateral'), N_('Vidrio neutro con una barrita naranja al lado')],
    ['hoja', N_('Hoja'), N_('Forma de hoja: tres esquinas redondas y una casi recta')],
];

// A rectangle with its own radius per corner: [top left, top right, bottom right, bottom left].
function cornerRect(cr, x, y, w, h, [tl, tr, br, bl]) {
    cr.newPath();
    cr.arc(x + w - tr, y + tr, tr, -Math.PI / 2, 0);
    cr.arc(x + w - br, y + h - br, br, 0, Math.PI / 2);
    cr.arc(x + bl, y + h - bl, bl, Math.PI / 2, Math.PI);
    cr.arc(x + tl, y + tl, tl, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function drawSymbol(cr, kind, x, y, s, ink) {
    cr.save();
    cr.translate(x, y);
    cr.scale(s / 24, s / 24);
    cr.setSourceRGBA(...rgba(ink));
    cr.setLineWidth(2);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    SYMBOLS[kind](cr, 0);
    cr.restore();
}

function fillAndEdge(cr, look) {
    cr.setSourceRGBA(...rgba(look.fill));
    cr.fillPreserve();
    cr.setLineWidth(1);
    cr.setSourceRGBA(...rgba(look.border));
    cr.stroke();
}

// The three accent buttons in one style, on a piece of island (light or dark like the user's).
function drawAccentPreview(style, cr, w, h, light, dark) {
    cr.setSourceRGBA(...(light ? [0.83, 0.87, 0.92, 1] : [0.14, 0.15, 0.20, 1]));
    cr.paint();
    const look = accentLook(style, 0, light, dark);
    const size = 34, gap = 14;
    const kinds = ['apps', 'clipboard', 'power'];
    const x0 = (w - kinds.length * size - (kinds.length - 1) * gap) / 2, y = (h - size) / 2;
    kinds.forEach((kind, i) => {
        const x = x0 + i * (size + gap);
        const k = size / 40;
        if (look.shape === 'circle')
            cornerRect(cr, x, y, size, size, [size / 2, size / 2, size / 2, size / 2]);
        else if (look.shape === 'leaf')
            cornerRect(cr, x, y, size, size, kind === 'apps' ? [20 * k, 20 * k, 20 * k, 6 * k] : [20 * k, 20 * k, 6 * k, 20 * k]);
        else
            cornerRect(cr, x, y, size, size, [13 * k, 13 * k, 13 * k, 13 * k]);
        fillAndEdge(cr, look);
        if (look.marker) {
            cr.rectangle(kind === 'apps' ? x + 1 : x + size - 4, y + size / 2 - 9, 3, 18);
            cr.setSourceRGBA(...rgba(CORAL));
            cr.fill();
        }
        // The symbol, in the same proportions as on the dock.
        const s = size * {apps: 0.46, clipboard: 0.58, power: 0.52}[kind];
        drawSymbol(cr, kind, x + (size - s) / 2, y + (size - s) / 2, s, look.ink);
    });
}

export default class IslaDockPreferences extends ExtensionPreferences {
    // ---------- skins: a card per skin with its preview ----------
    _skinsGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Piel'), description: _('Cómo se ve la isla. Se cambia al instante.')});
        const flow = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, column_spacing: 10,
            row_spacing: 10, min_children_per_line: 3, max_children_per_line: 3, margin_top: 4, margin_bottom: 4});
        let radio = null;
        const buttons = [];
        for (const [id, key, dark, name, about] of SKINS) {
            const area = new Gtk.DrawingArea({content_width: 150, content_height: 64});
            area.set_draw_func((_a, cr, w, h) => {
                drawPreview(id, cr, w, h);
                cr.$dispose();
            });
            const frame = new Gtk.Frame({child: area});
            const check = new Gtk.CheckButton({label: _(name), group: radio});
            radio ??= check;
            check.connect('toggled', () => {
                if (!check.active)
                    return;
                if (dark !== null && settings.get_boolean('isla-oscura') !== dark)
                    settings.set_boolean('isla-oscura', dark);
                if (settings.get_string('isla-piel') !== key)
                    settings.set_string('isla-piel', key);
            });
            buttons.push([key, dark, check]);
            const card = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
            card.append(frame);
            card.append(check);
            card.append(new Gtk.Label({label: _(about), xalign: 0, wrap: true, css_classes: ['dim-label', 'caption']}));
            // Clicking the picture also chooses it.
            const click = new Gtk.GestureClick();
            click.connect('released', () => (check.active = true));
            frame.add_controller(click);
            flow.append(card);
        }
        const sync = () => buttons.forEach(([key, dark, check]) => {
            if (key === settings.get_string('isla-piel') && (dark === null || dark === settings.get_boolean('isla-oscura')))
                check.active = true;
        });
        sync();
        group.add(flow);

        const ids = ['isla-piel', 'isla-oscura'].map(k => settings.connect(`changed::${k}`, sync));
        group.connect('destroy', () => ids.forEach(id => settings.disconnect(id)));
        return group;
    }

    // The accent buttons' look, folded under an arrow: unfolded, a card per style with a little
    // picture of the three buttons, and Hoja's palette.
    _accentGroup(settings) {
        const group = new Adw.PreferencesGroup();
        const expander = new Adw.ExpanderRow({title: _('Estilo de los botones')});
        group.add(expander);
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const dark = () => {
            const palette = settings.get_string('accent-palette');
            return palette === 'oscuro' || (palette === 'auto' && iface.get_string('color-scheme') === 'prefer-dark');
        };
        const current = () => ACCENT_STYLES.includes(settings.get_string('accent-style'))
            ? settings.get_string('accent-style') : 'marcador';

        const flow = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, column_spacing: 10,
            row_spacing: 10, min_children_per_line: 2, max_children_per_line: 2, margin_top: 10, margin_bottom: 10,
            margin_start: 10, margin_end: 10});
        let radio = null;
        const checks = [], areas = [];
        for (const [style, name, about] of ACCENT_CARDS) {
            const area = new Gtk.DrawingArea({content_width: 220, content_height: 64});
            area.set_draw_func((_a, cr, w, h) => {
                drawAccentPreview(style, cr, w, h, !settings.get_boolean('isla-oscura'), dark());
                cr.$dispose();
            });
            areas.push(area);
            const frame = new Gtk.Frame({child: area});
            const check = new Gtk.CheckButton({label: _(name), group: radio});
            radio ??= check;
            check.connect('toggled', () => {
                if (check.active && settings.get_string('accent-style') !== style)
                    settings.set_string('accent-style', style);
            });
            checks.push([style, check]);
            const card = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
            card.append(frame);
            card.append(check);
            card.append(new Gtk.Label({label: _(about), xalign: 0, wrap: true, css_classes: ['dim-label', 'caption']}));
            const click = new Gtk.GestureClick();
            click.connect('released', () => (check.active = true));
            frame.add_controller(click);
            flow.append(card);
        }
        expander.add_row(new Gtk.ListBoxRow({child: flow, activatable: false, selectable: false}));
        expander.add_row(comboRow(settings, 'accent-palette', _('Paleta de los botones'), [
            ['auto', _('Automática')],
            ['claro', _('Clara')],
            ['oscuro', _('Oscura')],
        ], _('Afecta al estilo Hoja')));

        // Folded, the row says which one is chosen.
        const sync = () => {
            const style = current();
            checks.find(([s]) => s === style)?.[1].set_active(true);
            expander.subtitle = _(ACCENT_CARDS.find(([s]) => s === style)[1]);
        };
        sync();
        const redraw = () => areas.forEach(a => a.queue_draw());
        const ids = [settings.connect('changed::accent-style', sync),
            // The pictures follow the island and the palette.
            ...['isla-oscura', 'accent-palette'].map(k => settings.connect(`changed::${k}`, redraw))];
        const ifaceId = iface.connect('changed::color-scheme', redraw);
        group.connect('destroy', () => {
            ids.forEach(id => settings.disconnect(id));
            iface.disconnect(ifaceId);
        });
        return group;
    }

    // The Ajustes panel's look; the subtitle tells what the chosen one is like.
    _panelStyleRow(settings) {
        const styles = [
            ['agrupada', _('Sesión agrupada'), _('Botones cuadrados; bloquear, salir, suspender y apagar juntos en una cápsula')],
            ['tarjetas', _('Tarjetas con nombre'), _('Cada botón con su nombre; las acciones con el texto debajo')],
            ['finas', _('Tarjetas finas'), _('Nombre y estado en cada botón, porcentaje del volumen y una fila de abajo más corta')],
            ['lineas', _('Solo líneas'), _('Sin fondos, solo íconos; un punto naranja bajo lo que está encendido')],
        ];
        const row = comboRow(settings, 'panel-style', _('Estilo del panel de ajustes'), styles.map(([v, label]) => [v, label]));
        const sync = () => (row.subtitle = (styles.find(([v]) => v === settings.get_string('panel-style')) ?? styles[0])[2]);
        sync();
        const id = settings.connect('changed::panel-style', sync);
        row.connect('destroy', () => settings.disconnect(id));
        return row;
    }

    // Animation speed: a slider from quick to slow.
    _speedRow(settings) {
        const row = new Adw.ActionRow({title: _('Velocidad de las animaciones'), subtitle: _('Hacia la derecha, más calmadas')});
        const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0.5, 2.5, 0.1);
        scale.set_size_request(220, -1);
        scale.valign = Gtk.Align.CENTER;
        scale.draw_value = false;
        scale.add_mark(0.5, Gtk.PositionType.BOTTOM, _('Rápida'));
        scale.add_mark(1.0, Gtk.PositionType.BOTTOM, null);
        scale.add_mark(2.5, Gtk.PositionType.BOTTOM, _('Lenta'));
        settings.bind('velocidad', scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(scale);
        return row;
    }

    // The search shortcut: press "Cambiar" and then the keys.
    _shortcutRow(window, settings) {
        const row = new Adw.ActionRow({title: _('Atajo de la búsqueda rápida'), subtitle: _('Abre la isla como buscador')});
        const label = new Gtk.ShortcutLabel({valign: Gtk.Align.CENTER, disabled_text: _('Sin atajo')});
        const sync = () => (label.accelerator = settings.get_strv('atajo-busqueda')[0] ?? '');
        sync();
        const id = settings.connect('changed::atajo-busqueda', sync);
        row.connect('destroy', () => settings.disconnect(id));
        const change = new Gtk.Button({label: _('Cambiar'), valign: Gtk.Align.CENTER});
        change.connect('clicked', () => this._captureShortcut(window, settings));
        const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: _('Volver a Ctrl + Espacio')});
        reset.add_css_class('flat');
        reset.connect('clicked', () => settings.reset('atajo-busqueda'));
        row.add_suffix(label);
        row.add_suffix(change);
        row.add_suffix(reset);
        return row;
    }

    // A small window that waits for a key combination. Esc cancels.
    _captureShortcut(window, settings) {
        const status = new Adw.StatusPage({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            title: _('Pulsa el nuevo atajo'),
            description: _('Por ejemplo Ctrl + Espacio. Esc para cancelar.'),
        });
        const dialog = new Adw.Window({transient_for: window, modal: true, default_width: 440, default_height: 300,
            content: status, title: _('Atajo de la búsqueda')});
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval, _code, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_Escape && !mods) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // Wait for a real key, not just Ctrl/Shift/Alt/Super alone.
            if (!Gtk.accelerator_valid(keyval, mods) || [Gdk.KEY_Control_L, Gdk.KEY_Control_R, Gdk.KEY_Shift_L,
                Gdk.KEY_Shift_R, Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Super_L, Gdk.KEY_Super_R].includes(keyval))
                return Gdk.EVENT_STOP;
            settings.set_strv('atajo-busqueda', [Gtk.accelerator_name(keyval, mods)]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(keys);
        dialog.present();
    }

    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(620, 720);

        // ---------- Isla ----------
        const page = new Adw.PreferencesPage({title: _('Isla'), icon_name: 'weather-clear-night-symbolic'});
        window.add(page);

        page.add(this._skinsGroup(settings));
        page.add(this._accentGroup(settings));

        const look = new Adw.PreferencesGroup({title: _('Aspecto')});
        look.add(this._speedRow(settings));
        look.add(this._panelStyleRow(settings));
        look.add(comboRow(settings, 'efecto-iconos', _('Cómo aparecen los íconos'), [
            ['uno-a-uno', _('Uno por uno')],
            ['todos', _('Todos a la vez')],
            ['centro', _('Desde el centro hacia los lados')],
        ], _('Al abrir la isla')));
        look.add(switchRow(settings, 'desenfoque', _('Desenfocar lo que hay detrás'), _('Apágalo si quieres la isla aún más liviana')));
        look.add(switchRow(settings, 'desenfoque-cajon', _('Fondo desenfocado en el cajón de aplicaciones'),
            _('Tu fondo de pantalla, desenfocado, detrás de las aplicaciones y de Actividades')));
        look.add(switchRow(settings, 'isla-respiracion', _('Respiración'), _('En reposo, el fondo late muy despacio')));
        look.add(switchRow(settings, 'ahorro-energia', _('Ahorrar batería'),
            _('Con batería o en modo Ahorro: sin desenfoque, sin halo de Aurora en movimiento ni respiración. ') +
            _('Si en Accesibilidad apagas las animaciones, la isla también se calma')));
        look.add(comboRow(settings, 'ocultar', _('Esconder la isla'), [
            ['nunca', _('Nunca')],
            ['inteligente', _('Cuando una ventana la toca')],
            ['siempre', _('Siempre (aparece al llevar el mouse abajo)')],
        ]));
        page.add(look);

        const functions = new Adw.PreferencesGroup({
            title: _('Funciones'),
            description: _('Clic largo sobre la isla: No molestar. Arrastrar hacia arriba: aplicaciones.'),
        });
        functions.add(switchRow(settings, 'isla-musica', _('Música'), _('Lo que suena, con sus botones (Shift + rueda cambia de canción)')));
        functions.add(switchRow(settings, 'avisos-flotantes', _('Notificaciones flotantes'),
            _('Cada notificación aparece sola arriba en el centro, sin isla ni barra, y se va sola')));
        functions.add(switchRow(settings, 'isla-rueda-volumen', _('La rueda cambia el volumen')));
        functions.add(switchRow(settings, 'isla-vistas-previas', _('Vista en miniatura de las ventanas'),
            _('Al dejar el mouse sobre una app abierta (Firefox, Archivos…) aparece lo que tiene en pantalla')));
        functions.add(switchRow(settings, 'isla-progreso', _('Progreso de tareas'),
            _('Descargas, copias… solo de las apps que lo publican (como en Dash to Dock)')));
        functions.add(switchRow(settings, 'insignias', _('Mensajes sin leer en los íconos'),
            _('Un número sobre la app (Telegram, Thunderbird…), solo de las apps que lo publican')));
        functions.add(switchRow(settings, 'mayus-insignia', _('Símbolo de mayúsculas en la isla'),
            _('Mientras estén activas, un pequeño ⇪ en la esquina de la isla')));
        functions.add(switchRow(settings, 'cafeina-activa', _('Cafeína'),
            _('La pantalla no se apaga ni el equipo se suspende. También en el panel Ajustes')));
        functions.add(switchRow(settings, 'no-molestar', _('No molestar'), _('También con un clic largo sobre la isla')));
        page.add(functions);

        const status = new Adw.PreferencesGroup({
            title: _('Estado'),
            description: _('Lo que se pierde al quitar la barra superior: en la isla y antes de Ajustes.'),
        });
        status.add(switchRow(settings, 'bateria-porcentaje', _('Porcentaje de la batería'),
            _('El número junto al ícono. Sin batería no aparece nada')));
        status.add(switchRow(settings, 'espacios-trabajo', _('Espacios de trabajo'),
            _('Un punto por espacio: clic para ir a uno, la rueda pasa al siguiente. Con uno solo no aparece')));
        page.add(status);

        const tools = new Adw.PreferencesGroup({
            title: _('Herramientas'),
            description: _('Clic derecho sobre la isla: temporizador de 5, 15 o 25 minutos, uno a tu medida o un Pomodoro.'),
        });
        tools.add(this._shortcutRow(window, settings));
        page.add(tools);

        // ---------- Dock ----------
        const dock = new Adw.PreferencesPage({title: _('Dock'), icon_name: 'view-app-grid-symbolic'});
        window.add(dock);
        const size = new Adw.PreferencesGroup({title: _('Íconos')});
        const base = Adw.SpinRow.new_with_range(24, 64, 1);
        base.title = _('Tamaño de los íconos');
        base.subtitle = _('Con la isla abierta, en píxeles');
        settings.bind('tamano-base', base, 'value', Gio.SettingsBindFlags.DEFAULT);
        size.add(base);
        size.add(switchRow(settings, 'magnificacion', _('Agrandar al pasar el mouse')));
        size.add(switchRow(settings, 'desaturar-en-reposo', _('Íconos en gris (apagados)'), _('Toman color al pasar el mouse')));
        size.add(comboRow(settings, 'clic-enfocada', _('Clic en la app que está al frente'), [
            ['minimizar', _('Minimizar')],
            ['rotar', _('Pasar a su siguiente ventana')],
            ['miniaturas', _('Mostrar sus miniaturas')],
        ], _('Con una sola ventana, siempre minimiza. Clic central: ventana nueva')));
        size.add(switchRow(settings, 'rueda-ventanas', _('La rueda sobre una app pasa por sus ventanas'),
            _('Sobre el resto de la isla la rueda sigue cambiando el volumen')));
        const themes = listIconThemes();
        size.add(comboRow(settings, 'tema-iconos', _('Tema de íconos'),
            [['', _('El del sistema')], ...themes.map(t => [t.id, t.path.startsWith(GLib.get_home_dir()) ? fmt(_('{nombre}  (tuyo)'), {nombre: t.name}) : t.name])],
            _('Los de ~/.icons aparecen aquí')));
        const folder = new Adw.ActionRow({title: _('Tus íconos sueltos'), subtitle: _('~/.icons/isla-dock o ~/.icons — .svg o .png con el nombre de la app')});
        const open = new Gtk.Button({label: _('Abrir carpeta'), valign: Gtk.Align.CENTER});
        open.connect('clicked', () => {
            GLib.mkdir_with_parents(USER_DOCK_ICONS, 0o755);
            Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(USER_DOCK_ICONS, null), null);
        });
        folder.add_suffix(open);
        size.add(folder);
        dock.add(size);

        dock.add(this._monitorGroup(settings));

        const extras = new Adw.PreferencesGroup({title: _('Al final del dock')});
        extras.add(switchRow(settings, 'mostrar-descargas', _('Descargas'), _('Su pila se configura más abajo')));
        extras.add(switchRow(settings, 'mostrar-papelera', _('Papelera'), _('Clic derecho para vaciarla')));
        extras.add(switchRow(settings, 'mostrar-aplicaciones', _('Aplicaciones'), _('Ver y buscar todo lo que tienes instalado')));
        extras.add(switchRow(settings, 'mostrar-portapapeles', _('Portapapeles'),
            _('Historial de lo copiado (texto, enlaces, colores e imágenes). Super+V lo abre desde cualquier lugar; ') +
            _('mientras esté activo, Super+V deja de abrir las notificaciones (sigue Super+M)')));
        extras.add(switchRow(settings, 'mostrar-energia', _('Ajustes'),
            _('Red, Bluetooth, modo de energía, luz nocturna, estilo oscuro, cafeína, volumen, captura, bloquear, apagar… ') +
            _('Clic derecho o mantener pulsado: suspender')));
        extras.add(switchRow(settings, 'ocultar-barra-superior', _('Quitar la barra superior de GNOME'),
            _('Desaparece del todo; sus controles quedan en el botón Ajustes. Las esquinas activas siguen funcionando')));
        dock.add(extras);
        dock.add(this._stackGroup(window, settings));
        dock.add(this._foldersGroup(window, settings));

        window.add(this._desktopPage(settings));
        window.add(this._aboutPage(window, settings));
    }

    // ---------- Dock: which monitor ----------
    _monitorGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Monitor'),
            description: _('Con varios monitores, la isla vive en uno. Si ese monitor se desconecta, pasa al principal.'),
        });
        const monitors = Gdk.Display.get_default().get_monitors();
        const options = [[-1, _('El principal')]];
        for (let i = 0; i < monitors.get_n_items(); i++) {
            const m = monitors.get_item(i);
            options.push([i, `${fmt(_('Monitor {n}'), {n: i + 1})}${m.model ? `  (${m.model})` : ''}`]);
        }
        const row = new Adw.ComboRow({title: _('Monitor de la isla'), model: Gtk.StringList.new(options.map(([, label]) => label))});
        row.selected = Math.max(0, options.findIndex(([v]) => v === settings.get_int('monitor-isla')));
        row.connect('notify::selected', () => settings.set_int('monitor-isla', options[row.selected]?.[0] ?? -1));
        row.sensitive = options.length > 2;
        if (!row.sensitive)
            row.subtitle = _('Ahora hay un solo monitor');
        group.add(row);
        return group;
    }

    // ---------- Escritorio: the desktop clock ----------
    _desktopPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Escritorio'), icon_name: 'preferences-desktop-wallpaper-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: _('Reloj en el escritorio'),
            description: _('La hora y la fecha sobre tu fondo de pantalla, detrás de las ventanas. Los clics lo atraviesan.'),
        });
        group.add(switchRow(settings, 'reloj-escritorio', _('Mostrar el reloj')));
        group.add(comboRow(settings, 'reloj-estilo', _('Estilo'), [
            ['linea-viva', _('Línea viva')],
            ['lateral-acento', _('Lateral acento')],
            ['semana-fluida', _('Semana fluida')],
            ['arco-dia', _('Arco del día')],
        ]));
        group.add(this._sliderRow(settings, 'reloj-tamano', _('Tamaño'), _('Se ajusta solo a tu pantalla; esto lo agranda o achica'),
            0.5, 2.0, 0.05, [[0.5, _('Pequeño')], [1.0, null], [2.0, _('Grande')]]));
        group.add(comboRow(settings, 'reloj-posicion', _('Posición'), [
            ['arriba', _('Arriba')],
            ['centro', _('En el centro de la pantalla')],
            ['abajo', _('Abajo')],
        ]));
        group.add(this._sliderRow(settings, 'reloj-desplazamiento', _('Subir o bajar'), _('Ajuste fino desde la posición elegida'),
            -20, 20, 0.5, [[-20, _('Arriba')], [0, null], [20, _('Abajo')]]));

        const monitors = Gdk.Display.get_default().get_monitors();
        const options = [[-1, _('El principal')]];
        for (let i = 0; i < monitors.get_n_items(); i++) {
            const m = monitors.get_item(i);
            options.push([i, `${fmt(_('Monitor {n}'), {n: i + 1})}${m.model ? `  (${m.model})` : ''}`]);
        }
        if (options.length > 2) {
            const row = new Adw.ComboRow({title: _('Monitor'), model: Gtk.StringList.new(options.map(([, label]) => label))});
            row.selected = Math.max(0, options.findIndex(([v]) => v === settings.get_int('reloj-monitor')));
            row.connect('notify::selected', () => settings.set_int('reloj-monitor', options[row.selected]?.[0] ?? -1));
            group.add(row);
        }
        page.add(group);

        const side = new Adw.PreferencesGroup({
            title: _('Reloj lateral'),
            description: _('Escondido en el borde, centrado en vertical: lleva el mouse al borde y sale una burbuja con la hora. ') +
                _('Sirve cuando las ventanas maximizadas tapan el reloj del escritorio.'),
        });
        side.add(switchRow(settings, 'reloj-lateral', _('Mostrar el reloj lateral')));
        side.add(comboRow(settings, 'clock-style', _('Estilo del reloj'), [
            ['editorial', _('Editorial')],
            ['semana', _('Isla con semana')],
            ['linea', _('Línea del día')],
            ['horizonte', _('Horizonte')],
        ]));
        side.add(comboRow(settings, 'reloj-lateral-borde', _('Borde'), [
            ['derecho', _('Derecho')],
            ['izquierdo', _('Izquierdo')],
        ]));
        side.add(switchRow(settings, 'reloj-lateral-calendario', _('Un clic abre el calendario'),
            _('Con tus recordatorios')));
        page.add(side);

        const hasInter = PangoCairo.FontMap.get_default().list_families().some(f => f.get_name() === 'Inter');
        if (!hasInter) {
            const font = new Adw.PreferencesGroup({
                title: _('Letra'),
                description: _('El reloj está diseñado con la letra Inter; mientras no esté instalada usa Cantarell. ') +
                    _('Para instalarla: sudo apt install fonts-inter (y luego cerrar sesión).'),
            });
            page.add(font);
        }
        return page;
    }

    _sliderRow(settings, key, title, subtitle, min, max, step, marks) {
        const row = new Adw.ActionRow({title, subtitle});
        const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, min, max, step);
        scale.set_size_request(220, -1);
        scale.valign = Gtk.Align.CENTER;
        scale.draw_value = false;
        for (const [value, label] of marks)
            scale.add_mark(value, Gtk.PositionType.BOTTOM, label);
        settings.bind(key, scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(scale);
        return row;
    }

    // ---------- About ----------
    _aboutPage(window, settings) {
        const page = new Adw.PreferencesPage({title: _('Acerca de'), icon_name: 'help-about-symbolic'});
        const group = new Adw.PreferencesGroup();
        const title = new Gtk.Label({label: 'IslaDock', css_classes: ['title-1'], margin_top: 24});
        const subtitle = new Gtk.Label({label: _('Un dock en forma de isla para GNOME'), css_classes: ['dim-label'], margin_bottom: 18});
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(title);
        box.append(subtitle);
        group.add(box);
        page.add(group);
        const info = new Adw.PreferencesGroup();
        const row = (label, value) => {
            const r = new Adw.ActionRow({title: label});
            r.add_suffix(new Gtk.Label({label: value, css_classes: ['dim-label'], valign: Gtk.Align.CENTER}));
            return r;
        };
        info.add(row(_('Creador y diseñador'), 'Frank Molina'));
        info.add(row(_('Versión'), this.metadata['version-name'] ?? String(this.metadata.version ?? '')));
        info.add(row(_('Licencia'), _('GNU GPL 2.0 o posterior')));
        page.add(info);
        page.add(this._backupGroup(window, settings));
        page.add(this._donateGroup());
        return page;
    }

    // ---------- Copia de la configuración ----------
    // A JSON file with every setting of IslaDock as GVariant text. Loading it
    // checks it first: only IslaDock's keys, each with its own type.
    _backupGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Copia de la configuración'),
            description: _('Guarda todo lo que elegiste aquí en un archivo, para otro equipo o para volver atrás.'),
        });
        const save = new Adw.ActionRow({title: _('Exportar'), subtitle: _('Guardar la configuración en un archivo')});
        const saveButton = new Gtk.Button({icon_name: 'document-save-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: _('Exportar…'), css_classes: ['flat']});
        save.add_suffix(saveButton);
        save.activatable_widget = saveButton;
        const load = new Adw.ActionRow({title: _('Importar'), subtitle: _('Cargar una configuración guardada')});
        const loadButton = new Gtk.Button({icon_name: 'document-open-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: _('Importar…'), css_classes: ['flat']});
        load.add_suffix(loadButton);
        load.activatable_widget = loadButton;
        group.add(save);
        group.add(load);

        const filter = new Gtk.FileFilter({name: _('Configuración de IslaDock (.json)')});
        filter.add_pattern('*.json');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        const toast = text => window.add_toast(new Adw.Toast({title: text, timeout: 4}));

        saveButton.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: _('Exportar la configuración'), filters,
                initial_name: `IslaDock-${GLib.DateTime.new_now_local().format('%Y-%m-%d')}.json`});
            dialog.save(window, null, (d, res) => {
                let file;
                try {
                    file = d.save_finish(res);
                } catch {
                    return;
                }
                try {
                    const text = JSON.stringify(exportSettings(settings, this.metadata), null, 2);
                    file.replace_contents(new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                    toast(_('Configuración guardada'));
                } catch (e) {
                    toast(fmt(_('No se pudo guardar: {error}'), {error: e.message}));
                }
            });
        });
        loadButton.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: _('Importar la configuración'), filters});
            dialog.open(window, null, (d, res) => {
                let file;
                try {
                    file = d.open_finish(res);
                } catch {
                    return;
                }
                try {
                    const [, bytes] = file.load_contents(null);
                    const {applied, skipped} = importSettings(settings, new TextDecoder().decode(bytes));
                    toast(skipped ? fmt(_('Configuración cargada ({n} opciones; {malas} no válidas se dejaron igual)'), {n: applied, malas: skipped})
                        : fmt(_('Configuración cargada ({n} opciones)'), {n: applied}));
                } catch (e) {
                    toast(fmt(_('Ese archivo no es una configuración de IslaDock: {error}'), {error: e.message}));
                }
            });
        });
        return group;
    }

    // Same PayPal profile as Alemi Finanzas.
    _donateGroup() {
        const css = new Gtk.CssProvider();
        css.load_from_string(
            '.btn-paypal { background: linear-gradient(180deg, #0B3F91 0%, #003087 100%); color: #FFFFFF; ' +
            'font-weight: bold; border-radius: 12px; padding: 6px 16px; box-shadow: 0 3px 0 #001C54; }' +
            '.btn-paypal:hover { background: linear-gradient(180deg, #1150B0 0%, #003A9E 100%); }' +
            '.btn-paypal:active { box-shadow: none; }' +
            '.btn-paypal .paypal-mark { color: #FFC439; }' +
            '.donate-heart { color: #E5484D; font-size: 18px; }');
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        const group = new Adw.PreferencesGroup();
        const row = new Adw.ActionRow({
            title: _('Apoya a IslaDock'),
            subtitle: _('Si IslaDock te es útil, puedes apoyar su desarrollo con una donación voluntaria.'),
        });
        row.add_prefix(new Gtk.Label({label: '♥', css_classes: ['donate-heart']}));
        const content = new Gtk.Box({spacing: 8});
        content.append(new Gtk.Label({label: '♥', css_classes: ['paypal-mark']}));
        content.append(new Gtk.Label({label: _('Donar con PayPal')}));
        const button = new Gtk.Button({child: content, valign: Gtk.Align.CENTER, css_classes: ['btn-paypal']});
        button.connect('clicked', () => {
            new Gtk.UriLauncher({uri: PAYPAL_DONATION_URL}).launch(button.get_root(), null, (l, res) => {
                try {
                    l.launch_finish(res);
                } catch {}
            });
        });
        row.add_suffix(button);
        group.add(row);
        return group;
    }

    // ---------- Carpetas de Archivos ----------
    _foldersGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Carpetas de Archivos'),
            description: _('Clic en Archivos: tus carpetas, como la pila de descargas. Clic central: abre Archivos. ') +
                _('Clic derecho sobre una carpeta añadida: quitarla.'),
        });
        group.add(switchRow(settings, 'carpetas-archivos', _('Mostrar las carpetas al hacer clic en Archivos')));

        const fixed = [
            [GLib.UserDirectory.DIRECTORY_DOWNLOAD, 'folder-download-symbolic'],
            [GLib.UserDirectory.DIRECTORY_DOCUMENTS, 'folder-documents-symbolic'],
            [GLib.UserDirectory.DIRECTORY_PICTURES, 'folder-pictures-symbolic'],
            [GLib.UserDirectory.DIRECTORY_MUSIC, 'folder-music-symbolic'],
            [GLib.UserDirectory.DIRECTORY_VIDEOS, 'folder-videos-symbolic'],
        ];
        for (const [dir, icon] of fixed) {
            const path = GLib.get_user_special_dir(dir);
            if (!path)
                continue;
            const row = new Adw.ActionRow({title: GLib.path_get_basename(path), subtitle: _('Siempre está')});
            row.add_prefix(new Gtk.Image({icon_name: icon}));
            group.add(row);
        }

        // The added ones, each with its own "Quitar".
        let rows = [];
        const sync = () => {
            rows.forEach(r => group.remove(r));
            rows = settings.get_strv('carpetas-extra').map(path => {
                const home = path === GLib.get_home_dir();
                const row = new Adw.ActionRow({title: home ? _('Carpeta personal') : GLib.path_get_basename(path) || path, subtitle: path});
                row.add_prefix(new Gtk.Image({icon_name: home ? 'user-home-symbolic' : 'folder-symbolic'}));
                const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Quitar de la lista')});
                remove.add_css_class('flat');
                remove.connect('clicked', () =>
                    settings.set_strv('carpetas-extra', settings.get_strv('carpetas-extra').filter(p => p !== path)));
                row.add_suffix(remove);
                group.add(row);
                return row;
            });
            group.remove(add);
            group.add(add);
        };
        const add = new Adw.ActionRow({title: _('Añadir otra carpeta'), activatable: true});
        add.add_prefix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
        add.connect('activated', () => {
            const dialog = new Gtk.FileDialog({title: _('Carpeta para añadir a Archivos'), modal: true});
            dialog.select_folder(window, null, (d, res) => {
                try {
                    const path = d.select_folder_finish(res)?.get_path();
                    const list = settings.get_strv('carpetas-extra');
                    if (path && !list.includes(path))
                        settings.set_strv('carpetas-extra', [...list, path]);
                } catch {}
            });
        });
        group.add(add);
        sync();
        const id = settings.connect('changed::carpetas-extra', sync);
        group.connect('destroy', () => settings.disconnect(id));
        return group;
    }

    // ---------- Downloads stack ----------
    _stackGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Pila de descargas'),
            description: _('Clic en Descargas: tus últimos archivos. Clic central: la carpeta. Clic derecho: cambiar la vista.'),
        });
        group.add(comboRow(settings, 'stack-view', _('Vista'), [
            ['cascade', _('Cascada diagonal')],
            ['grid', _('Cuadrícula')],
            ['list', _('Lista')],
        ]));
        const cascade = Adw.SpinRow.new_with_range(3, 12, 1);
        cascade.title = _('Máximo en cascada');
        settings.bind('stack-cascade-max', cascade, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(cascade);
        const grid = Adw.SpinRow.new_with_range(4, 32, 4);
        grid.title = _('Máximo en cuadrícula');
        grid.subtitle = '4 por fila';
        settings.bind('stack-grid-max', grid, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(grid);
        const list = Adw.SpinRow.new_with_range(3, 12, 1);
        list.title = _('Máximo en lista');
        settings.bind('stack-list-max', list, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(list);
        group.add(switchRow(settings, 'stack-show-aviso', _('Avisar cuando termina una descarga'),
            _('«Descarga lista» aparece arriba, como las demás notificaciones')));

        // Folder: the system's Downloads unless another one is chosen.
        const folder = new Adw.ActionRow({title: _('Carpeta')});
        const sync = () => {
            const own = settings.get_string('stack-folder');
            folder.subtitle = own || _('Descargas del sistema');
            reset.sensitive = !!own;
        };
        const choose = new Gtk.Button({label: _('Elegir…'), valign: Gtk.Align.CENTER});
        choose.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: _('Carpeta de la pila de descargas'), modal: true});
            dialog.select_folder(window, null, (d, res) => {
                try {
                    const file = d.select_folder_finish(res);
                    if (file?.get_path())
                        settings.set_string('stack-folder', file.get_path());
                } catch {}
            });
        });
        const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: _('Volver a Descargas del sistema')});
        reset.add_css_class('flat');
        reset.connect('clicked', () => settings.reset('stack-folder'));
        folder.add_suffix(choose);
        folder.add_suffix(reset);
        sync();
        const id = settings.connect('changed::stack-folder', sync);
        folder.connect('destroy', () => settings.disconnect(id));
        group.add(folder);
        return group;
    }
}
