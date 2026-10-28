// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Captura, a page of the top island (Frank's isla-captura-minimal design): four modes in a row,
// only an icon and a small label (the chosen one with a soft round behind its icon),
// and a footer line: the last capture's thumbnail and "Hace 2 min", copy and folder.
//   Pantalla  the monitor the island is on, at once; GNOME's white flash and "Captura guardada"
//             on the folded island say it was taken
//   Región    GNOME's own screenshot tool, opened on its area selection
//   Ventana   the focused window, at once
//   Grabar    GNOME's own recorder (the org.gnome.Shell.Screencast service, the one its
//             screenshot tool uses); the folded island turns into a small pill: red dot,
//             the time and a square to stop. Stopped: "Video guardado" for a moment.
// The island folds and hides before a screenshot so it never shows in it. GNOME records the
// screen exactly as it is painted: the small pill does show in the video (GNOME's own
// indicator does too). Screenshots go where GNOME puts them (~/Imágenes/Capturas de pantalla)
// and to the clipboard; videos to GNOME's folder (~/Vídeos/Screencasts).
// Checked against GNOME Shell 48 (js/ui/screenshot.js, dbusServices/screencast).
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Flashspot} from 'resource:///org/gnome/shell/ui/screenshot.js';

import {_, fmt} from '../i18n.js';
import {hbox, iconButton, label, spacer, vbox} from './widgets.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot');
Gio._promisify(Shell.Screenshot.prototype, 'screenshot_window');
Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area');

const SCREENCAST_BUS = 'org.gnome.Shell.Screencast';
const SCREENCAST_PATH = '/org/gnome/Shell/Screencast';
const THUMB_W = 32;
const THUMB_H = 20;
const SAVED_TIME = 2500;   // ms "Video guardado" / "Captura guardada" stay on the folded island

// GNOME's own folder and file names, in the user's language (the gnome-shell domain).
const shellText = text => GLib.dgettext('gnome-shell', text);

export function screenshotsDir() {
    return Gio.File.new_for_path(GLib.build_filenamev([
        GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir(),
        shellText('Screenshots')]));
}

// "Hace un momento", "Hace 2 min", "Hace 3 h", "12 oct".
function ago(seconds) {
    const min = Math.floor(seconds / 60);
    if (min < 1)
        return _('Hace un momento');
    if (min < 60)
        return fmt(_('Hace {n} min'), {n: min});
    if (min < 24 * 60)
        return fmt(_('Hace {n} h'), {n: Math.floor(min / 60)});
    return GLib.DateTime.new_from_unix_local(Math.floor(Date.now() / 1000) - seconds).format('%e %b').trim();
}

// The modes, in the design's order.
const MODES = [
    {id: 'pantalla', text: () => _('Pantalla'), icon: 'screenshot-ui-display-symbolic'},
    {id: 'region', text: () => _('Región'), icon: 'screenshot-ui-area-symbolic'},
    {id: 'ventana', text: () => _('Ventana'), icon: 'screenshot-ui-window-symbolic'},
    {id: 'grabar', text: () => _('Grabar'), icon: null},
];

export class CapturePage {
    constructor({notch}) {
        this.id = 'captura';
        this.title = _('Captura');
        this._notch = notch;
        this._mode = 'pantalla';
        this._last = null;          // {file, time (unix s)}
        this._recStart = 0;
        this._recTick = 0;
        this.actor = vbox({style_class: 'isla-sup-pagina isla-sup-captura', x_expand: true});

        // Pantalla · Región · Ventana · Grabar
        const row = hbox({style_class: 'isla-sup-modos', x_expand: true});
        this._modeButtons = new Map();
        for (const mode of MODES) {
            const box = vbox({style_class: 'isla-sup-modo-caja'});
            const round = new St.Bin({style_class: 'isla-sup-modo-circulo', x_align: Clutter.ActorAlign.CENTER});
            if (mode.icon) {
                round.set_child(new St.Icon({icon_name: mode.icon, icon_size: 16}));
            } else {
                // A ring with a red dot: drawn, not an icon, so the dot stays red.
                const ringBox = new St.Widget({style_class: 'isla-sup-grabar-anillo', layout_manager: new Clutter.BinLayout()});
                ringBox.add_child(new St.Widget({style_class: 'isla-sup-grabar-punto',
                    x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true}));
                round.set_child(ringBox);
            }
            box.add_child(round);
            box.add_child(label('isla-sup-modo-texto', mode.text(), {x_align: Clutter.ActorAlign.CENTER}));
            const button = new St.Button({style_class: 'isla-sup-modo', can_focus: true, x_expand: true,
                accessible_name: mode.text(), child: box});
            button.connect('clicked', () => this._run(mode.id));
            row.add_child(button);
            this._modeButtons.set(mode.id, button);
        }
        this.actor.add_child(row);

        // Footer: thumbnail + "Hace 2 min" ······ copy  folder
        const foot = hbox({style_class: 'isla-sup-captura-pie', x_expand: true});
        this._thumb = new St.Widget({style_class: 'isla-sup-captura-miniatura', y_align: Clutter.ActorAlign.CENTER,
            width: THUMB_W, height: THUMB_H, content_gravity: Clutter.ContentGravity.RESIZE_ASPECT});
        this._thumbButton = new St.Button({style_class: 'isla-sup-captura-miniatura-boton', can_focus: true,
            accessible_name: _('Abrir la última captura'), y_align: Clutter.ActorAlign.CENTER, child: this._thumb});
        this._thumbButton.connect('clicked', () => this._openLast());
        this._when = label('isla-sup-tenue isla-sup-captura-cuando');
        const copy = iconButton('edit-copy-symbolic', 'isla-sup-boton isla-sup-captura-icono', 14, _('Copiar la última captura'));
        copy.connect('clicked', () => this._copyLast());
        const folder = iconButton('folder-symbolic', 'isla-sup-boton isla-sup-captura-icono', 14, _('Abrir la carpeta de capturas'));
        folder.connect('clicked', () => this._openFolder());
        for (const a of [this._thumbButton, this._when, spacer(), copy, folder])
            foot.add_child(a);
        this.actor.add_child(foot);

        // GNOME's own tool (Región, or Impr Pant) also gives the footer its last capture.
        this._uiId = Main.screenshotUI.connect('screenshot-taken', (_ui, file) => this._setLast(file));
        this._paintModes();
        this._findLast();
    }

    _paintModes() {
        this._modeButtons.forEach((b, id) => b[id === this._mode ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked'));
    }

    _run(mode) {
        this._mode = mode;
        this._paintModes();
        if (mode === 'grabar')
            this._toggleRecording();
        else if (mode === 'region')
            this._region();
        else
            this._notch.hideWhile(() => this._shoot(mode)).catch(e => this._failed(e));
    }

    // ---------- screenshots ----------
    async _shoot(mode) {
        const shooter = new Shell.Screenshot();
        const stream = Gio.MemoryOutputStream.new_resizable();
        // The monitor the island is on (GNOME's "Pantalla" is one monitor too), or the focused window.
        let area = Main.layoutManager.primaryMonitor;
        if (mode === 'ventana') {
            const win = global.display.focus_window;
            if (!win) {
                this._notch.say(_('No hay ventana activa'), SAVED_TIME);
                return;
            }
            area = win.get_frame_rect();
            await shooter.screenshot_window(true, false, stream);
        } else {
            const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            await shooter.screenshot_area(area.x * sf, area.y * sf, area.width * sf, area.height * sf, stream);
        }
        stream.close(null);
        global.display.get_sound_player().play_from_theme('screen-capture', _('Captura tomada'), null);
        this._store(stream.steal_as_bytes());
        // Taken: GNOME's white flash over what was captured, and the folded island says so.
        new Flashspot({x: area.x, y: area.y, width: area.width, height: area.height}).fire();
        this._notch.say(_('Captura guardada'), SAVED_TIME);
    }

    // Like GNOME: to the clipboard first, then to its folder with its kind of name.
    _store(bytes) {
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
        const dir = screenshotsDir();
        try {
            dir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }
        const name = shellText('Screenshot From %s').replace('%s', GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S'));
        for (let i = 0; ; i++) {
            const file = dir.get_child(`${name}${i ? `-${i}` : ''}.png`);
            try {
                const out = file.create(Gio.FileCreateFlags.NONE, null);
                out.write_bytes(bytes, null);
                out.close(null);
                this._setLast(file);
                return;
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    throw e;
            }
        }
    }

    // GNOME's screenshot tool on its area selection; it saves, copies and tells us (screenshot-taken).
    _region() {
        const ui = Main.screenshotUI;
        if (ui.screencast_in_progress)
            return;
        // Hidden while the tool is open: it freezes the screen as it is when it opens.
        this._notch.hideWhile(() => new Promise(resolve => {
            const id = ui.connect('closed', () => {
                ui.disconnect(id);
                resolve();
            });
            ui.open().then(() => {
                if (ui._selectionButton && !ui._selectionButton.checked)
                    ui._selectionButton.checked = true;
            }).catch(e => {
                ui.disconnect(id);
                resolve();
                this._failed(e);
            });
        })).catch(e => this._failed(e));
    }

    _failed(e) {
        console.error(`IslaDock: ${e}`);
        this._when.text = _('No se pudo capturar');
        this._notch.say(_('No se pudo capturar'), SAVED_TIME);
    }

    // ---------- the last capture ----------
    // Opening: the newest picture in the screenshots folder.
    _findLast() {
        const dir = screenshotsDir();
        dir.enumerate_children_async('standard::name,standard::content-type,time::modified',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null, (d, res) => {
                let best = null;
                try {
                    const en = d.enumerate_children_finish(res);
                    for (let info; (info = en.next_file(null));) {
                        if (!info.get_content_type()?.startsWith('image/'))
                            continue;
                        const t = info.get_attribute_uint64('time::modified');
                        if (!best || t > best.time)
                            best = {file: dir.get_child(info.get_name()), time: t};
                    }
                    en.close(null);
                } catch {}
                if (this._gone || this._last)
                    return;
                this._last = best;
                this._paintLast();
            });
    }

    _setLast(file) {
        this._last = {file, time: Math.floor(Date.now() / 1000)};
        this._paintLast();
    }

    _paintLast() {
        const last = this._last;
        this._thumb.content = null;
        this._thumbButton.reactive = !!last;
        if (!last) {
            this._when.text = _('Sin capturas aún');
            return;
        }
        this._paintWhen();
        // A small copy of the picture (a 4K screenshot is never loaded whole).
        try {
            const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(last.file.get_path(), THUMB_W * 2 * sf, THUMB_H * 2 * sf, true);
            const content = St.ImageContent.new_with_preferred_size(THUMB_W, THUMB_H);
            content.set_bytes(global.stage.context.get_backend().get_cogl_context(), pb.read_pixel_bytes(),
                pb.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888, pb.width, pb.height, pb.rowstride);
            this._thumb.content = content;
        } catch {}
    }

    _paintWhen() {
        if (this._last)
            this._when.text = ago(Math.max(0, Date.now() / 1000 - this._last.time));
    }

    _copyLast() {
        if (!this._last)
            return;
        this._last.file.load_bytes_async(null, (f, res) => {
            try {
                const [bytes] = f.load_bytes_finish(res);
                St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
                this._when.text = _('Copiada');
            } catch {
                this._when.text = _('No se pudo copiar');
            }
            this._later(() => this._paintWhen(), 1500);
        });
    }

    _openLast() {
        if (this._last)
            Gio.AppInfo.launch_default_for_uri_async(this._last.file.get_uri(), null, null, null);
    }

    _openFolder() {
        const dir = screenshotsDir();
        try {
            dir.make_directory_with_parents(null);
        } catch {}
        Gio.AppInfo.launch_default_for_uri_async(dir.get_uri(), null, null, null);
        this._notch.fold();
    }

    _later(fn, delay) {
        if (this._laterId)
            GLib.source_remove(this._laterId);
        this._laterId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._laterId = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- recording ----------
    get recording() {
        return this._recStart > 0;
    }

    _screencast(method, params, type) {
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call(SCREENCAST_BUS, SCREENCAST_PATH, SCREENCAST_BUS, method, params,
                new GLib.VariantType(type), Gio.DBusCallFlags.NONE, -1, null, (bus, res) => {
                    try {
                        resolve(bus.call_finish(res).deepUnpack());
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _toggleRecording() {
        if (this.recording)
            this.stopRecording();
        else if (!Main.screenshotUI.screencast_in_progress && !this._starting)
            this._startRecording();
    }

    // The whole monitor the island is on, with the pointer, like GNOME's own recorder.
    async _startRecording() {
        this._starting = true;
        this._notch.fold();
        const m = Main.layoutManager.primaryMonitor;
        const template = GLib.build_filenamev([shellText('Screencasts'), shellText('Screencast From %d %t')]);
        try {
            const [ok] = await this._screencast('ScreencastArea', new GLib.Variant('(iiiisa{sv})',
                [m.x, m.y, m.width, m.height, template, {'draw-cursor': new GLib.Variant('b', true)}]), '(bs)');
            if (!ok)
                throw new Error('ScreencastArea failed');
            if (this._gone) {
                this._screencast('StopScreencast', null, '(b)').catch(() => {});
                return;
            }
            this._recStart = GLib.get_monotonic_time();
            this._paintRecording();
            this._recTick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._paintRecording();
                return GLib.SOURCE_CONTINUE;
            });
            this._errorId = Gio.DBus.session.signal_subscribe(SCREENCAST_BUS, SCREENCAST_BUS, 'Error', SCREENCAST_PATH,
                null, Gio.DBusSignalFlags.NONE, () => this._recordingEnded(_('No se pudo grabar')));
        } catch (e) {
            console.error(`IslaDock: ${e}`);
            this._notch.setRecording(null, _('No se pudo grabar'));
        } finally {
            this._starting = false;
        }
    }

    _paintRecording() {
        this._notch.setRecording(Math.floor((GLib.get_monotonic_time() - this._recStart) / 1e6));
    }

    async stopRecording() {
        if (!this.recording)
            return;
        this._stopTicking();
        let saved = false;
        try {
            [saved] = await this._screencast('StopScreencast', null, '(b)');
        } catch (e) {
            console.error(`IslaDock: ${e}`);
        }
        if (!this._gone)
            this._recordingEnded(saved ? _('Video guardado') : _('No se pudo guardar'));
    }

    _stopTicking() {
        this._recStart = 0;
        if (this._recTick)
            GLib.source_remove(this._recTick);
        this._recTick = 0;
        if (this._errorId)
            Gio.DBus.session.signal_unsubscribe(this._errorId);
        this._errorId = 0;
    }

    _recordingEnded(message) {
        this._stopTicking();
        this._notch.setRecording(null, message, SAVED_TIME);
    }

    minute() {
        this._paintWhen();
    }

    shown(on) {
        if (on)
            this._paintWhen();
    }

    destroy() {
        this._gone = true;
        // Taken away while recording (the page turned off, the extension off): the video is kept.
        if (this.recording)
            this._screencast('StopScreencast', null, '(b)').catch(() => {});
        this._stopTicking();
        this._notch.setRecording(null);
        if (this._laterId)
            GLib.source_remove(this._laterId);
        Main.screenshotUI.disconnect(this._uiId);
        this.actor.destroy();
    }
}
