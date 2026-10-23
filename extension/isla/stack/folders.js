// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Carpetas de Archivos: a left click on the file manager's icon shows the home
// folders (Descargas, Documentos, Imágenes, Música, Vídeos and the ones added in
// Preferencias) with the same views as the downloads stack.
//
// Commands it listens to: 'folders-toggle' (anchor actor).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {StackPopup} from './stackPopup.js';
import * as FileActions from './fileActions.js';
import {_} from '../i18n.js';

// [special dir, icon key for the resolver, theme icon]
const SPECIAL = [
    [GLib.UserDirectory.DIRECTORY_DOWNLOAD, 'descargas', 'folder-download'],
    [GLib.UserDirectory.DIRECTORY_DOCUMENTS, 'documentos', 'folder-documents'],
    [GLib.UserDirectory.DIRECTORY_PICTURES, 'imagenes', 'folder-pictures'],
    [GLib.UserDirectory.DIRECTORY_MUSIC, 'musica', 'folder-music'],
    [GLib.UserDirectory.DIRECTORY_VIDEOS, 'videos', 'folder-videos'],
];

class FoldersModel extends Signals.EventEmitter {
    constructor(settings, resolver) {
        super();
        this._settings = settings;
        this._resolver = resolver;
        this.files = [];
        this._ids = [
            [settings, settings.connect('changed::carpetas-extra', () => this._load())],
            [resolver, resolver.connect('changed', () => this._load())],
        ];
        this._load();
    }

    get total() {
        return this.files.length;
    }

    // What the popup shows instead of the downloads' wording.
    get labels() {
        return {title: _('Carpetas'), folder: _('Carpeta personal'), count: () => '', accent: false};
    }

    _entry(path, key, iconName, extra, display = GLib.path_get_basename(path)) {
        const file = Gio.File.new_for_path(path);
        const fallback = new Gio.ThemedIcon({name: iconName});
        return {
            file, path, extra,
            uri: file.get_uri(),
            display,
            gicon: this._resolver?.lookup(key, fallback, [iconName]) ?? fallback,
            detail: '',
        };
    }

    _load() {
        const home = GLib.get_home_dir();
        const seen = new Set();
        const files = [];
        for (const [dir, key, icon] of SPECIAL) {
            const path = GLib.get_user_special_dir(dir);
            if (!path || path === home || seen.has(path) || !GLib.file_test(path, GLib.FileTest.IS_DIR))
                continue;
            seen.add(path);
            files.push(this._entry(path, key, icon, false));
        }
        for (const path of this._settings.get_strv('carpetas-extra')) {
            if (!path || seen.has(path) || !GLib.file_test(path, GLib.FileTest.IS_DIR))
                continue;
            seen.add(path);
            // The home folder, when added, keeps its own name and the house, and goes first.
            if (path === home)
                files.unshift(this._entry(path, 'personal', 'user-home', true, _('Carpeta personal')));
            else
                files.push(this._entry(path, 'carpeta', 'folder', true));
        }
        this.files = files;
        this.emit('changed');
    }

    // The popup's "Carpeta personal".
    openMain() {
        FileActions.openFolder(GLib.get_home_dir());
    }

    // Abrir · Copiar ruta (· Quitar de la lista, only for the added ones)
    fillMenu(menu, entry, close) {
        menu.addAction(_('Abrir'), () => {
            close();
            FileActions.launch(entry.uri);
        });
        menu.addAction(_('Copiar ruta'), () => FileActions.copyPath(entry));
        if (entry.extra) {
            menu.addAction(_('Quitar de la lista'), () => {
                const list = this._settings.get_strv('carpetas-extra').filter(p => p !== entry.path);
                this._settings.set_strv('carpetas-extra', list);
            });
        }
    }

    destroy() {
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
    }
}

export class Folders {
    constructor({state, settings, capsule, resolver}) {
        this._state = state;
        this._model = new FoldersModel(settings, resolver);
        this._popup = new StackPopup({state, settings, model: this._model, capsule, holdId: 'folders'});
        this._id = state.connect('command', (_s, name, ...args) => {
            if (name === 'folders-toggle')
                this._popup.toggle(args[0]);
        });
    }

    destroy() {
        this._state.disconnect(this._id);
        this._popup.destroy();
        this._model.destroy();
    }
}
