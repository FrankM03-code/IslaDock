// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Quick search (B2). A shortcut turns the island into a search field. As soon
// as something is typed it grows into a panel: the results on the left (a
// calculation, apps, recent files and their folders, in groups) and a preview
// of the selected one on the right. The selected row carries "Abrir carpeta"
// and "Copiar ruta". Arrows move, Enter opens, Esc clears and then closes.
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {FilePreview, previewable} from './filePreview.js';
import {Mode} from './state.js';
import {_, fmt, ngettext} from './i18n.js';
import {accentRGB} from './accent.js';
import {Thumbnails, badge, candidates, fileInfo, folderChildren, folderLabel, highlight, isImage, rank, recentFiles,
    relativeDate} from './searchFiles.js';

const MAX_APPS = 3;
const MAX_GROUP = 6;
const MAX_FOLDERS = 3;
const MAX_TOTAL = 12;
// Files looked up on disk for one search, at most.
const MAX_LOOKUPS = 60;
// Below this monitor width (logical px) the preview is left out.
const NARROW = 800;

// ---------- calculator: a small parser, never eval ----------
export function calculate(text) {
    const src = text.replace(/\s+/g, '').replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/');
    if (!/^[0-9+\-*/().]+$/.test(src) || !/\d/.test(src) || !/[+\-*/]/.test(src.replace(/^[-+]/, '')))
        return null;
    let i = 0;
    const peek = () => src[i];
    const fail = () => {
        throw new Error('expresión');
    };
    function number() {
        const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
        if (!m)
            fail();
        i += m[0].length;
        return parseFloat(m[0]);
    }
    function factor() {
        if (peek() === '-') {
            i++;
            return -factor();
        }
        if (peek() === '+') {
            i++;
            return factor();
        }
        if (peek() === '(') {
            i++;
            const v = expr();
            if (src[i++] !== ')')
                fail();
            return v;
        }
        return number();
    }
    function term() {
        let v = factor();
        while (peek() === '*' || peek() === '/') {
            const op = src[i++];
            const r = factor();
            v = op === '*' ? v * r : v / r;
        }
        return v;
    }
    function expr() {
        let v = term();
        while (peek() === '+' || peek() === '-') {
            const op = src[i++];
            const r = term();
            v = op === '+' ? v + r : v - r;
        }
        return v;
    }
    try {
        const value = expr();
        return i === src.length && Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

function formatNumber(v) {
    return String(+v.toPrecision(12)).replace('.', ',');
}

const hex = ([r, g, b]) => `#${[r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')}`;

// What a row does when it is opened.
const Kind = {CALC: 'calc', APP: 'app', FILE: 'file', FOLDER: 'folder', MORE: 'more', WEB: 'web'};
const hasPreview = previewable;

export class Search {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._results = [];
        this._rows = [];
        this._selected = -1;
        this._query = '';
        this._gen = 0;
        this._showPreview = true;
        this._timers = new Map();
        this._thumbs = new Thumbnails();
        this._buildActors();
        // When the shell shuts down the stage goes first: no timer may touch the actors after that.
        this._actor.connect('destroy', () => {
            this._timers.forEach(id => GLib.source_remove(id));
            this._timers.clear();
        });
        state.command('search-content', this._actor);
        Main.wm.addKeybinding('atajo-busqueda', settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.open());
        // The search field of the desktop bar (restBar.js), or the launcher handing over its text.
        this._commandId = state.connect('command', (_s, name, text) => {
            if (name !== 'search-open')
                return;
            if (this._state.mode !== Mode.SEARCH)
                this.open();
            if (text && this._state.mode === Mode.SEARCH) {
                this._entry.text = text;
                this._entry.clutter_text.set_cursor_position(-1);
            }
        });
        this._modeId = state.connect('mode-changed', (_s, mode, old) => {
            if (old === Mode.SEARCH && mode !== Mode.SEARCH)
                this._release();
        });
    }

    _buildActors() {
        this._actor = new St.BoxLayout({style_class: 'isla-busqueda', orientation: Clutter.Orientation.VERTICAL, reactive: true});

        // Above the field: the list on the left, the preview on the right.
        this._top = new St.BoxLayout({style_class: 'isla-busqueda-arriba', visible: false});
        this._scroll = new St.ScrollView({style_class: 'isla-busqueda-desplazar', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true, y_align: Clutter.ActorAlign.START});
        this._list = new St.BoxLayout({style_class: 'isla-busqueda-lista', orientation: Clutter.Orientation.VERTICAL,
            accessible_role: Atk.Role.LIST, accessible_name: _('Resultados')});
        this._scroll.set_child(this._list);
        this._top.add_child(this._scroll);
        this._vp = new FilePreview({onOpen: () => this._activate(this._selected)});
        this._preview = this._vp.actor;
        this._top.add_child(this._preview);

        const bar = new St.BoxLayout({style_class: 'isla-busqueda-barra'});
        this._lupa = new St.Icon({icon_name: 'system-search-symbolic', style_class: 'isla-busqueda-lupa',
            y_align: Clutter.ActorAlign.CENTER});
        bar.add_child(this._lupa);
        this._entry = new St.Entry({style_class: 'isla-busqueda-campo', hint_text: _('Buscar apps, archivos o hacer una cuenta…'),
            can_focus: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        bar.add_child(this._entry);
        this._hint = new St.Label({style_class: 'isla-busqueda-pista', text: _('Espacio: vista previa · ↵ abrir'),
            y_align: Clutter.ActorAlign.CENTER, visible: false});
        bar.add_child(this._hint);
        this._actor.add_child(this._top);
        this._actor.add_child(bar);

        this._tip = new St.Label({style_class: 'isla-tooltip', visible: false});
        Main.layoutManager.uiGroup.add_child(this._tip);

        const text = this._entry.clutter_text;
        text.connect('text-changed', () => this._onTextChanged());
        text.connect('key-press-event', (_t, event) => this._onKey(event));
        // A click outside the island closes the search.
        this._actor.connect('captured-event', (_a, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS)
                return Clutter.EVENT_PROPAGATE;
            const target = global.stage.get_event_actor(event);
            if (!this._actor.contains(target)) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    open() {
        if (this._state.mode === Mode.SEARCH) {
            this.close();
            return;
        }
        this._recentCancel?.cancel();
        this._recentCancel = new Gio.Cancellable();
        this._files = [];
        recentFiles(this._recentCancel, files => {
            this._files = files;
            if (this._state.mode === Mode.SEARCH && this._query)
                this._search(this._query);
        });
        this._showPreview = true;
        this._entry.text = '';
        this._onTextChanged();
        if (!this._state.setMode(Mode.SEARCH))
            return;
        this._grab = Main.pushModal(this._actor, {actionMode: Shell.ActionMode.POPUP});
        this._entry.grab_key_focus();
    }

    close() {
        if (this._state.mode === Mode.SEARCH)
            this._state.setMode(Mode.COLLAPSED);
        this._release();
        this._hideTip();
        this._cancelWork();
        this._later('shrink', 400, () => {
            if (this._state.mode !== Mode.SEARCH)
                this._setWide(false);
        });
    }

    _release() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    // ---------- timers ----------
    _later(name, delay, fn) {
        this._cancel(name);
        this._timers.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timers.delete(name);
            fn();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _cancel(name) {
        const id = this._timers.get(name);
        if (id)
            GLib.source_remove(id);
        this._timers.delete(name);
    }

    _cancelWork() {
        this._gen++;
        this._cancel('search');
        this._vp.cancel();
        this._searchCancel?.cancel();
    }

    // ---------- results ----------
    _onTextChanged() {
        const query = this._entry.text.trim();
        this._lupa[query ? 'add_style_class_name' : 'remove_style_class_name']('con-texto');
        if (query === this._query && query)
            return;
        this._query = query;
        if (!query) {
            this._cancelWork();
            this._results = [];
            this._drawList();
            return;
        }
        // The calculation and the apps right away; the files a moment after the last key.
        this._later('search', 120, () => this._search(query));
    }

    _quickItems(query) {
        const items = [];
        const value = calculate(query);
        if (value !== null) {
            const shown = formatNumber(value);
            items.push({kind: Kind.CALC, title: `= ${shown}`, subtitle: _('Enter copia el resultado'),
                icon: 'accessories-calculator-symbolic',
                run: () => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, shown)});
        }
        const appSystem = Shell.AppSystem.get_default();
        for (const id of Shell.AppSystem.search(query).flat()) {
            const app = appSystem.lookup_app(id);
            if (!app)
                continue;
            if (items.filter(i => i.kind === Kind.APP).length >= MAX_APPS)
                break;
            items.push({kind: Kind.APP, title: app.get_name(), subtitle: app.get_description() ?? '', gicon: app.get_icon(),
                path: app.get_app_info()?.get_filename() ?? '', run: () => app.activate()});
        }
        return items;
    }

    async _search(query) {
        const gen = ++this._gen;
        this._searchCancel?.cancel();
        const cancellable = this._searchCancel = new Gio.Cancellable();
        const matches = candidates(this._files ?? [])
            .map(path => ({path, rank: rank(GLib.path_get_basename(path), query)}))
            .filter(m => m.rank >= 0)
            .slice(0, MAX_LOOKUPS);
        const infos = await Promise.all(matches.map(async m => {
            const info = await fileInfo(m.path, cancellable);
            return info && {...info, rank: m.rank};
        }));
        if (gen !== this._gen)
            return;
        const found = infos.filter(Boolean)
            .sort((a, b) => a.rank - b.rank || b.mtime - a.mtime);
        const files = found.filter(f => !f.folder);
        const folders = found.filter(f => f.folder);
        const items = this._quickItems(query);
        const room = MAX_TOTAL - items.length;
        const fileRoom = Math.min(MAX_GROUP, Math.max(0, room - Math.min(folders.length, MAX_FOLDERS)));
        const add = (list, kind, max) => {
            list.slice(0, max).forEach(f => items.push({kind, ...f, title: f.name}));
            if (list.length > max) {
                items.push({kind: Kind.MORE, group: kind, title: fmt(_('Ver {n} más en Archivos'), {n: list.length - max}),
                    icon: 'view-more-horizontal-symbolic', run: () => this._searchInOverview(query)});
            }
        };
        add(files, Kind.FILE, fileRoom);
        add(folders, Kind.FOLDER, Math.min(MAX_FOLDERS, Math.max(0, MAX_TOTAL - items.length)));
        if (!items.length) {
            items.push({kind: Kind.WEB, title: fmt(_('Buscar “{texto}” en la web'), {texto: query}),
                icon: 'web-browser-symbolic', run: () => launchUri(`https://www.google.com/search?q=${encodeURIComponent(query)}`)});
        }
        this._results = items;
        this._drawList();
    }

    _searchInOverview(query) {
        Main.overview.show();
        Main.overview.searchEntry?.set_text(query);
    }

    // ---------- drawing ----------
    get _narrow() {
        const monitor = Main.layoutManager.findMonitorForActor(this._actor) ?? Main.layoutManager.primaryMonitor;
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return !monitor || monitor.width / sf < NARROW;
    }

    _setWide(wide) {
        if (wide === !!this._wide)
            return;
        this._wide = wide;
        this._actor[wide ? 'add_style_class_name' : 'remove_style_class_name']('con-resultados');
        this._hint.visible = wide;
        this._state.command('search-wide', wide);
    }

    _drawList() {
        this._hideTip();
        this._list.destroy_all_children();
        this._rows = [];
        const query = this._query;
        const wasShown = this._top.visible;
        if (!query) {
            this._top.visible = false;
            this._selected = -1;
            this._setWide(false);
            this._state.command('resize');
            return;
        }
        this._accent = hex(accentRGB());
        const only = this._results.length === 1 && this._results[0].kind === Kind.WEB;
        if (only) {
            this._list.add_child(new St.Label({style_class: 'isla-busqueda-vacio',
                text: fmt(_('Sin resultados para “{texto}”'), {texto: query})}));
        }
        let group = null;
        this._results.forEach((item, i) => {
            const kind = item.kind === Kind.MORE ? item.group : item.kind;
            if (kind !== group && [Kind.APP, Kind.FILE, Kind.FOLDER].includes(kind)) {
                const count = this._results.filter(r => r.kind === kind).length;
                this._list.add_child(this._header(kind, count));
            }
            group = kind;
            const row = this._row(item, i);
            this._rows.push(row);
            this._list.add_child(row);
        });
        this._selected = -1;
        this._top.visible = true;
        this._setWide(true);
        const showPreview = this._showPreview && !only && !this._narrow;
        this._preview.visible = showPreview;
        this._actor[showPreview ? 'remove_style_class_name' : 'add_style_class_name']('sin-vista');
        this._select(0);
        if (!wasShown) {
            this._top.opacity = 0;
            this._top.ease({opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._state.command('resize');
    }

    _header(kind, count) {
        const names = {[Kind.APP]: _('Aplicaciones'), [Kind.FILE]: _('Archivos'), [Kind.FOLDER]: _('Carpetas')};
        const box = new St.BoxLayout({style_class: 'isla-busqueda-seccion'});
        box.add_child(new St.Label({text: names[kind].toUpperCase(), x_expand: true}));
        box.add_child(new St.Label({text: String(count)}));
        return box;
    }

    _row(item, i) {
        const row = new St.BoxLayout({style_class: 'isla-fila', reactive: true, track_hover: true, x_expand: true,
            accessible_role: Atk.Role.LIST_ITEM, accessible_name: item.title});
        row.add_child(this._rowIcon(item));
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        const title = new St.Label({style_class: 'isla-fila-titulo'});
        if (item.kind === Kind.FILE || item.kind === Kind.FOLDER || item.kind === Kind.APP)
            title.clutter_text.set_markup(highlight(item.title, this._query, this._accent));
        else
            title.text = item.title;
        row._detail = new St.Label({style_class: 'isla-fila-detalle', text: this._detail(item, row)});
        for (const label of [title, row._detail])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row._detail.visible = !!row._detail.text;
        text.add_child(title);
        text.add_child(row._detail);
        row.add_child(text);
        if (hasPreview(item)) {
            row._buttons = this._rowButtons(item, i);
            row.add_child(row._buttons);
        }
        row.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._select(i);
            // Clutter events have no click count: two presses on the same row, close enough.
            const time = event.get_time();
            const last = this._lastPress;
            this._lastPress = {row, time};
            if (last?.row === row && time - last.time <= Clutter.Settings.get_default().double_click_time) {
                this._lastPress = null;
                this._activate(i);
            }
            return Clutter.EVENT_STOP;
        });
        row.connect('notify::hover', () => this._updateButtons(row, i));
        return row;
    }

    _rowIcon(item) {
        if (item.kind === Kind.FOLDER)
            return new St.Icon({icon_name: 'folder-symbolic', style_class: 'isla-fila-carpeta', y_align: Clutter.ActorAlign.CENTER});
        if (item.kind === Kind.FILE) {
            const {text, color} = badge(item.name);
            const page = new St.Bin({style_class: 'isla-fila-tipo', style: `background-color: ${color};`,
                y_align: Clutter.ActorAlign.CENTER, clip_to_allocation: true});
            page.set_child(new St.Label({text, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
            if (isImage(item.type))
                this._rowThumb(item, page);
            return page;
        }
        const icon = new St.Icon({style_class: 'isla-fila-icono', y_align: Clutter.ActorAlign.CENTER,
            fallback_icon_name: 'application-x-executable-symbolic'});
        if (item.gicon)
            icon.gicon = item.gicon;
        else
            icon.icon_name = item.icon ?? 'application-x-executable-symbolic';
        return icon;
    }

    // A picture shows itself in its row when its thumbnail is already made.
    async _rowThumb(item, page) {
        const gen = this._gen;
        const path = await this._thumbs.get({...item, readable: false}, this._searchCancel);
        if (!path || gen !== this._gen || !page.get_stage())
            return;
        page.style = 'background-color: transparent;';
        page.set_child(this._texture(path, 26, 32));
    }

    _detail(item, row) {
        if (item.kind === Kind.FILE)
            return `${folderLabel(item.dir)} · ${relativeDate(item.mtime)}`;
        if (item.kind === Kind.FOLDER) {
            folderChildren(item.path, 1000, this._searchCancel).then(children => {
                if (children && row.get_stage() && !row._missing)
                    row._detail.text = `${folderLabel(item.dir)} · ${fmt(ngettext('{n} elemento', '{n} elementos', children.length), {n: children.length})}`;
            });
            return folderLabel(item.dir);
        }
        return (item.subtitle ?? '').replace(/\s+/g, ' ');
    }

    _rowButtons(item, i) {
        const box = new St.BoxLayout({style_class: 'isla-fila-botones', y_align: Clutter.ActorAlign.CENTER, visible: false});
        const make = (icon, label, fn) => {
            const button = new St.Button({style_class: 'isla-fila-boton', can_focus: false, accessible_name: label,
                child: new St.Icon({icon_name: icon})});
            button._label = label;
            button.connect('clicked', () => fn(button));
            button.connect('notify::hover', () => (button.hover ? this._showTip(button, button._label) : this._hideTip()));
            box.add_child(button);
            return button;
        };
        if (item.kind !== Kind.APP)
            make('folder-open-symbolic', _('Abrir carpeta'), () => this._showInFolder(i));
        box._copy = make('edit-copy-symbolic', _('Copiar ruta'), () => this._copyPath(i));
        return box;
    }

    _updateButtons(row, i) {
        if (row._buttons)
            row._buttons.visible = i === this._selected || row.hover;
    }

    _select(i, scroll = false) {
        if (!this._rows.length) {
            this._selected = -1;
            this._schedulePreview();
            return;
        }
        i = Math.max(0, Math.min(this._rows.length - 1, i));
        const old = this._rows[this._selected];
        this._selected = i;
        if (old && old !== this._rows[i]) {
            old.remove_style_class_name('seleccionada');
            old.style = null;
            old.remove_accessible_state(Atk.StateType.SELECTED);
            this._updateButtons(old, this._rows.indexOf(old));
        }
        const row = this._rows[i];
        const [r, g, b] = accentRGB();
        row.add_style_class_name('seleccionada');
        row.style = `background-color: rgba(${r}, ${g}, ${b}, 0.10); border-color: rgb(${r}, ${g}, ${b});`;
        row.add_accessible_state(Atk.StateType.SELECTED);
        this._updateButtons(row, i);
        if (scroll)
            this._scrollTo(row);
        this._schedulePreview();
    }

    _scrollTo(row) {
        const adj = this._scroll.vadjustment;
        const box = row.get_allocation_box();
        // The first row brings its group's title along.
        if (row === this._rows[0])
            adj.value = 0;
        else if (box.y1 < adj.value)
            adj.value = box.y1;
        else if (box.y2 > adj.value + adj.page_size)
            adj.value = box.y2 - adj.page_size;
    }

    // ---------- preview ----------
    _schedulePreview() {
        this._vp.show(this._results[this._selected]);
    }

    // A picture loaded and scaled by the Shell's texture cache, off the main loop.
    _texture(path, width, height) {
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const actor = St.TextureCache.get_default().load_file_async(Gio.File.new_for_path(path), width, height, sf,
            this._actor.get_resource_scale?.() ?? 1);
        const bin = new St.Bin({x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER, child: actor});
        return bin;
    }

    _togglePreview() {
        this._showPreview = !this._showPreview;
        this._drawList();
    }

    // ---------- tooltip ----------
    _showTip(actor, text) {
        const capsule = this._capsuleOf(this._actor);
        const dark = capsule && (capsule.has_style_class_name('oscura') || capsule.has_style_class_name('isla-skin-aurora'));
        this._tip.style_class = `isla-tooltip${dark ? ' oscura' : ''}`;
        this._tip.text = text;
        this._tip.show();
        this._tip.get_parent().set_child_above_sibling(this._tip, null);
        const [x, y] = actor.get_transformed_position();
        const [w] = actor.get_transformed_size();
        const [, tw] = this._tip.get_preferred_width(-1);
        const [, th] = this._tip.get_preferred_height(tw);
        this._tip.set_position(Math.round(x + w / 2 - tw / 2), Math.round(y - th - 6));
    }

    _hideTip() {
        this._tip.hide();
    }

    _capsuleOf(actor) {
        for (let a = actor; a; a = a.get_parent()) {
            if (a.has_style_class_name?.('isla-capsule'))
                return a;
        }
        return null;
    }

    // ---------- actions ----------
    // The file may have moved or gone since the search: say so in its row and stay open.
    _stillThere(i) {
        const item = this._results[i];
        if (!item?.path || item.kind === Kind.APP || GLib.file_test(item.path, GLib.FileTest.EXISTS))
            return true;
        const row = this._rows[i];
        if (row) {
            row._missing = true;
            row._detail.text = _('No se encontró el archivo');
            row._detail.visible = true;
            row._detail.add_style_class_name('perdido');
        }
        return false;
    }

    _showInFolder(i) {
        const item = this._results[i];
        if (!item || !hasPreview(item) || item.kind === Kind.APP || !this._stillThere(i))
            return;
        this.close();
        Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1',
            'ShowItems', new GLib.Variant('(ass)', [[item.uri], '']), null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch {
                    launchUri(Gio.File.new_for_path(item.dir).get_uri());
                }
            });
    }

    _copyPath(i) {
        const item = this._results[i];
        if (!item?.path || !this._stillThere(i))
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, item.path);
        const button = this._rows[i]?._buttons?._copy;
        if (!button)
            return;
        button.child.icon_name = 'object-select-symbolic';
        button.add_style_class_name('copiado');
        button._label = _('Ruta copiada');
        if (button.hover)
            this._showTip(button, button._label);
        this._later(`copied-${i}`, 1200, () => {
            if (!button.get_stage())
                return;
            button.child.icon_name = 'edit-copy-symbolic';
            button.remove_style_class_name('copiado');
            button._label = _('Copiar ruta');
            if (button.hover)
                this._showTip(button, button._label);
        });
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        const mods = event.get_state();
        const ctrl = !!(mods & Clutter.ModifierType.CONTROL_MASK);
        const shift = !!(mods & Clutter.ModifierType.SHIFT_MASK);
        const alt = !!(mods & Clutter.ModifierType.MOD1_MASK);
        if (key === Clutter.KEY_Escape) {
            if (this._entry.text)
                this._entry.text = '';
            else
                this.close();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Up || key === Clutter.KEY_Down) {
            if (this._rows.length)
                this._select(this._selected + (key === Clutter.KEY_Down ? 1 : -1), true);
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter || key === Clutter.KEY_ISO_Enter) {
            if (ctrl)
                this._showInFolder(this._selected);
            else
                this._activate(this._selected);
            return Clutter.EVENT_STOP;
        }
        if (ctrl && shift && (key === Clutter.KEY_C || key === Clutter.KEY_c)) {
            this._copyPath(this._selected);
            return Clutter.EVENT_STOP;
        }
        if (alt && (key === Clutter.KEY_p || key === Clutter.KEY_P) && this._query) {
            this._togglePreview();
            return Clutter.EVENT_STOP;
        }
        // Space shows or hides the preview only after a space at the end; otherwise it types.
        if (key === Clutter.KEY_space && !ctrl && !alt && this._query) {
            const text = this._entry.clutter_text;
            const pos = text.get_cursor_position();
            const atEnd = pos === -1 || pos === text.text.length;
            if (atEnd && text.text.endsWith(' ') && text.get_selection() === '') {
                this._togglePreview();
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _activate(i) {
        const item = this._results[i];
        if (!item || !this._stillThere(i))
            return;
        this.close();
        try {
            if (item.run)
                item.run();
            else
                launchUri(item.uri);
        } catch (e) {
            Main.notifyError(_('No se pudo abrir'), e.message);
        }
    }

    destroy() {
        this._recentCancel?.cancel();
        this._cancelWork();
        for (const id of this._timers.values())
            GLib.source_remove(id);
        this._timers.clear();
        Main.wm.removeKeybinding('atajo-busqueda');
        this._state.disconnect(this._modeId);
        this.close();
        this._cancel('shrink');
        this._setWide(false);
        this._state.command('search-content', null);
        this._actor.destroy();
        this._tip.destroy();
        this._thumbs.destroy();
    }
}

function launchUri(uri) {
    Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
}
