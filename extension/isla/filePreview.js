// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The preview card of a search result, shared by the quick search (search.js) and the
// launcher (launcher.js): a picture, the first lines of a text, a PDF's first page, a
// folder's first icons or an app's big icon, then its name, path, size, date and "Abrir ↵".
// Items: {kind: 'app' | 'file' | 'folder', title, subtitle, path, uri, gicon, size, mtime, type, readable}.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {_, fmt, ngettext} from './i18n.js';
import {Thumbnails, absoluteDate, folderChildren, isPdf, isText, pdfPages, shortPath, textHead} from './searchFiles.js';

const DELAY = 80;               // ms after the selection stops moving

export const previewable = item => ['app', 'file', 'folder'].includes(item?.kind);

export class FilePreview {
    constructor({onOpen, openButton = true}) {
        this._thumbs = new Thumbnails();
        this._timer = 0;
        const actor = this.actor = new St.BoxLayout({style_class: 'isla-vp', orientation: Clutter.Orientation.VERTICAL});
        this._body = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_expand: true});
        this._frame = new St.Bin({style_class: 'isla-vp-marco', x_align: Clutter.ActorAlign.CENTER, clip_to_allocation: true});
        this._name = new St.Label({style_class: 'isla-vp-nombre'});
        this._path = new St.Label({style_class: 'isla-vp-ruta'});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._meta = new St.BoxLayout({style_class: 'isla-vp-datos', orientation: Clutter.Orientation.VERTICAL});
        const metaRow = label => {
            const row = new St.BoxLayout({style_class: 'isla-vp-dato'});
            const key = new St.Label({style_class: 'isla-vp-etiqueta', text: label});
            const value = new St.Label({style_class: 'isla-vp-valor', x_expand: true});
            value.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(key);
            row.add_child(value);
            this._meta.add_child(row);
            return {key, value};
        };
        this._size = metaRow(_('Tamaño'));
        this._date = metaRow(_('Modificado'));
        const open = new St.Button({style_class: 'isla-vp-abrir', label: _('Abrir ↵'), can_focus: false, x_expand: true,
            y_align: Clutter.ActorAlign.END, y_expand: true});
        open.connect('clicked', () => onOpen());
        open.visible = openButton;
        for (const child of [this._frame, this._name, this._path, this._meta, open])
            this._body.add_child(child);
        actor.add_child(this._body);
        actor.connect('destroy', () => {
            this.cancel();
            this._thumbs.destroy();
        });
    }

    // Shown a moment after the last change of selection; null leaves it empty.
    show(item) {
        this.cancel();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DELAY, () => {
            this._timer = 0;
            this._fill(item).catch(logError);
            return GLib.SOURCE_REMOVE;
        });
    }

    cancel() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    async _fill(item) {
        if (!this.actor.visible)
            return;
        this._body.opacity = previewable(item) ? 255 : 0;
        if (!previewable(item))
            return;
        const cancellable = this._cancellable = new Gio.Cancellable();
        const live = () => !cancellable.is_cancelled() && !!this.actor.get_stage();
        const app = item.kind === 'app';
        const folder = item.kind === 'folder';
        this._name.text = item.title;
        const path = this._path.clutter_text;
        path.line_wrap = app;
        path.ellipsize = app ? Pango.EllipsizeMode.END : Pango.EllipsizeMode.MIDDLE;
        this._path.text = app ? item.subtitle ?? '' : shortPath(item.path);
        this._meta.visible = !app;
        this._size.key.text = folder ? _('Contenido') : _('Tamaño');
        this._size.value.text = folder ? '…' : GLib.format_size(item.size);
        this._date.value.text = absoluteDate(item.mtime);
        this._frame.set_child(new St.Widget({style_class: 'isla-vp-esqueleto', x_expand: true, y_expand: true}));

        if (app) {
            this._frame.set_child(this._bigIcon(item.gicon));
            return;
        }
        if (folder) {
            const children = await folderChildren(item.path, 1000, cancellable);
            if (!live())
                return;
            this._size.value.text = children ? fmt(ngettext('{n} elemento', '{n} elementos', children.length), {n: children.length}) : '—';
            this._frame.set_child(children?.length ? this._grid(children.slice(0, 6)) : this._bigIcon(null, 'folder-symbolic'));
            return;
        }
        if (isPdf(item.type) && item.readable) {
            pdfPages(item.path, cancellable).then(pages => {
                if (pages && live())
                    this._size.value.text = `${GLib.format_size(item.size)} · ${fmt(ngettext('{n} página', '{n} páginas', pages), {n: pages})}`;
            });
        }
        if (isText(item.type) && item.readable) {
            const head = await textHead(item.path, 15, cancellable);
            if (!live())
                return;
            if (head !== null) {
                this._frame.set_child(new St.Label({style_class: 'isla-vp-texto', text: head, x_expand: true, y_expand: true}));
                return;
            }
        }
        const thumb = await this._thumbs.get(item, cancellable);
        if (!live())
            return;
        this._frame.set_child(thumb ? this.texture(thumb, 170, 210) : this._bigIcon(item.gicon));
    }

    // A picture loaded and scaled by the Shell's texture cache, off the main loop.
    texture(path, width, height) {
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const actor = St.TextureCache.get_default().load_file_async(Gio.File.new_for_path(path), width, height, sf,
            this.actor.get_resource_scale?.() ?? 1);
        return new St.Bin({x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER, child: actor});
    }

    _bigIcon(gicon, name = 'text-x-generic') {
        const icon = new St.Icon({style_class: 'isla-vp-icono', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            fallback_icon_name: 'text-x-generic', x_expand: true, y_expand: true});
        if (gicon)
            icon.gicon = gicon;
        else
            icon.icon_name = name;
        return icon;
    }

    _grid(children) {
        const grid = new St.BoxLayout({style_class: 'isla-vp-rejilla', orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        for (let k = 0; k < children.length; k += 3) {
            const line = new St.BoxLayout({style_class: 'isla-vp-rejilla-fila'});
            for (const child of children.slice(k, k + 3))
                line.add_child(new St.Icon({gicon: child.gicon, style_class: 'isla-vp-rejilla-icono'}));
            grid.add_child(line);
        }
        return grid;
    }
}
