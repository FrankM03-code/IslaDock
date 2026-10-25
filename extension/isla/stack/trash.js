// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Papelera: a left click on the dock's bin shows what is in the trash, the last
// thrown away first, with the same views as the downloads stack and the folders.
// A click on an item opens it; its menu restores it to where it was; the button
// opens the trash in the file manager. Emptying it asks first.
//
// Commands it listens to: 'trash-toggle' (anchor actor).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {StackPopup} from './stackPopup.js';
import * as FileActions from './fileActions.js';
import {_, fmt} from '../i18n.js';

const ATTRIBUTES = 'standard::name,standard::display-name,standard::icon,standard::type,standard::size,' +
    'standard::target-uri,trash::deletion-date,trash::orig-path,thumbnail::path';
const DEBOUNCE = 300;

class TrashModel extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this.files = [];
        this.total = 0;
        this._timer = 0;
        this._trash = Gio.File.new_for_uri('trash:///');
        try {
            this._monitor = this._trash.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect('changed', () => this._queue());
        } catch {
            this._monitor = null;
        }
        this.refresh();
    }

    // What the popup shows instead of the downloads' wording.
    get labels() {
        return {title: _('Papelera'), folder: _('Abrir la papelera'),
            count: n => (n === 1 ? _('1 elemento') : fmt(_('{n} elementos'), {n})), accent: true};
    }

    get _keep() {
        return Math.max(...['stack-grid-max', 'stack-cascade-max', 'stack-list-max'].map(key => this._settings.get_int(key)));
    }

    _queue() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE, () => {
            this._timer = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    refresh() {
        this._cancellable?.cancel();
        const cancellable = this._cancellable = new Gio.Cancellable();
        this._trash.enumerate_children_async(ATTRIBUTES, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable, (dir, res) => {
            let en;
            try {
                en = dir.enumerate_children_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._done([]);
                return;
            }
            const found = [];
            const next = () => en.next_files_async(50, GLib.PRIORITY_LOW, cancellable, (_e, r) => {
                let infos;
                try {
                    infos = en.next_files_finish(r);
                } catch {
                    en.close_async(GLib.PRIORITY_LOW, null, null);
                    return;
                }
                if (!infos.length) {
                    en.close_async(GLib.PRIORITY_LOW, null, null);
                    if (!cancellable.is_cancelled())
                        this._done(found);
                    return;
                }
                for (const info of infos)
                    found.push(this._entry(dir, info));
                next();
            });
            next();
        });
    }

    _entry(dir, info) {
        const item = dir.get_child(info.get_name());
        // The real file inside the trash folder: it can be opened and previewed.
        const target = info.get_attribute_string('standard::target-uri');
        const file = target ? Gio.File.new_for_uri(target) : item;
        const deleted = GLib.DateTime.new_from_iso8601(info.get_attribute_string('trash::deletion-date') ?? '',
            GLib.TimeZone.new_local());
        const thumb = info.get_attribute_byte_string('thumbnail::path');
        const gicon = thumb && GLib.file_test(thumb, GLib.FileTest.EXISTS)
            ? new Gio.FileIcon({file: Gio.File.new_for_path(thumb)}) : info.get_icon();
        return {
            file, item,
            uri: file.get_uri(),
            path: file.get_path(),
            display: info.get_display_name(),
            origin: info.get_attribute_byte_string('trash::orig-path'),
            gicon,
            thumb: gicon instanceof Gio.FileIcon,
            isDir: info.get_file_type() === Gio.FileType.DIRECTORY,
            partial: false,
            time: deleted?.to_unix() ?? 0,
            size: info.get_size(),
            progress: null,
        };
    }

    _done(found) {
        found.sort((a, b) => b.time - a.time);
        this.total = found.length;
        this.files = found.slice(0, this._keep);
        this.emit('changed');
    }

    // The popup's button.
    openMain() {
        FileActions.launch('trash:///');
    }

    // Abrir · Restaurar · Vaciar la papelera…
    fillMenu(menu, entry, close) {
        menu.addAction(_('Abrir'), () => {
            close();
            FileActions.launch(entry.uri);
        });
        menu.addAction(_('Restaurar'), () => {
            try {
                Gio.Subprocess.new(['gio', 'trash', '--restore', entry.item.get_uri()], Gio.SubprocessFlags.NONE);
            } catch (e) {
                console.warn(`IslaDock: no se pudo restaurar «${entry.display}»: ${e}`);
            }
        });
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Vaciar la papelera…'), () => {
            close();
            FileActions.confirmEmptyTrash();
        });
    }

    destroy() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._cancellable?.cancel();
        if (this._monitor) {
            this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
        }
        this.disconnectAll();
    }
}

export class Trash {
    constructor({state, settings, capsule}) {
        this._state = state;
        this._model = new TrashModel(settings);
        this._popup = new StackPopup({state, settings, model: this._model, capsule, holdId: 'trash'});
        this._id = state.connect('command', (_s, name, ...args) => {
            if (name === 'trash-toggle')
                this._popup.toggle(args[0]);
        });
    }

    destroy() {
        this._state.disconnect(this._id);
        this._popup.destroy();
        this._model.destroy();
    }
}
