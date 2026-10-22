// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The Downloads folder, newest first. Reads it in batches without blocking the
// Shell, watches it (300 ms debounce) and tells apart downloads in progress
// (*.part, *.crdownload...) shown under their final name.
//
// Signals:
//   'changed'            the list was read again
//   'finished' (entry)   a download in progress turned into its final file
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const ATTRIBUTES = 'standard::name,standard::display-name,standard::content-type,standard::icon,standard::is-hidden,' +
    'standard::type,standard::size,time::modified,time::created,thumbnail::path';
const BATCH = 50;
const DEBOUNCE = 300;
export const PARTIAL_DOWNLOAD = /\.(part|crdownload|download|partial|opdownload)$/i;

export function downloadsDir(settings) {
    const own = settings.get_string('stack-folder');
    if (own)
        return own;
    return GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ??
        GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
}

// Firefox: "name.ext.part" (and an empty "name.ext") · Chrome: "name.ext.crdownload".
function finalName(name) {
    return name.replace(PARTIAL_DOWNLOAD, '').replace(/^Unconfirmed \d+$/, 'Descarga');
}

export class DownloadsModel extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this.files = [];          // the newest, up to the largest view maximum
        this.total = 0;           // every visible entry in the folder
        this.lastOpened = GLib.get_real_time() / 1e6;
        this._partials = new Map();   // final name -> entry
        this._timer = 0;
        this._ids = ['stack-folder', 'stack-grid-max', 'stack-cascade-max'].map(key =>
            settings.connect(`changed::${key}`, () => (key === 'stack-folder' ? this._watch() : this._queue())));
        this._watch();
    }

    get folder() {
        return this._folder;
    }

    get busy() {
        return this.files.some(f => f.partial);
    }

    // New files since the stack was last opened.
    get fresh() {
        return this.files.some(f => !f.partial && f.time > this.lastOpened);
    }

    markSeen() {
        this.lastOpened = GLib.get_real_time() / 1e6;
    }

    _watch() {
        this._monitor?.cancel();
        this._monitor = null;
        this._folder = downloadsDir(this._settings);
        this._partials.clear();
        this._first = true;
        try {
            this._monitor = Gio.File.new_for_path(this._folder).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.connect('changed', () => this._queue());
        } catch {}
        this.refresh();
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

    get _keep() {
        return Math.max(this._settings.get_int('stack-grid-max'), this._settings.get_int('stack-cascade-max'));
    }

    refresh() {
        this._cancellable?.cancel();
        const cancellable = this._cancellable = new Gio.Cancellable();
        const dir = Gio.File.new_for_path(this._folder);
        const found = [];
        let total = 0;
        dir.enumerate_children_async(ATTRIBUTES, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable, (_d, res) => {
            let en;
            try {
                en = dir.enumerate_children_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._done([], 0);
                return;
            }
            const next = () => en.next_files_async(BATCH, GLib.PRIORITY_LOW, cancellable, (_e, r) => {
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
                        this._done(found, total);
                    return;
                }
                for (const info of infos) {
                    const name = info.get_name();
                    if (info.get_is_hidden() || name.startsWith('.'))
                        continue;
                    total++;
                    found.push(this._entry(dir, info));
                }
                // Only the newest are kept, so a folder with thousands of files stays light.
                if (found.length > this._keep * 4) {
                    found.sort((a, b) => b.time - a.time);
                    found.length = this._keep * 2;
                }
                next();
            });
            next();
        });
    }

    _entry(dir, info) {
        const name = info.get_name();
        const file = dir.get_child(name);
        const created = info.get_attribute_uint64('time::created');
        const time = created || info.get_attribute_uint64('time::modified');
        const partial = PARTIAL_DOWNLOAD.test(name);
        const isDir = info.get_file_type() === Gio.FileType.DIRECTORY;
        const thumb = info.get_attribute_byte_string('thumbnail::path');
        let gicon = null;
        if (thumb && GLib.file_test(thumb, GLib.FileTest.EXISTS))
            gicon = new Gio.FileIcon({file: Gio.File.new_for_path(thumb)});
        gicon ??= info.get_icon();
        return {
            file, name,
            uri: file.get_uri(),
            path: file.get_path(),
            display: partial ? finalName(info.get_display_name()) : info.get_display_name(),
            gicon,
            thumb: !!thumb && gicon instanceof Gio.FileIcon,
            isDir, partial, time,
            size: info.get_size(),
            progress: null,
        };
    }

    _done(found, total) {
        // Firefox keeps an empty final file next to the .part: show only the download.
        const partialNames = new Set(found.filter(f => f.partial).map(f => f.display));
        let list = found.filter(f => f.partial || !partialNames.has(f.name));
        total -= found.length - list.length;
        list.sort((a, b) => b.time - a.time);
        list = list.slice(0, this._keep);

        // A download that was in progress and now exists under its final name.
        const now = new Map(list.filter(f => f.partial).map(f => [f.display, f]));
        if (!this._first) {
            for (const name of this._partials.keys()) {
                if (now.has(name))
                    continue;
                const done = list.find(f => !f.partial && f.name === name);
                if (done)
                    this.emit('finished', done);
            }
        }
        this._partials = now;
        this._first = false;
        this.files = list;
        this.total = total;
        this.emit('changed');
    }

    destroy() {
        this._ids.forEach(id => this._settings.disconnect(id));
        this._ids = [];
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._cancellable?.cancel();
        this._monitor?.cancel();
        this._monitor = null;
        this.disconnectAll();
    }
}
