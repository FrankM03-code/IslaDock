// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Quick search (B2). A shortcut turns the island into a search field with up to
// five results above it: apps, a calculation, and recent files. Arrows move,
// Enter opens, Esc (or clicking elsewhere) closes.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Mode} from './state.js';
import {_} from './i18n.js';

const MAX_RESULTS = 5;
const MAX_FILES = 3;

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

// Recent files from GTK's history (~/.local/share/recently-used.xbel), newest
// first. Read without blocking the Shell: done(files) is called when ready.
function recentFiles(cancellable, done) {
    const file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']));
    file.load_contents_async(cancellable, (f, res) => {
        let bytes;
        try {
            [, bytes] = f.load_contents_finish(res);
        } catch {
            return;
        }
        done(parseRecent(new TextDecoder().decode(bytes)));
    });
}

function parseRecent(xml) {
    try {
        const files = [];
        for (const m of xml.matchAll(/<bookmark\s[^>]*href="([^"]+)"[^>]*modified="([^"]+)"/g)) {
            const uri = m[1].replace(/&amp;/g, '&');
            if (!uri.startsWith('file://'))
                continue;
            files.push({uri, modified: m[2]});
        }
        files.sort((a, b) => b.modified.localeCompare(a.modified));
        return files.map(f => {
            const file = Gio.File.new_for_uri(f.uri);
            return {uri: f.uri, name: file.get_basename(), dir: file.get_parent()?.get_path() ?? ''};
        });
    } catch {
        return [];
    }
}

export class Search {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._results = [];
        this._selected = 0;
        this._buildActors();
        state.command('search-content', this._actor);
        Main.wm.addKeybinding('atajo-busqueda', settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.open());
        this._modeId = state.connect('mode-changed', (_s, mode, old) => {
            if (old === Mode.SEARCH && mode !== Mode.SEARCH)
                this._release();
        });
    }

    _buildActors() {
        this._actor = new St.BoxLayout({style_class: 'isla-busqueda', orientation: Clutter.Orientation.VERTICAL, reactive: true});
        this._list = new St.BoxLayout({style_class: 'isla-resultados', orientation: Clutter.Orientation.VERTICAL});
        const bar = new St.BoxLayout({style_class: 'isla-busqueda-barra'});
        bar.add_child(new St.Icon({icon_name: 'system-search-symbolic', style_class: 'isla-busqueda-lupa',
            y_align: Clutter.ActorAlign.CENTER}));
        this._entry = new St.Entry({style_class: 'isla-busqueda-campo', hint_text: _('Buscar apps, archivos o hacer una cuenta…'),
            can_focus: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        bar.add_child(this._entry);
        this._actor.add_child(this._list);
        this._actor.add_child(bar);
        const text = this._entry.clutter_text;
        text.connect('text-changed', () => this._update());
        text.connect('key-press-event', (_t, event) => this._onKey(event));
        text.connect('activate', () => this._activate(this._selected));
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
            if (this._state.mode === Mode.SEARCH)
                this._update();
        });
        this._entry.text = '';
        this._update();
        if (!this._state.setMode(Mode.SEARCH))
            return;
        this._grab = Main.pushModal(this._actor, {actionMode: Shell.ActionMode.POPUP});
        this._entry.grab_key_focus();
    }

    close() {
        if (this._state.mode === Mode.SEARCH)
            this._state.setMode(Mode.COLLAPSED);
        this._release();
    }

    _release() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    // ---------- results ----------
    _update() {
        const query = this._entry.text.trim();
        const results = [];
        if (query) {
            const value = calculate(query);
            if (value !== null) {
                const shown = formatNumber(value);
                results.push({title: `= ${shown}`, subtitle: _('Enter copia el resultado'), icon: 'accessories-calculator-symbolic',
                    run: () => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, shown)});
            }
            const appSystem = Shell.AppSystem.get_default();
            const ids = Shell.AppSystem.search(query).flat();
            for (const id of ids) {
                const app = appSystem.lookup_app(id);
                if (!app || results.length >= MAX_RESULTS)
                    continue;
                results.push({title: app.get_name(), subtitle: app.get_description() ?? '', gicon: app.get_icon(),
                    run: () => app.activate()});
            }
            const lower = query.toLowerCase();
            let files = 0;
            for (const f of this._files ?? []) {
                if (results.length >= MAX_RESULTS || files >= MAX_FILES)
                    break;
                if (!f.name.toLowerCase().includes(lower))
                    continue;
                files++;
                const [type] = Gio.content_type_guess(f.name, null);
                results.push({title: f.name, subtitle: f.dir.replace(GLib.get_home_dir(), '~'), gicon: Gio.content_type_get_icon(type),
                    run: () => Gio.AppInfo.launch_default_for_uri(f.uri, global.create_app_launch_context(0, -1))});
            }
        }
        this._results = results.slice(0, MAX_RESULTS);
        this._selected = 0;
        this._draw();
    }

    _draw() {
        this._list.destroy_all_children();
        this._results.forEach((r, i) => {
            const row = new St.Button({style_class: `isla-resultado${i === this._selected ? ' seleccionado' : ''}`,
                can_focus: false, x_expand: true});
            const box = new St.BoxLayout({x_expand: true});
            const icon = new St.Icon({style_class: 'isla-resultado-icono', y_align: Clutter.ActorAlign.CENTER,
                fallback_icon_name: 'application-x-executable-symbolic'});
            if (r.gicon)
                icon.gicon = r.gicon;
            else
                icon.icon_name = r.icon ?? 'application-x-executable-symbolic';
            box.add_child(icon);
            const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
            const title = new St.Label({style_class: 'isla-resultado-titulo', text: r.title});
            const subtitle = new St.Label({style_class: 'isla-resultado-detalle', text: r.subtitle.replace(/\s+/g, ' ')});
            for (const label of [title, subtitle])
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            subtitle.visible = !!subtitle.text;
            text.add_child(title);
            text.add_child(subtitle);
            box.add_child(text);
            row.set_child(box);
            row.connect('clicked', () => this._activate(i));
            row.connect('notify::hover', () => {
                if (row.hover && this._selected !== i) {
                    this._selected = i;
                    this._restyle();
                }
            });
            this._list.add_child(row);
        });
        this._list.visible = this._results.length > 0;
        this._state.command('resize');
    }

    _restyle() {
        this._list.get_children().forEach((row, i) =>
            row.style_class = `isla-resultado${i === this._selected ? ' seleccionado' : ''}`);
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Up || key === Clutter.KEY_Down) {
            const n = this._results.length;
            if (n) {
                this._selected = (this._selected + (key === Clutter.KEY_Down ? 1 : -1) + n) % n;
                this._restyle();
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _activate(i) {
        const r = this._results[i];
        if (!r)
            return;
        this.close();
        try {
            r.run();
        } catch (e) {
            Main.notifyError(_('No se pudo abrir'), e.message);
        }
    }

    destroy() {
        this._recentCancel?.cancel();
        Main.wm.removeKeybinding('atajo-busqueda');
        this._state.disconnect(this._modeId);
        this.close();
        this._state.command('search-content', null);
        this._actor.destroy();
    }
}
