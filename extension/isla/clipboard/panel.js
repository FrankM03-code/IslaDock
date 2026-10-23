// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The clipboard panel, top to bottom: search (with the shortcut as a hint),
// a segmented filter on one dark track (the active segment shows its name),
// the "Fijados" and "Recientes" lists (five recent rows, the rest scroll) and
// a footer with the status and "Borrar no fijados".
// A click (or Enter) on a row copies it and asks to close; the pin shows on
// hover, and stays amber on pinned entries.
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

const FILTERS = [
    {key: 'all', label: 'Todo', icon: 'view-app-grid-symbolic'},
    {key: 'text', label: 'Texto', icon: 'format-justify-left-symbolic'},
    {key: 'link', label: 'Enlaces', icon: 'insert-link-symbolic'},
    {key: 'image', label: 'Imágenes', icon: 'image-x-generic-symbolic'},
    {key: 'color', label: 'Colores', icon: 'color-select-symbolic'},
];
const KIND_ICONS = {text: 'format-justify-left-symbolic', link: 'insert-link-symbolic'};
const RECENT_VISIBLE = 5;
const ROW_HEIGHT = 50;
const STATUS_TIME = 1800;
const IDLE_STATUS = 'Clic para copiar';
// Looks like a command or code: shown in a monospace font.
const CODE_RE = /^(sudo|git|npm|cd|ls|cat|grep|journalctl|gsettings|flatpak|apt|dnf|python3?|node)\b|[{};]|=>|\$\(|&&|\|\|/;

export function timeAgo(ms) {
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60)
        return 'ahora';
    const m = Math.floor(s / 60);
    if (m < 60)
        return `hace ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24)
        return `hace ${h} h`;
    const d = Math.floor(h / 24);
    return d === 1 ? 'ayer' : `hace ${d} días`;
}

// '<Super>v' -> 'Super+V'
export function shortcutLabel(accel) {
    if (!accel)
        return '';
    const mods = [...accel.matchAll(/<(\w+)>/g)].map(m => ({Primary: 'Ctrl', Control: 'Ctrl'}[m[1]] ?? m[1]));
    const key = accel.replace(/<\w+>/g, '');
    return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+');
}

export class ClipboardPanel {
    // on: {copy(item), close(), tooltip(actor, text)}
    constructor({history, shortcut, on}) {
        this._history = history;
        this._on = on;
        this._filter = 'all';
        this._query = '';
        this._rows = [];
        this._statusId = 0;
        this.actor = new St.BoxLayout({style_class: 'isla-clip-panel', orientation: Clutter.Orientation.VERTICAL,
            reactive: true});
        this._buildSearch(shortcut);
        this._buildFilters();
        this._buildList();
        this._buildFooter();
        this._changedId = history.connect('changed', () => this.refresh());
        this.actor.connect('destroy', () => this._onDestroy());
        this.refresh();
    }

    get entry() {
        return this._entry;
    }

    _buildSearch(shortcut) {
        const box = new St.BoxLayout({style_class: 'isla-clip-busqueda'});
        box.add_child(new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'isla-clip-lupa', y_align: Clutter.ActorAlign.CENTER}));
        this._entry = new St.Entry({style_class: 'isla-clip-campo', hint_text: 'Buscar en el portapapeles', can_focus: true,
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._entry.clutter_text.connect('text-changed', () => {
            this._query = this._entry.text.toLowerCase();
            this.refresh();
        });
        box.add_child(this._entry);
        if (shortcut) {
            box.add_child(new St.Label({text: shortcut, style_class: 'isla-clip-atajo', y_align: Clutter.ActorAlign.CENTER}));
        }
        this.actor.add_child(box);
    }

    _buildFilters() {
        const track = new St.BoxLayout({style_class: 'isla-clip-segmento'});
        this._segments = FILTERS.map(f => {
            const content = new St.BoxLayout({style_class: 'isla-clip-seg-contenido', x_align: Clutter.ActorAlign.CENTER});
            content.add_child(new St.Icon({icon_name: f.icon, style_class: 'isla-clip-seg-icono', y_align: Clutter.ActorAlign.CENTER}));
            const label = new St.Label({text: f.label, y_align: Clutter.ActorAlign.CENTER});
            content.add_child(label);
            const button = new St.Button({style_class: 'isla-clip-seg', accessible_name: f.label, can_focus: true,
                track_hover: true, child: content});
            button.connect('clicked', () => {
                this._filter = f.key;
                this.refresh();
            });
            this._on.tooltip(button, f.label, () => button.has_style_pseudo_class('checked'));
            track.add_child(button);
            return {key: f.key, button, label};
        });
        this.actor.add_child(track);
    }

    _buildList() {
        this._scroll = new St.ScrollView({style_class: 'isla-clip-scroll', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true});
        this._list = new St.BoxLayout({style_class: 'isla-clip-lista', orientation: Clutter.Orientation.VERTICAL});
        this._scroll.set_child(this._list);
        this.actor.add_child(this._scroll);
    }

    _buildFooter() {
        const footer = new St.BoxLayout({style_class: 'isla-clip-pie'});
        this._status = new St.Label({text: IDLE_STATUS, style_class: 'isla-clip-estado', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        footer.add_child(this._status);
        const content = new St.BoxLayout({style_class: 'isla-clip-borrar-contenido'});
        content.add_child(new St.Icon({icon_name: 'user-trash-symbolic', style_class: 'isla-clip-borrar-icono',
            y_align: Clutter.ActorAlign.CENTER}));
        content.add_child(new St.Label({text: 'Borrar no fijados', y_align: Clutter.ActorAlign.CENTER}));
        this._clear = new St.Button({style_class: 'isla-clip-borrar', can_focus: true, child: content});
        this._clear.connect('clicked', () => this._history.clearUnpinned());
        footer.add_child(this._clear);
        this.actor.add_child(footer);
    }

    get filter() {
        return this._filter;
    }

    setFilter(key) {
        this._filter = key;
        this.refresh();
    }

    refresh() {
        for (const s of this._segments) {
            const on = s.key === this._filter;
            s.label.visible = on;
            s.button.x_expand = on;
            if (on)
                s.button.add_style_pseudo_class('checked');
            else
                s.button.remove_style_pseudo_class('checked');
        }
        const focused = this._rows.findIndex(r => r.has_key_focus());
        this._list.destroy_all_children();
        this._rows = [];
        const shown = this._history.items.filter(i => (this._filter === 'all' || i.kind === this._filter) &&
            i.value.toLowerCase().includes(this._query));
        this._clear.visible = this._history.items.some(i => !i.pinned);
        if (!shown.length) {
            const empty = this._history.items.length ? 'Sin resultados' : 'Copia algo y aparecerá aquí';
            this._list.add_child(new St.Label({text: empty, style_class: 'isla-clip-vacio', x_align: Clutter.ActorAlign.CENTER}));
            this._scroll.style = null;
            this._keepFocus();
            return;
        }
        const pinned = shown.filter(i => i.pinned);
        const recent = shown.filter(i => !i.pinned);
        if (pinned.length)
            this._section('Fijados', pinned);
        if (recent.length)
            this._section('Recientes', recent);
        // Every pinned row and five recent ones; the rest scroll.
        const rows = pinned.length + Math.min(recent.length, RECENT_VISIBLE);
        const titles = (pinned.length ? 1 : 0) + (recent.length ? 1 : 0);
        this._scroll.style = `max-height: ${rows * ROW_HEIGHT + titles * 26}px;`;
        if (focused >= 0)
            this.focusRow(Math.min(focused, this._rows.length - 1));
        this._keepFocus();
    }

    // A row that had the keyboard was rebuilt (a pin, a new copy): back to the search.
    _keepFocus() {
        const focus = global.stage.get_key_focus();
        if (this.actor.mapped && (!focus || !this.actor.contains(focus)))
            this._entry.grab_key_focus();
    }

    _section(title, items) {
        this._list.add_child(new St.Label({text: title, style_class: 'isla-clip-seccion'}));
        for (const item of items) {
            const row = this._row(item);
            this._list.add_child(row);
            this._rows.push(row);
        }
    }

    _row(item) {
        const box = new St.BoxLayout({style_class: 'isla-clip-fila-contenido', x_expand: true});
        box.add_child(this._thumb(item));
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const value = new St.Label({text: item.value.replace(/\s+/g, ' ').trim(), style_class: 'isla-clip-valor'});
        value.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        if (item.kind === 'text' && CODE_RE.test(item.value.trim()))
            value.add_style_class_name('mono');
        text.add_child(value);
        text.add_child(new St.Label({text: timeAgo(item.time), style_class: 'isla-clip-tiempo'}));
        box.add_child(text);
        const pin = new St.Button({style_class: 'isla-clip-pin', can_focus: false, y_align: Clutter.ActorAlign.CENTER,
            accessible_name: item.pinned ? 'Desfijar' : 'Fijar', opacity: item.pinned ? 255 : 0,
            child: new St.Icon({icon_name: 'view-pin-symbolic', style_class: 'isla-clip-pin-icono'})});
        if (item.pinned)
            pin.add_style_pseudo_class('checked');
        pin.connect('clicked', () => this._history.togglePin(item.id));
        box.add_child(pin);
        const row = new St.Button({style_class: 'isla-clip-fila', can_focus: true, track_hover: true, x_expand: true,
            accessible_name: item.value.slice(0, 80), child: box});
        const lit = () => {
            if (!item.pinned)
                pin.opacity = row.hover || row.has_key_focus() ? 255 : 0;
        };
        for (const signal of ['notify::hover', 'key-focus-in', 'key-focus-out'])
            row.connect(signal, lit);
        row.connect('clicked', () => this._copy(item));
        row.item = item;
        return row;
    }

    _thumb(item) {
        const thumb = new St.Bin({style_class: `isla-clip-miniatura ${item.kind}`, y_align: Clutter.ActorAlign.CENTER});
        if (item.kind === 'color') {
            thumb.style = `background-color: ${item.value.trim()};`;
        } else if (item.kind === 'image') {
            const uri = `file://${item.file}`;
            thumb.style = `background-image: url("${uri}"); background-size: cover;`;
        } else {
            thumb.set_child(new St.Icon({icon_name: KIND_ICONS[item.kind], style_class: 'isla-clip-miniatura-icono',
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
        }
        return thumb;
    }

    _copy(item) {
        if (!this._on.copy(item))
            return;
        const flat = item.value.replace(/\s+/g, ' ').trim();
        this.showStatus(`Copiado: ${flat.length > 28 ? `${flat.slice(0, 28)}…` : flat}`);
        this._on.close();
    }

    showStatus(text) {
        this._status.text = text;
        this._clearStatus();
        this._statusId = setTimeout(() => {
            this._statusId = 0;
            this._status.text = IDLE_STATUS;
        }, STATUS_TIME);
    }

    _clearStatus() {
        if (this._statusId)
            clearTimeout(this._statusId);
        this._statusId = 0;
    }

    get rows() {
        return this._rows;
    }

    focusRow(index) {
        const row = this._rows[index];
        if (!row)
            return;
        row.grab_key_focus();
        // Keep it in sight inside the scroll.
        const adj = this._scroll.vadjustment;
        const [, y] = row.get_transformed_position();
        const [, sy] = this._scroll.get_transformed_position();
        const top = y - sy;
        if (top < 0)
            adj.value += top;
        else if (top + row.height > this._scroll.height)
            adj.value += top + row.height - this._scroll.height;
    }

    // Up / Down walk the rows (Up from the first goes back to the search), Enter copies.
    navigate(symbol) {
        const focus = global.stage.get_key_focus();
        const i = this._rows.indexOf(focus);
        if (symbol === Clutter.KEY_Down || symbol === Clutter.KEY_Up) {
            if (!this._rows.length)
                return true;
            const next = symbol === Clutter.KEY_Down ? Math.min(i + 1, this._rows.length - 1) : i - 1;
            if (next < 0)
                this._entry.grab_key_focus();
            else
                this.focusRow(next);
            return true;
        }
        if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter].includes(symbol)) {
            if (i >= 0)
                this._copy(this._rows[i].item);
            else if (focus === this._entry.clutter_text && this._rows.length)
                this._copy(this._rows[0].item);
            else if (focus instanceof St.Button)
                focus.emit('clicked', 1);
            return true;
        }
        return false;
    }

    _onDestroy() {
        this._clearStatus();
        this._history.disconnect(this._changedId);
        this._history = null;
    }
}
