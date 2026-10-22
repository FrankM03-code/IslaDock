// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Finds the icon of each dock item. Order:
//   1. map.json aliases  (~/.icons/isla-dock/map.json, ~/.icons/map.json, <extension>/icons/map.json)
//   2. loose files named after the app (<id>.svg / .png) in ~/.icons/isla-dock, ~/.icons, <extension>/icons
//   3. the dock's icon theme (Preferences) or the system theme when it lives in ~/.icons
//   4. the app's own icon (app.get_icon())
// Folders are watched, so an icon dropped in ~/.icons shows up without reloading.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {USER_ICONS, USER_DOCK_ICONS, findIconTheme, indexIconTheme} from './iconThemes.js';

const REFRESH_DELAY = 300;   // ms, to group the burst of events of a copy
const GENERIC = new Set(['desktop', 'app', 'application', 'client', 'gtk', 'qt', 'studio']);

export class IconResolver extends Signals.EventEmitter {
    constructor(extensionDir, settings) {
        super();
        this._settings = settings;
        this._dirs = [USER_DOCK_ICONS, USER_ICONS, extensionDir.get_child('icons').get_path()];
        this._monitors = new Map();
        this._refreshId = 0;
        this._load();
        this._settingsIds = [settings.connect('changed::tema-iconos', () => this._queueRefresh())];
        this._stSettingsId = St.Settings.get().connect('notify::gtk-icon-theme', () => this._queueRefresh());
    }

    // Returns a Gio.Icon. `names` are extra names to try (e.g. the app's themed icon names).
    lookup(key, fallback, names = []) {
        if (this._cache.has(key))
            return this._cache.get(key) ?? fallback;
        // Full names ("org.gnome.nautilus") and, for the user's own files only, the
        // short one ("nautilus"); generic tails like "desktop" are never used.
        const full = [...new Set([key, ...names].filter(Boolean).map(n => n.toLowerCase()))];
        const short = full.map(n => n.split('.').pop()).filter(n => n.length > 2 && !GENERIC.has(n) && !full.includes(n));
        const icon = this._fromMap([...full, ...short]) ?? this._fromFiles([...full, ...short]) ?? this._fromTheme(full);
        this._cache.set(key, icon);
        return icon ?? fallback;
    }

    _fromMap(candidates) {
        for (const c of candidates) {
            const entry = this._map.get(c);
            if (!entry)
                continue;
            const {value, dir} = entry;
            if (GLib.path_is_absolute(value) && GLib.file_test(value, GLib.FileTest.EXISTS))
                return Gio.FileIcon.new(Gio.File.new_for_path(value));
            const rel = GLib.build_filenamev([dir, value]);
            if (GLib.file_test(rel, GLib.FileTest.EXISTS))
                return Gio.FileIcon.new(Gio.File.new_for_path(rel));
            // A name without a file: look it up like an app name.
            const named = this._fromFiles([value.toLowerCase()]) ?? this._fromTheme([value.toLowerCase()]);
            if (named)
                return named;
            return new Gio.ThemedIcon({name: value});
        }
        return null;
    }

    _fromFiles(candidates) {
        for (const listing of this._listings) {
            for (const c of candidates) {
                const path = listing.get(c);
                if (path)
                    return Gio.FileIcon.new(Gio.File.new_for_path(path));
            }
        }
        return null;
    }

    _fromTheme(candidates) {
        if (!this._themeIndex)
            return null;
        for (const c of candidates) {
            const hit = this._themeIndex.get(c);
            if (hit)
                return Gio.FileIcon.new(Gio.File.new_for_path(hit.path));
        }
        return null;
    }

    _listDir(path) {
        const files = new Map();
        let en;
        try {
            en = Gio.File.new_for_path(path).enumerate_children('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            return files;
        }
        let info;
        while ((info = en.next_file(null))) {
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                continue;
            const m = info.get_name().match(/^(.*)\.(svg|png)$/i);
            if (!m)
                continue;
            const name = m[1].toLowerCase();
            // SVG wins over PNG.
            if (!files.has(name) || m[2].toLowerCase() === 'svg')
                files.set(name, GLib.build_filenamev([path, info.get_name()]));
        }
        en.close(null);
        return files;
    }

    _loadMap() {
        const map = new Map();
        // Extension first, user files override it.
        for (const dir of [...this._dirs].reverse()) {
            const path = GLib.build_filenamev([dir, 'map.json']);
            try {
                const [ok, bytes] = GLib.file_get_contents(path);
                if (!ok)
                    continue;
                const data = JSON.parse(new TextDecoder().decode(bytes));
                for (const [k, v] of Object.entries(data)) {
                    if (typeof v === 'string' && v)
                        map.set(k.replace(/\.desktop$/i, '').toLowerCase(), {value: v, dir});
                }
            } catch (e) {
                if (!(e instanceof GLib.Error && e.matches(GLib.FileError, GLib.FileError.NOENT)))
                    console.warn(`isla-dock: no se pudo leer ${path}: ${e.message}`);
            }
        }
        return map;
    }

    _themePath() {
        const chosen = this._settings.get_string('tema-iconos');
        if (chosen)
            return findIconTheme(chosen);
        // The system theme is indexed only when it lives in the user's folders
        // (GNOME already resolves themes installed system-wide).
        const system = findIconTheme(St.Settings.get().gtk_icon_theme);
        const home = GLib.get_home_dir();
        return system && system.startsWith(home) ? system : null;
    }

    // The user's folders are small and read at once; the theme is indexed in the
    // background and the dock is told ('changed') when it is ready.
    _load() {
        this._cache = new Map();
        this._listings = this._dirs.map(d => this._listDir(d));
        this._map = this._loadMap();
        this._watch([...this._dirs, ...this._themeDirs ?? []]);
        this._indexCancel?.cancel();
        const themePath = this._themePath();
        if (!themePath) {
            this._themeIndex = null;
            this._themeDirs = [];
            return;
        }
        const cancellable = this._indexCancel = new Gio.Cancellable();
        indexIconTheme(themePath, cancellable).then(({index, appDirs}) => {
            if (cancellable.is_cancelled())
                return;
            this._themeIndex = index;
            this._themeDirs = appDirs;
            this._cache = new Map();
            this._watch([...this._dirs, ...appDirs]);
            this.emit('changed');
        }).catch(() => {});
    }

    _watch(paths) {
        const wanted = new Set(paths);
        for (const [path, {monitor, id}] of this._monitors) {
            if (wanted.has(path))
                continue;
            monitor.disconnect(id);
            monitor.cancel();
            this._monitors.delete(path);
        }
        for (const path of wanted) {
            if (this._monitors.has(path) || !GLib.file_test(path, GLib.FileTest.IS_DIR))
                continue;
            try {
                const monitor = Gio.File.new_for_path(path).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
                const id = monitor.connect('changed', () => this._queueRefresh());
                this._monitors.set(path, {monitor, id});
            } catch (e) {
                console.warn(`isla-dock: no se puede vigilar ${path}: ${e.message}`);
            }
        }
    }

    _queueRefresh() {
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_LOW, REFRESH_DELAY, () => {
            this._refreshId = 0;
            this._load();
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._indexCancel?.cancel();
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
        this._watch([]);
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        St.Settings.get().disconnect(this._stSettingsId);
        this._cache = new Map();
    }
}
