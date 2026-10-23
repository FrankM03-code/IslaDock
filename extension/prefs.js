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

const PAYPAL_DONATION_URL = 'https://paypal.me/frankmolina29';

// Skin cards, two per row: [id, skin key, dark (Clásica only, null = untouched), name, about].
const SKINS = [
    ['clasica', 'clasica', false, 'Clásica', 'Vidrio claro y desenfocado'],
    ['clasica-oscura', 'clasica', true, 'Clásica oscura', 'El mismo vidrio, en tono oscuro'],
    ['vidrio-oscuro', 'vidrio-oscuro', null, 'Vidrio oscuro', 'Vidrio ahumado que dobla el fondo como una lupa'],
    ['aurora', 'aurora', null, 'Aurora', 'Cápsula oscura con un halo que fluye'],
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
    if (key === 'vidrio-oscuro') {
        // Dark glass with a rim lit from the top left.
        roundRect(cr, x, y + 4, cw, ch, 10);
        cr.setSourceRGBA(0, 0, 0, 0.35);
        cr.fill();
        roundRect(cr, x, y, cw, ch, 10);
        cr.setSourceRGBA(0.10, 0.11, 0.14, 0.82);
        cr.fillPreserve();
        const rim = new Cairo.LinearGradient(x, y, x + cw * 0.4, y + ch);
        rim.addColorStopRGBA(0, 1, 1, 1, 0.85);
        rim.addColorStopRGBA(1, 1, 1, 1, 0.15);
        cr.setSource(rim);
        cr.setLineWidth(1.5);
        cr.stroke();
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

export default class IslaDockPreferences extends ExtensionPreferences {
    // ---------- skins: a card per skin with its preview ----------
    _skinsGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Piel', description: 'Cómo se ve la isla. Se cambia al instante.'});
        const flow = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, column_spacing: 10,
            row_spacing: 10, min_children_per_line: 2, max_children_per_line: 2, margin_top: 4, margin_bottom: 4});
        let radio = null;
        const buttons = [];
        for (const [id, key, dark, name, about] of SKINS) {
            const area = new Gtk.DrawingArea({content_width: 150, content_height: 64});
            area.set_draw_func((_a, cr, w, h) => {
                drawPreview(id, cr, w, h);
                cr.$dispose();
            });
            const frame = new Gtk.Frame({child: area});
            const check = new Gtk.CheckButton({label: name, group: radio});
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
            card.append(new Gtk.Label({label: about, xalign: 0, wrap: true, css_classes: ['dim-label', 'caption']}));
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

    // Vidrio oscuro's own settings (they only show with that skin).
    _glassGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Vidrio oscuro',
            description: 'Sin ventanas detrás, el borde dobla el fondo como una lupa; con una ventana detrás, vidrio plano.'});
        group.add(switchRow(settings, 'glass-refraction', 'Efecto lupa en el borde', 'Apágalo para usar siempre el vidrio plano'));
        const slider = (key, title, subtitle, min, max, step, marks) => {
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
        };
        group.add(slider('glass-tint', 'Oscuridad del vidrio', 'Hacia la derecha, más oscuro', 0.2, 0.7, 0.01,
            [[0.2, 'Claro'], [0.46, null], [0.7, 'Oscuro']]));
        group.add(slider('glass-strength', 'Fuerza de la lupa', 'Cuánto se dobla el fondo en el borde', 0, 40, 1,
            [[0, 'Nada'], [28, null], [40, 'Mucha']]));
        group.add(switchRow(settings, 'glass-music-card', 'Música en una tarjeta aparte', 'Al lado de la isla, con su propio vidrio'));
        const sync = () => (group.visible = settings.get_string('isla-piel') === 'vidrio-oscuro');
        sync();
        const id = settings.connect('changed::isla-piel', sync);
        group.connect('destroy', () => settings.disconnect(id));
        return group;
    }

    // Background transparency: a slider from solid to almost clear.
    _transparencyRow(settings) {
        const row = new Adw.ActionRow({title: 'Transparencia de la isla', subtitle: 'Hacia la derecha se ve más lo que hay detrás'});
        const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 0.9, 0.05);
        scale.set_size_request(220, -1);
        scale.valign = Gtk.Align.CENTER;
        scale.draw_value = false;
        scale.add_mark(0, Gtk.PositionType.BOTTOM, 'Sólida');
        scale.add_mark(0.9, Gtk.PositionType.BOTTOM, 'Transparente');
        settings.bind('isla-transparencia', scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(scale);
        return row;
    }

    // Animation speed: a slider from quick to slow.
    _speedRow(settings) {
        const row = new Adw.ActionRow({title: 'Velocidad de las animaciones', subtitle: 'Hacia la derecha, más calmadas'});
        const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0.5, 2.5, 0.1);
        scale.set_size_request(220, -1);
        scale.valign = Gtk.Align.CENTER;
        scale.draw_value = false;
        scale.add_mark(0.5, Gtk.PositionType.BOTTOM, 'Rápida');
        scale.add_mark(1.0, Gtk.PositionType.BOTTOM, null);
        scale.add_mark(2.5, Gtk.PositionType.BOTTOM, 'Lenta');
        settings.bind('velocidad', scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(scale);
        return row;
    }

    // The search shortcut: press "Cambiar" and then the keys.
    _shortcutRow(window, settings) {
        const row = new Adw.ActionRow({title: 'Atajo de la búsqueda rápida', subtitle: 'Abre la isla como buscador'});
        const label = new Gtk.ShortcutLabel({valign: Gtk.Align.CENTER, disabled_text: 'Sin atajo'});
        const sync = () => (label.accelerator = settings.get_strv('atajo-busqueda')[0] ?? '');
        sync();
        const id = settings.connect('changed::atajo-busqueda', sync);
        row.connect('destroy', () => settings.disconnect(id));
        const change = new Gtk.Button({label: 'Cambiar', valign: Gtk.Align.CENTER});
        change.connect('clicked', () => this._captureShortcut(window, settings));
        const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Volver a Ctrl + Espacio'});
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
            title: 'Pulsa el nuevo atajo',
            description: 'Por ejemplo Ctrl + Espacio. Esc para cancelar.',
        });
        const dialog = new Adw.Window({transient_for: window, modal: true, default_width: 440, default_height: 300,
            content: status, title: 'Atajo de la búsqueda'});
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
        const page = new Adw.PreferencesPage({title: 'Isla', icon_name: 'weather-clear-night-symbolic'});
        window.add(page);

        page.add(this._skinsGroup(settings));
        page.add(this._glassGroup(settings));

        const look = new Adw.PreferencesGroup({title: 'Aspecto'});
        look.add(this._speedRow(settings));
        look.add(comboRow(settings, 'efecto-iconos', 'Cómo aparecen los íconos', [
            ['uno-a-uno', 'Uno por uno'],
            ['todos', 'Todos a la vez'],
            ['centro', 'Desde el centro hacia los lados'],
        ], 'Al abrir la isla'));
        look.add(switchRow(settings, 'desenfoque', 'Desenfocar lo que hay detrás', 'Apágalo si quieres la isla aún más liviana'));
        look.add(this._transparencyRow(settings));
        look.add(switchRow(settings, 'desenfoque-cajon', 'Fondo desenfocado en el cajón de aplicaciones',
            'Tu fondo de pantalla, desenfocado, detrás de las aplicaciones y de Actividades'));
        look.add(switchRow(settings, 'isla-respiracion', 'Respiración', 'En reposo, el fondo late muy despacio'));
        look.add(comboRow(settings, 'ocultar', 'Esconder la isla', [
            ['nunca', 'Nunca'],
            ['inteligente', 'Cuando una ventana la toca'],
            ['siempre', 'Siempre (aparece al llevar el mouse abajo)'],
        ]));
        page.add(look);

        const functions = new Adw.PreferencesGroup({
            title: 'Funciones',
            description: 'Clic largo sobre la isla: No molestar. Arrastrar hacia arriba: aplicaciones.',
        });
        functions.add(switchRow(settings, 'isla-musica', 'Música', 'Lo que suena, con sus botones (Shift + rueda cambia de canción)'));
        functions.add(switchRow(settings, 'avisos-flotantes', 'Notificaciones flotantes',
            'Cada notificación aparece sola arriba en el centro, sin isla ni barra, y se va sola'));
        functions.add(switchRow(settings, 'isla-rueda-volumen', 'La rueda cambia el volumen'));
        functions.add(switchRow(settings, 'isla-vistas-previas', 'Vista en miniatura de las ventanas',
            'Al dejar el mouse sobre una app abierta (Firefox, Archivos…) aparece lo que tiene en pantalla'));
        functions.add(switchRow(settings, 'isla-progreso', 'Progreso de tareas',
            'Descargas, copias… solo de las apps que lo publican (como en Dash to Dock)'));
        functions.add(switchRow(settings, 'insignias', 'Mensajes sin leer en los íconos',
            'Un número sobre la app (Telegram, Thunderbird…), solo de las apps que lo publican'));
        functions.add(switchRow(settings, 'mayus-insignia', 'Símbolo de mayúsculas en la isla',
            'Mientras estén activas, un pequeño ⇪ en la esquina de la isla'));
        functions.add(switchRow(settings, 'cafeina-activa', 'Cafeína',
            'La pantalla no se apaga ni el equipo se suspende. También en el panel Energía'));
        functions.add(switchRow(settings, 'no-molestar', 'No molestar', 'También con un clic largo sobre la isla'));
        page.add(functions);

        const status = new Adw.PreferencesGroup({
            title: 'Estado',
            description: 'Lo que se pierde al quitar la barra superior: en la isla y antes de Energía.',
        });
        status.add(switchRow(settings, 'bateria-porcentaje', 'Porcentaje de la batería',
            'El número junto al ícono. Sin batería no aparece nada'));
        status.add(switchRow(settings, 'espacios-trabajo', 'Espacios de trabajo',
            'Un punto por espacio: clic para ir a uno, la rueda pasa al siguiente. Con uno solo no aparece'));
        const appIndicator = new Gio.Settings({schema_id: 'org.gnome.shell'}).get_strv('enabled-extensions')
            .includes('appindicatorsupport@rgcjonas.gmail.com');
        status.add(switchRow(settings, 'bandeja', 'Íconos de bandeja',
            appIndicator ? 'Telegram, qBittorrent, Discord… Usa los de la extensión AppIndicator, que está activa'
                : 'Telegram, qBittorrent, Discord… Clic: abrir · clic derecho: su menú'));
        status.add(comboRow(settings, 'bandeja-lado', 'Lugar de la bandeja', [
            ['derecha', 'Antes de Energía'],
            ['izquierda', 'Al comienzo del dock'],
        ]));
        page.add(status);

        const tools = new Adw.PreferencesGroup({
            title: 'Herramientas',
            description: 'Clic derecho sobre la isla: temporizador de 5, 15 o 25 minutos, uno a tu medida o un Pomodoro.',
        });
        tools.add(this._shortcutRow(window, settings));
        page.add(tools);

        // ---------- Dock ----------
        const dock = new Adw.PreferencesPage({title: 'Dock', icon_name: 'view-app-grid-symbolic'});
        window.add(dock);
        const size = new Adw.PreferencesGroup({title: 'Íconos'});
        const base = Adw.SpinRow.new_with_range(24, 64, 1);
        base.title = 'Tamaño de los íconos';
        base.subtitle = 'Con la isla abierta, en píxeles';
        settings.bind('tamano-base', base, 'value', Gio.SettingsBindFlags.DEFAULT);
        size.add(base);
        size.add(switchRow(settings, 'magnificacion', 'Agrandar al pasar el mouse'));
        size.add(switchRow(settings, 'desaturar-en-reposo', 'Íconos en gris (apagados)', 'Toman color al pasar el mouse'));
        const themes = listIconThemes();
        size.add(comboRow(settings, 'tema-iconos', 'Tema de íconos',
            [['', 'El del sistema'], ...themes.map(t => [t.id, t.path.startsWith(GLib.get_home_dir()) ? `${t.name}  (tuyo)` : t.name])],
            'Los de ~/.icons aparecen aquí'));
        const folder = new Adw.ActionRow({title: 'Tus íconos sueltos', subtitle: '~/.icons/isla-dock o ~/.icons — .svg o .png con el nombre de la app'});
        const open = new Gtk.Button({label: 'Abrir carpeta', valign: Gtk.Align.CENTER});
        open.connect('clicked', () => {
            GLib.mkdir_with_parents(USER_DOCK_ICONS, 0o755);
            Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(USER_DOCK_ICONS, null), null);
        });
        folder.add_suffix(open);
        size.add(folder);
        dock.add(size);

        const extras = new Adw.PreferencesGroup({title: 'Al final del dock'});
        extras.add(switchRow(settings, 'mostrar-descargas', 'Descargas', 'Su pila se configura más abajo'));
        extras.add(switchRow(settings, 'mostrar-papelera', 'Papelera', 'Clic derecho para vaciarla'));
        extras.add(switchRow(settings, 'mostrar-aplicaciones', 'Aplicaciones (botón Portal)', 'Ver y buscar todo lo que tienes instalado'));
        extras.add(switchRow(settings, 'portal-giro', 'El aro del Portal gira'));
        extras.add(switchRow(settings, 'mostrar-portapapeles', 'Portapapeles',
            'Historial de lo copiado (texto, enlaces, colores e imágenes). Super+V lo abre desde cualquier lugar; ' +
            'mientras esté activo, Super+V deja de abrir las notificaciones (sigue Super+M)'));
        extras.add(switchRow(settings, 'mostrar-energia', 'Energía',
            'Red, Bluetooth, modo de energía, luz nocturna, estilo oscuro, cafeína, volumen, captura, bloquear, apagar… ' +
            'Clic derecho o mantener pulsado: suspender'));
        extras.add(switchRow(settings, 'ocultar-barra-superior', 'Quitar la barra superior de GNOME',
            'Desaparece del todo; sus controles quedan en el botón Energía. Las esquinas activas siguen funcionando'));
        dock.add(extras);
        dock.add(this._stackGroup(window, settings));
        dock.add(this._foldersGroup(window, settings));

        window.add(this._desktopPage(settings));
        window.add(this._aboutPage());
    }

    // ---------- Escritorio: the desktop clock ----------
    _desktopPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Escritorio', icon_name: 'preferences-desktop-wallpaper-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Reloj en el escritorio',
            description: 'La hora y la fecha sobre tu fondo de pantalla, detrás de las ventanas. Los clics lo atraviesan.',
        });
        group.add(switchRow(settings, 'reloj-escritorio', 'Mostrar el reloj'));
        group.add(comboRow(settings, 'reloj-estilo', 'Estilo', [
            ['fino', 'Fino compacto'],
            ['lateral', 'Lateral compacto'],
            ['linea', 'Línea'],
            ['esquina', 'Esquina'],
            ['semana', 'Semana'],
            ['anillo', 'Anillo del día'],
        ]));
        group.add(this._sliderRow(settings, 'reloj-tamano', 'Tamaño', 'Se ajusta solo a tu pantalla; esto lo agranda o achica',
            0.5, 2.0, 0.05, [[0.5, 'Pequeño'], [1.0, null], [2.0, 'Grande']]));
        group.add(comboRow(settings, 'reloj-posicion', 'Posición', [
            ['arriba', 'Arriba'],
            ['centro', 'En el centro de la pantalla'],
            ['abajo', 'Abajo'],
        ]));
        group.add(this._sliderRow(settings, 'reloj-desplazamiento', 'Subir o bajar', 'Ajuste fino desde la posición elegida',
            -20, 20, 0.5, [[-20, 'Arriba'], [0, null], [20, 'Abajo']]));

        const monitors = Gdk.Display.get_default().get_monitors();
        const options = [[-1, 'El principal']];
        for (let i = 0; i < monitors.get_n_items(); i++) {
            const m = monitors.get_item(i);
            options.push([i, `Monitor ${i + 1}${m.model ? `  (${m.model})` : ''}`]);
        }
        if (options.length > 2) {
            const row = new Adw.ComboRow({title: 'Monitor', model: Gtk.StringList.new(options.map(([, label]) => label))});
            row.selected = Math.max(0, options.findIndex(([v]) => v === settings.get_int('reloj-monitor')));
            row.connect('notify::selected', () => settings.set_int('reloj-monitor', options[row.selected]?.[0] ?? -1));
            group.add(row);
        }
        page.add(group);

        const side = new Adw.PreferencesGroup({
            title: 'Reloj lateral',
            description: 'Escondido en el borde, centrado en vertical: lleva el mouse al borde y sale una burbuja con la hora. ' +
                'Sirve cuando las ventanas maximizadas tapan el reloj del escritorio.',
        });
        side.add(switchRow(settings, 'reloj-lateral', 'Mostrar el reloj lateral'));
        side.add(comboRow(settings, 'reloj-lateral-estilo', 'Estilo', [
            ['pildora', 'Píldora'],
            ['texto', 'Solo texto'],
            ['pestana', 'Pestaña vertical'],
        ]));
        side.add(comboRow(settings, 'reloj-lateral-borde', 'Borde', [
            ['derecho', 'Derecho'],
            ['izquierdo', 'Izquierdo'],
        ]));
        side.add(switchRow(settings, 'reloj-lateral-segundos', 'Mostrar los segundos'));
        side.add(switchRow(settings, 'reloj-lateral-calendario', 'Un clic abre el calendario',
            'Con las notificaciones recientes'));
        page.add(side);

        const hasInter = PangoCairo.FontMap.get_default().list_families().some(f => f.get_name() === 'Inter');
        if (!hasInter) {
            const font = new Adw.PreferencesGroup({
                title: 'Letra',
                description: 'El reloj está diseñado con la letra Inter; mientras no esté instalada usa Cantarell. ' +
                    'Para instalarla: sudo apt install fonts-inter (y luego cerrar sesión).',
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
    _aboutPage() {
        const page = new Adw.PreferencesPage({title: 'Acerca de', icon_name: 'help-about-symbolic'});
        const group = new Adw.PreferencesGroup();
        const title = new Gtk.Label({label: 'IslaDock', css_classes: ['title-1'], margin_top: 24});
        const subtitle = new Gtk.Label({label: 'Un dock en forma de isla para GNOME', css_classes: ['dim-label'], margin_bottom: 18});
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
        info.add(row('Creador y diseñador', 'Frank Molina'));
        info.add(row('Versión', this.metadata['version-name'] ?? String(this.metadata.version ?? '')));
        info.add(row('Licencia', 'GNU GPL 2.0 o posterior'));
        page.add(info);
        page.add(this._donateGroup());
        return page;
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
            title: 'Apoya a IslaDock',
            subtitle: 'Si IslaDock te es útil, puedes apoyar su desarrollo con una donación voluntaria.',
        });
        row.add_prefix(new Gtk.Label({label: '♥', css_classes: ['donate-heart']}));
        const content = new Gtk.Box({spacing: 8});
        content.append(new Gtk.Label({label: '♥', css_classes: ['paypal-mark']}));
        content.append(new Gtk.Label({label: 'Donar con PayPal'}));
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
            title: 'Carpetas de Archivos',
            description: 'Clic en Archivos: tus carpetas, como la pila de descargas. Clic central: abre Archivos. ' +
                'Clic derecho sobre una carpeta añadida: quitarla.',
        });
        group.add(switchRow(settings, 'carpetas-archivos', 'Mostrar las carpetas al hacer clic en Archivos'));

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
            const row = new Adw.ActionRow({title: GLib.path_get_basename(path), subtitle: 'Siempre está'});
            row.add_prefix(new Gtk.Image({icon_name: icon}));
            group.add(row);
        }

        // The added ones, each with its own "Quitar".
        let rows = [];
        const sync = () => {
            rows.forEach(r => group.remove(r));
            rows = settings.get_strv('carpetas-extra').map(path => {
                const home = path === GLib.get_home_dir();
                const row = new Adw.ActionRow({title: home ? 'Carpeta personal' : GLib.path_get_basename(path) || path, subtitle: path});
                row.add_prefix(new Gtk.Image({icon_name: home ? 'user-home-symbolic' : 'folder-symbolic'}));
                const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Quitar de la lista'});
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
        const add = new Adw.ActionRow({title: 'Añadir otra carpeta', activatable: true});
        add.add_prefix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
        add.connect('activated', () => {
            const dialog = new Gtk.FileDialog({title: 'Carpeta para añadir a Archivos', modal: true});
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
            title: 'Pila de descargas',
            description: 'Clic en Descargas: tus últimos archivos. Clic central: la carpeta. Clic derecho: cambiar la vista.',
        });
        group.add(comboRow(settings, 'stack-view', 'Vista', [
            ['cascade', 'Cascada diagonal'],
            ['grid', 'Cuadrícula'],
            ['list', 'Lista'],
        ]));
        const cascade = Adw.SpinRow.new_with_range(3, 12, 1);
        cascade.title = 'Máximo en cascada';
        settings.bind('stack-cascade-max', cascade, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(cascade);
        const grid = Adw.SpinRow.new_with_range(4, 32, 4);
        grid.title = 'Máximo en cuadrícula';
        grid.subtitle = '4 por fila';
        settings.bind('stack-grid-max', grid, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(grid);
        const list = Adw.SpinRow.new_with_range(3, 12, 1);
        list.title = 'Máximo en lista';
        settings.bind('stack-list-max', list, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(list);
        group.add(switchRow(settings, 'stack-show-aviso', 'Avisar cuando termina una descarga',
            '«Descarga lista» aparece arriba, como las demás notificaciones'));

        // Folder: the system's Downloads unless another one is chosen.
        const folder = new Adw.ActionRow({title: 'Carpeta'});
        const sync = () => {
            const own = settings.get_string('stack-folder');
            folder.subtitle = own || 'Descargas del sistema';
            reset.sensitive = !!own;
        };
        const choose = new Gtk.Button({label: 'Elegir…', valign: Gtk.Align.CENTER});
        choose.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Carpeta de la pila de descargas', modal: true});
            dialog.select_folder(window, null, (d, res) => {
                try {
                    const file = d.select_folder_finish(res);
                    if (file?.get_path())
                        settings.set_string('stack-folder', file.get_path());
                } catch {}
            });
        });
        const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Volver a Descargas del sistema'});
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
