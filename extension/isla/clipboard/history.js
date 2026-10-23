// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Clipboard history: listens to the clipboard, sorts what was copied into
// text, links, colors and images, never keeps the same thing twice (it moves
// up instead), keeps pinned entries apart from the 50-entry limit and saves
// it all in ~/.cache/isla-dock@frankm/clipboard (images as PNG files there).
// Skipped: what password managers mark (x-kde-passwordManagerHint) and texts
// longer than 100 000 characters.
//
// Signals: 'changed', 'captured' (something new was copied).
// Entry: {id, kind: 'text'|'link'|'color'|'image', value, file?, checksum?, time, pinned}
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {_, fmt} from '../i18n.js';

const MAX_UNPINNED = 50;
const MAX_TEXT = 100000;
const PASSWORD_HINT = 'x-kde-passwordManagerHint';
const IMAGE_MIME = 'image/png';
const SAVE_DELAY = 500;

const COLOR_RE = /^(#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla)\([^)]*\))$/i;
const LINK_RE = /^((https?:\/\/|www\.)\S+|[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?)$/i;

export function classify(text) {
    const t = text.trim();
    if (COLOR_RE.test(t))
        return 'color';
    if (LINK_RE.test(t))
        return 'link';
    return 'text';
}

export class ClipboardHistory extends Signals.EventEmitter {
    constructor(dir) {
        super();
        this._dir = dir;
        this._file = Gio.File.new_for_path(GLib.build_filenamev([dir, 'history.json']));
        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._items = [];
        this._echo = null;      // what we put on the clipboard ourselves: not a new entry
        this._saveId = 0;
        GLib.mkdir_with_parents(dir, 0o700);
        this._load();
        this._ownerId = this._selection.connect('owner-changed', (_s, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._onOwnerChanged();
        });
    }

    get items() {
        return this._items;
    }

    _onOwnerChanged() {
        const mimes = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
        if (mimes.includes(PASSWORD_HINT))
            return;
        if (mimes.includes(IMAGE_MIME)) {
            this._clipboard.get_content(St.ClipboardType.CLIPBOARD, IMAGE_MIME, (_c, bytes) => {
                if (this._clipboard && bytes?.get_size() > 0)
                    this._addImage(bytes);
            });
            return;
        }
        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (this._clipboard && text?.trim() && text.length <= MAX_TEXT)
                this._addText(text);
        });
    }

    _addText(text) {
        if (this._echo !== null && this._echo === text) {
            this._echo = null;
            return;
        }
        const old = this._items.find(i => i.kind !== 'image' && i.value === text);
        if (old)
            this._toTop(old);
        else
            this._items.unshift({id: GLib.uuid_string_random(), kind: classify(text), value: text, time: Date.now(), pinned: false});
        this._changed(true);
    }

    _addImage(bytes) {
        const checksum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA1, bytes);
        if (this._echo !== null && this._echo === checksum) {
            this._echo = null;
            return;
        }
        const old = this._items.find(i => i.kind === 'image' && i.checksum === checksum);
        if (old) {
            this._toTop(old);
            this._changed(true);
            return;
        }
        const path = GLib.build_filenamev([this._dir, `${checksum}.png`]);
        try {
            Gio.File.new_for_path(path).replace_contents(bytes.toArray(), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);
        } catch (e) {
            console.error(`isla-dock: no se pudo guardar la imagen copiada: ${e.message}`);
            return;
        }
        const when = GLib.DateTime.new_now_local().format('%H:%M');
        this._items.unshift({id: GLib.uuid_string_random(), kind: 'image', value: fmt(_('Imagen {hora}.png'), {hora: when}), file: path,
            checksum, time: Date.now(), pinned: false});
        this._changed(true);
    }

    // Puts an entry back on the clipboard (it moves up, it is not copied again).
    copy(id) {
        const item = this._items.find(i => i.id === id);
        if (!item)
            return false;
        if (item.kind === 'image') {
            try {
                const [, contents] = Gio.File.new_for_path(item.file).load_contents(null);
                this._echo = item.checksum;
                this._clipboard.set_content(St.ClipboardType.CLIPBOARD, IMAGE_MIME, new GLib.Bytes(contents));
            } catch (e) {
                console.error(`isla-dock: no se pudo leer la imagen: ${e.message}`);
                return false;
            }
        } else {
            this._echo = item.value;
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, item.value);
        }
        this._toTop(item);
        this._changed(false);
        return true;
    }

    togglePin(id) {
        const item = this._items.find(i => i.id === id);
        if (!item)
            return;
        item.pinned = !item.pinned;
        this._changed(false);
    }

    clearUnpinned() {
        this._items.filter(i => !i.pinned).forEach(i => this._deleteFile(i));
        this._items = this._items.filter(i => i.pinned);
        this._changed(false);
    }

    _toTop(item) {
        this._items = [item, ...this._items.filter(i => i !== item)];
        item.time = Date.now();
    }

    // Past 50 unpinned entries, the oldest go (with their image).
    _trim() {
        let unpinned = 0;
        this._items = this._items.filter(i => {
            if (i.pinned || ++unpinned <= MAX_UNPINNED)
                return true;
            this._deleteFile(i);
            return false;
        });
    }

    _deleteFile(item) {
        if (item.kind !== 'image' || !item.file)
            return;
        try {
            Gio.File.new_for_path(item.file).delete(null);
        } catch {}
    }

    _changed(captured) {
        this._trim();
        if (!this._saveId) {
            this._saveId = GLib.timeout_add(GLib.PRIORITY_LOW, SAVE_DELAY, () => {
                this._saveId = 0;
                this._save();
                return GLib.SOURCE_REMOVE;
            });
        }
        this.emit('changed');
        if (captured)
            this.emit('captured');
    }

    _save() {
        try {
            this._file.replace_contents(new TextEncoder().encode(JSON.stringify(this._items)), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);
        } catch (e) {
            console.error(`isla-dock: no se pudo guardar el historial del portapapeles: ${e.message}`);
        }
    }

    _load() {
        try {
            const [, contents] = this._file.load_contents(null);
            const list = JSON.parse(new TextDecoder().decode(contents));
            if (Array.isArray(list)) {
                this._items = list.filter(i => i?.id && typeof i.value === 'string' &&
                    (i.kind !== 'image' || GLib.file_test(i.file ?? '', GLib.FileTest.EXISTS)));
            }
        } catch {
            this._items = [];
        }
    }

    destroy() {
        this._selection.disconnect(this._ownerId);
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._save();
        }
        this._selection = null;
        this._clipboard = null;
        this.disconnectAll();
    }
}
