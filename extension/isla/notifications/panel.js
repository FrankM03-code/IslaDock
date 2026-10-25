// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The notification panel (notificaciones-isla-dock.md), top to bottom: the
// header ("Notificaciones", how many are unread, No molestar and the
// extension's settings), the filters (Todas · Mensajes · Sistema, with their
// counts), "Hoy" and "Anteriores" with one card per notice (the notices of one
// app in one card, its count spreads them), and a footer with "Historial" and
// "Limpiar todo". In do not disturb the list gives way to the duration chips
// and how many notices wait. The history is a second page of the same panel.
// A card (notificaciones-compactas.md): one row with the app's icon on its kind's
// tint, the app in its kind's color, the time, the title and the body in one line
// each, the app's first action at the right, × on hover; a right click shows the
// other actions.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {_, N_, fmt, ngettext} from '../i18n.js';
import {monthShort} from '../dates.js';

const FILTERS = [
    {key: 'all', label: N_('Todas')},
    {key: 'mensajes', label: N_('Mensajes')},
    {key: 'sistema', label: N_('Sistema')},
];
const DURATIONS = [['hora', N_('1 hora')], ['manana', N_('Hasta mañana')], ['siempre', N_('Siempre')]];

const startOfToday = () => {
    const now = GLib.DateTime.new_now_local();
    return GLib.DateTime.new_local(now.get_year(), now.get_month(), now.get_day_of_month(), 0, 0, 0).to_unix() * 1000;
};

// "ahora", "hace 2 min", "11:42", "ayer", "12 oct".
export function when(ms) {
    const minutes = Math.floor((Date.now() - ms) / 60000);
    if (minutes < 1)
        return _('ahora');
    if (minutes < 60)
        return fmt(_('hace {n} min'), {n: minutes});
    const then = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const today = startOfToday();
    if (ms >= today)
        return then.format('%H:%M');
    if (ms >= today - 86400000)
        return _('ayer');
    return `${then.get_day_of_month()} ${monthShort(then)}`;
}

const label = (style, text, props = {}) => new St.Label({style_class: style, text, ...props});

function icon(name, size, style = null) {
    return new St.Icon({icon_name: name, icon_size: size, style_class: style});
}

export class NotificationPanel {
    // dnd: {on, until (unix s, 0 always), mode ('hora'|'manana'|'siempre')}
    // on: {activate(id), action(id, i), dismiss(id), clearAll(), clearHistory(), dnd(value), settings(), resize()}
    // fresh: how many were unread when it opened (opening reads them all).
    constructor({store, dnd, on, maxHeight, fresh = 0}) {
        this._store = store;
        this._fresh = fresh;
        this._dnd = dnd;
        this._on = on;
        this._filter = 'all';
        this._page = 'list';
        this._open = new Set();     // apps whose notices are spread
        this.actor = new St.BoxLayout({style_class: 'isla-np', orientation: Clutter.Orientation.VERTICAL, reactive: true});
        this._header = new St.BoxLayout({style_class: 'isla-np-cabecera'});
        this._body = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'isla-np-cuerpo'});
        this._scroll = new St.ScrollView({style_class: 'isla-np-desplazar', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true, style: `max-height: ${maxHeight}px;`});
        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'isla-np-lista'});
        this._scroll.set_child(this._list);
        this._footer = new St.BoxLayout({style_class: 'isla-np-pie'});
        for (const actor of [this._header, this._body, this._footer])
            this.actor.add_child(actor);
        this._changedId = store.connect('changed', () => this.refresh());
        this.actor.connect('destroy', () => {
            store.disconnect(this._changedId);
            if (!this._scroll.get_parent())
                this._scroll.destroy();
        });
        this.refresh();
    }

    setDnd(dnd) {
        this._dnd = dnd;
        this.refresh();
    }

    refresh() {
        // The list (and its scroll) is kept: out of the body before the body is emptied.
        if (this._scroll.get_parent())
            this._body.remove_child(this._scroll);
        for (const box of [this._header, this._body, this._footer])
            box.destroy_all_children();
        this._list.destroy_all_children();
        if (this._page === 'history')
            this._fillHistory();
        else if (this._dnd.on)
            this._fillQuiet();
        else
            this._fillList();
        this._on.resize();
    }

    // ---------- header ----------
    _titles(title, subtitle) {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(label('isla-np-titulo', title));
        if (subtitle)
            box.add_child(label('isla-np-subtitulo', subtitle));
        this._header.add_child(box);
    }

    _headerButton(style, child, accessible, fn) {
        const button = new St.Button({style_class: style, child, can_focus: true, accessible_name: accessible,
            y_align: Clutter.ActorAlign.CENTER});
        button.connect('clicked', fn);
        this._header.add_child(button);
        return button;
    }

    _mainHeader() {
        const unread = Math.max(this._fresh, this._store.unread);
        this._titles(_('Notificaciones'), this._dnd.on ? null
            : unread ? fmt(ngettext('{n} sin leer', '{n} sin leer', unread), {n: unread}) : _('Todo leído'));
        const quiet = new St.BoxLayout({style_class: 'isla-np-boton-caja'});
        quiet.add_child(icon('weather-clear-night-symbolic', 15));
        quiet.add_child(label(null, this._dnd.on ? _('Activo') : _('No molestar'), {y_align: Clutter.ActorAlign.CENTER}));
        const button = this._headerButton(`isla-np-boton${this._dnd.on ? ' activo' : ''}`, quiet,
            this._dnd.on ? _('Quitar No molestar') : _('No molestar'), () => this._on.dnd(this._dnd.on ? 'off' : 'hora'));
        button.add_style_class_name('con-texto');
        this._headerButton('isla-np-boton', icon('preferences-system-symbolic', 16), _('Ajustes de notificaciones'),
            () => this._on.settings());
    }

    // ---------- the list ----------
    _fillList() {
        this._mainHeader();
        const entries = this._store.entries;
        const count = key => entries.filter(e => key === 'all' || (key === 'mensajes') === (e.kind === 'mensajes')).length;
        const chips = new St.BoxLayout({style_class: 'isla-np-filtros'});
        for (const f of FILTERS) {
            const chip = new St.Button({style_class: `isla-np-chip${this._filter === f.key ? ' activo' : ''}`,
                label: `${_(f.label)} · ${count(f.key)}`, can_focus: true});
            chip.connect('clicked', () => {
                this._filter = f.key;
                this.refresh();
            });
            chips.add_child(chip);
        }
        this._body.add_child(chips);
        const shown = entries.filter(e => this._filter === 'all' || (this._filter === 'mensajes') === (e.kind === 'mensajes'));
        if (!shown.length) {
            this._body.add_child(this._empty('object-select-symbolic', _('Todo al día'), _('No tienes avisos pendientes')));
        } else {
            const today = startOfToday();
            for (const [title, part] of [[_('Hoy'), shown.filter(e => e.time >= today)],
                [_('Anteriores'), shown.filter(e => e.time < today)]]) {
                if (!part.length)
                    continue;
                this._list.add_child(label('isla-np-seccion', title.toUpperCase()));
                for (const group of this._groups(part))
                    this._list.add_child(this._group(group, title !== _('Hoy')));
            }
            this._body.add_child(this._scroll);
        }
        const history = new St.Button({style_class: 'isla-np-enlace', label: _('Historial'), can_focus: true,
            x_expand: true, x_align: Clutter.ActorAlign.START});
        history.connect('clicked', () => {
            this._page = 'history';
            this.refresh();
        });
        this._footer.add_child(history);
        if (entries.length) {
            const clear = new St.Button({style_class: 'isla-np-limpiar', label: _('Limpiar todo'), can_focus: true});
            clear.connect('clicked', () => this._on.clearAll());
            this._footer.add_child(clear);
        }
    }

    // The notices of one app together, the newest first; groups by their newest.
    _groups(entries) {
        const groups = new Map();
        for (const e of entries) {
            const key = e.appId ?? e.appName;
            if (!groups.has(key))
                groups.set(key, []);
            groups.get(key).push(e);
        }
        return [...groups.values()];
    }

    // One card per app, its count by the time; a click on the count shows the others under it, another hides them.
    _group(group, older) {
        const key = group[0].appId ?? group[0].appName;
        if (group.length === 1)
            return this._card(group[0], {older});
        const open = this._open.has(key);
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'isla-np-grupo-abierto'});
        const shown = open ? group : group.slice(0, 1);
        shown.forEach((e, i) => box.add_child(this._card(e, {older, count: i ? 0 : group.length, group: i ? null : key})));
        return box;
    }

    // One row: icon | app · time (count), title, body (one line each) | the first action.
    // The other actions come out under the row with a right click.
    _card(entry, {older = false, count = 0, group = null, history = false}) {
        const card = new St.Button({style_class: `isla-np-tarjeta${older ? ' anterior' : ''}`,
            can_focus: true, x_expand: true, y_align: Clutter.ActorAlign.START,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE, accessible_name: `${entry.appName}: ${entry.title}`});
        const column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const row = new St.BoxLayout({style_class: 'isla-np-fila', x_expand: true});
        const tile = new St.Bin({style_class: `isla-np-icono ${entry.kind}`, y_align: Clutter.ActorAlign.CENTER});
        tile.set_child(new St.Icon({gicon: this._store.gicon(entry), icon_size: 18,
            fallback_icon_name: 'dialog-information-symbolic', style_class: 'isla-np-icono-app'}));
        row.add_child(tile);

        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'isla-np-texto',
            y_align: Clutter.ActorAlign.CENTER});
        const meta = new St.BoxLayout({style_class: 'isla-np-meta'});
        const app = label(`isla-np-app ${entry.kind}`, entry.appName || _('Sistema'), {y_align: Clutter.ActorAlign.CENTER});
        app.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        meta.add_child(app);
        meta.add_child(label('isla-np-hora', `·  ${when(entry.time)}`, {y_align: Clutter.ActorAlign.CENTER}));
        if (count > 1) {
            const counter = new St.Button({style_class: `isla-np-cuenta${this._open.has(group) ? ' abierta' : ''}`,
                label: String(count), can_focus: true, y_align: Clutter.ActorAlign.CENTER,
                accessible_name: this._open.has(group) ? _('Ver menos') : fmt(_('Ver {n} más'), {n: count - 1})});
            counter.connect('clicked', () => {
                if (!this._open.delete(group))
                    this._open.add(group);
                this.refresh();
            });
            meta.add_child(counter);
        }
        meta.add_child(new St.Widget({x_expand: true}));
        const close = new St.Button({style_class: 'isla-np-cerrar', child: icon('window-close-symbolic', 11), opacity: 0,
            can_focus: true, accessible_name: _('Descartar'), y_align: Clutter.ActorAlign.CENTER});
        if (!history) {
            close.connect('clicked', () => this._on.dismiss(entry.id));
            meta.add_child(close);
        }
        text.add_child(meta);
        for (const [style, value] of [['isla-np-titulo-aviso', entry.title], ['isla-np-cuerpo-aviso', entry.body]]) {
            if (!value)
                continue;
            const line = label(style, value.replace(/\s+/g, ' '));
            line.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(line);
        }
        row.add_child(text);

        const actions = entry.actions ?? [];
        const button = (name, i, style) => {
            const b = new St.Button({style_class: style, label: name, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
            b.connect('clicked', () => this._on.action(entry.id, i));
            return b;
        };
        if (actions.length)
            row.add_child(button(actions[0], 0, 'isla-np-accion'));
        column.add_child(row);
        let more = null;
        if (actions.length > 1) {
            more = new St.BoxLayout({style_class: 'isla-np-acciones', visible: false, x_align: Clutter.ActorAlign.END});
            actions.slice(1, 3).forEach((name, i) => more.add_child(button(name, i + 1, 'isla-np-accion segunda')));
            column.add_child(more);
        }
        card.set_child(column);
        card.connect('clicked', (_b, mouse) => {
            if (mouse === 3) {
                if (more)
                    more.visible = !more.visible;
                return;
            }
            this._on.activate(entry.id);
        });
        card.connect('notify::hover', () => close.ease({opacity: card.hover ? 255 : 0, duration: 120}));
        return card;
    }

    _empty(iconName, title, text) {
        const box = new St.BoxLayout({style_class: 'isla-np-vacio', orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER});
        const tile = new St.Bin({style_class: 'isla-np-vacio-icono', x_align: Clutter.ActorAlign.CENTER,
            child: icon(iconName, 24)});
        box.add_child(tile);
        box.add_child(label('isla-np-vacio-titulo', title, {x_align: Clutter.ActorAlign.CENTER}));
        if (text) {
            const t = label('isla-np-vacio-texto', text, {x_align: Clutter.ActorAlign.CENTER});
            t.clutter_text.line_wrap = true;
            box.add_child(t);
        }
        return box;
    }

    // ---------- do not disturb ----------
    _fillQuiet() {
        this._mainHeader();
        const chips = new St.BoxLayout({style_class: 'isla-np-filtros'});
        for (const [value, name] of DURATIONS) {
            const chip = new St.Button({style_class: `isla-np-chip${this._dnd.mode === value ? ' activo' : ''}`,
                label: _(name), can_focus: true});
            chip.connect('clicked', () => this._on.dnd(value));
            chips.add_child(chip);
        }
        this._body.add_child(chips);
        let title = _('Silencio activado');
        if (this._dnd.until) {
            const end = GLib.DateTime.new_from_unix_local(this._dnd.until);
            const tomorrow = end.get_day_of_month() !== GLib.DateTime.new_now_local().get_day_of_month();
            title = fmt(tomorrow ? _('Silencio hasta mañana a las {hora}') : _('Silencio hasta las {hora}'),
                {hora: end.format('%H:%M')});
        }
        const waiting = Math.max(this._fresh, this._store.unread);
        const text = waiting
            ? fmt(ngettext('{n} aviso guardado, lo verás al terminar.', '{n} avisos guardados, los verás al terminar.', waiting),
                {n: waiting})
            : _('Los avisos que lleguen te esperan aquí.');
        this._body.add_child(this._empty('weather-clear-night-symbolic', title, text));
    }

    // ---------- history ----------
    _fillHistory() {
        this._headerButton('isla-np-boton', icon('go-previous-symbolic', 16), _('Volver'), () => {
            this._page = 'list';
            this.refresh();
        });
        this._titles(_('Historial'), _('Avisos que ya descartaste'));
        const history = this._store.history;
        if (!history.length) {
            this._body.add_child(this._empty('document-open-recent-symbolic', _('Sin historial'), null));
            return;
        }
        history.forEach(e => this._list.add_child(this._card(e, {older: true, history: true})));
        this._body.add_child(this._scroll);
        const clear = new St.Button({style_class: 'isla-np-limpiar', label: _('Borrar historial'), can_focus: true,
            x_expand: true, x_align: Clutter.ActorAlign.END});
        clear.connect('clicked', () => this._on.clearHistory());
        this._footer.add_child(clear);
    }
}
