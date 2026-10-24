// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Calendario: with the top bar hidden, GNOME's date menu cannot be opened.
// This is IslaDock's own small month calendar: the month with ‹ Hoy ›, a grid
// of day squares (the week starts on Monday; a dot marks days with reminders)
// and a card with the chosen day's reminders. The + turns the card into a
// short form: what to remember, its day and month, Guardar. Reminders live in
// 'recordatorios' (JSON) and are announced with a notification from 8:00 on
// their day (or as soon as IslaDock runs, if it was off then).
// The panel is solid: light over a light island, dark otherwise.
// It opens from the side clock (click) or with Super+M ('atajo-calendario'),
// which GNOME uses for the date menu ('toggle-message-tray'): while this runs
// that binding gives it up and gets it back after ('calendario-liberado').
// The panel stands by the side clock's edge, centered in height.
//
// Commands it listens to: 'calendar-toggle' (anchor actor or nothing).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {_, fmt, localName} from './i18n.js';
import {dressFrame, islandLook} from './look.js';
import {ms} from './timing.js';

const KEY = 'atajo-calendario';
const KEPT = 'calendario-liberado';
const NOTES = 'recordatorios';
const TRAY_SCHEMA = 'org.gnome.shell.keybindings';
const TRAY_KEY = 'toggle-message-tray';
const GAP = 14;            // from the screen edge
const IN_TIME = 200;
const OUT_TIME = 140;
const SHIFT = 14;
const NOTICE_HOUR = 8;     // reminders are announced from this hour of their day
const CHECK_EVERY = 60;    // seconds

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const capital = s => s.charAt(0).toLocaleUpperCase() + s.slice(1);
const format = (d, f) => GLib.DateTime.new_local(d.getFullYear(), d.getMonth() + 1, d.getDate(),
    d.getHours(), d.getMinutes(), 0).format(f);
const daysIn = (year, month) => new Date(year, month + 1, 0).getDate();
const noteDate = n => new Date(n.anio, n.mes - 1, n.dia);

export class CalendarPanel {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._panel = null;
        this._commandId = state.connect('command', (_s, name, ...args) => {
            if (name === 'calendar-toggle')
                this.toggle(args[0] ?? null);
        });
        this._overviewId = Main.overview.connect('showing', () => this.close(false));
        this._freeShortcut();
        Main.wm.addKeybinding(KEY, settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => {
                Main.overview.hide();
                this.toggle(null);
            });
        // Reminders due: now and every minute.
        this._checkId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CHECK_EVERY, () => {
            this._announce();
            return GLib.SOURCE_CONTINUE;
        });
        this._announce();
    }

    // ---------- Super+M, lent by GNOME ----------
    _freeShortcut() {
        try {
            this._tray = new Gio.Settings({schema_id: TRAY_SCHEMA});
        } catch {
            this._tray = null;
            return;
        }
        const ours = this._settings.get_strv(KEY);
        const current = this._tray.get_strv(TRAY_KEY);
        const taken = current.filter(a => ours.some(b => same(a, b)));
        if (!taken.length)
            return;
        const kept = this._settings.get_strv(KEPT);
        this._settings.set_strv(KEPT, [...new Set([...kept, ...taken])]);
        this._tray.set_strv(TRAY_KEY, current.filter(a => !taken.includes(a)));
    }

    _giveBackShortcut() {
        const taken = this._settings.get_strv(KEPT);
        if (!this._tray || !taken.length)
            return;
        const current = this._tray.get_strv(TRAY_KEY);
        const missing = taken.filter(a => !current.some(b => same(a, b)));
        if (missing.length)
            this._tray.set_strv(TRAY_KEY, [...current, ...missing]);
        this._settings.set_strv(KEPT, []);
    }

    // ---------- reminders ----------
    // [{id, texto, dia, mes (1-12), anio, avisado}]
    _notes() {
        try {
            const list = JSON.parse(this._settings.get_string(NOTES));
            return Array.isArray(list) ? list.filter(n => n && typeof n.texto === 'string') : [];
        } catch {
            return [];
        }
    }

    _saveNotes(list) {
        this._settings.set_string(NOTES, JSON.stringify(list));
    }

    _notesOn(date) {
        return this._notes().filter(n => sameDay(noteDate(n), date));
    }

    _announce() {
        const now = new Date();
        const today = dayStart(now);
        const list = this._notes();
        let changed = false;
        for (const note of list) {
            const day = noteDate(note);
            if (note.avisado || day > today || (sameDay(day, today) && now.getHours() < NOTICE_HOUR))
                continue;
            note.avisado = true;
            changed = true;
            Main.notify(_('Recordatorio'), note.texto);
        }
        if (changed)
            this._saveNotes(list);
    }

    // ---------- content ----------
    _build(look) {
        const box = new St.BoxLayout({style_class: 'isla-cal', vertical: true, reactive: true});
        if (look.light)
            box.add_style_class_name('clara');

        const head = new St.BoxLayout({style_class: 'isla-cal-enc'});
        const title = new St.BoxLayout({style_class: 'isla-cal-titulo', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._month = new St.Label({style_class: 'isla-cal-mes', y_align: Clutter.ActorAlign.END});
        this._year = new St.Label({style_class: 'isla-cal-anio', y_align: Clutter.ActorAlign.END});
        title.add_child(this._month);
        title.add_child(this._year);
        const controls = new St.BoxLayout({style_class: 'isla-cal-controles', y_align: Clutter.ActorAlign.CENTER});
        controls.add_child(this._arrow('go-previous-symbolic', _('Mes anterior'), () => this._moveMonth(-1)));
        const today = new St.Button({style_class: 'isla-cal-ctrl isla-cal-hoy', label: _('Hoy'), can_focus: true});
        today.connect('clicked', () => this._goToday());
        controls.add_child(today);
        controls.add_child(this._arrow('go-next-symbolic', _('Mes siguiente'), () => this._moveMonth(1)));
        head.add_child(title);
        head.add_child(controls);

        // Initials on row 0, days below; homogeneous columns.
        this._gridLayout = new Clutter.GridLayout({column_homogeneous: true, column_spacing: 4, row_spacing: 4});
        this._grid = new St.Widget({style_class: 'isla-cal-rejilla', layout_manager: this._gridLayout});
        for (let i = 0; i < 7; i++) {
            const label = new St.Label({style_class: 'isla-cal-ini', x_align: Clutter.ActorAlign.CENTER,
                text: localName(GLib.DateTime.new_local(2024, 1, 1 + i, 0, 0, 0), '%a').toLocaleUpperCase()});
            this._gridLayout.attach(label, i, 0, 1, 1);
        }

        // The card: the chosen day's reminders, or the form.
        this._card = new St.BoxLayout({style_class: 'isla-cal-tarjeta', vertical: true});

        box.add_child(head);
        box.add_child(this._grid);
        box.add_child(this._card);
        box.connect('scroll-event', (_a, event) => {
            if (this._form)
                return Clutter.EVENT_PROPAGATE;
            const dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.DOWN)
                this._moveMonth(dir === Clutter.ScrollDirection.UP ? -1 : 1);
            return Clutter.EVENT_STOP;
        });
        return box;
    }

    _arrow(icon, name, fn, small = false) {
        const b = new St.Button({style_class: `isla-cal-ctrl isla-cal-flecha${small ? ' pequena' : ''}`,
            accessible_name: name, can_focus: true, child: new St.Icon({icon_name: icon, style_class: 'isla-cal-flecha-icono'})});
        b.connect('clicked', fn);
        return b;
    }

    _goToday() {
        const now = new Date();
        this._shown = new Date(now.getFullYear(), now.getMonth(), 1);
        this._chosen = dayStart(now);
        this._form = null;
        this._paint();
    }

    _moveMonth(step) {
        this._shown = new Date(this._shown.getFullYear(), this._shown.getMonth() + step, 1);
        this._paint();
    }

    _paint() {
        const shown = this._shown;
        const now = new Date();
        this._month.text = capital(format(shown, '%B'));
        this._year.text = String(shown.getFullYear());
        for (const child of this._grid.get_children()) {
            if (child._day)
                child.destroy();
        }
        const marked = new Set(this._notes().map(n => noteDate(n).getTime()));
        const offset = (shown.getDay() + 6) % 7;      // Monday first
        const total = daysIn(shown.getFullYear(), shown.getMonth());
        for (let n = 1; n <= total; n++) {
            const date = new Date(shown.getFullYear(), shown.getMonth(), n);
            const inner = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER});
            inner.add_child(new St.Label({text: String(n), x_align: Clutter.ActorAlign.CENTER}));
            inner.add_child(new St.Widget({style_class: 'isla-cal-punto', x_align: Clutter.ActorAlign.CENTER,
                opacity: marked.has(date.getTime()) ? 255 : 0}));
            const day = new St.Button({style_class: 'isla-cal-dia', child: inner, can_focus: true, x_expand: true,
                accessible_name: format(date, '%A %-d %B')});
            day._day = date;
            if (date.getDay() === 0 || date.getDay() === 6)
                day.add_style_class_name('finde');
            if (sameDay(date, now))
                day.add_style_class_name('hoy');
            if (sameDay(date, this._chosen))
                day.add_style_class_name('elegido');
            day.connect('clicked', () => this._choose(date));
            const cell = offset + n - 1;
            this._gridLayout.attach(day, cell % 7, 1 + Math.floor(cell / 7), 1, 1);
        }
        this._paintCard();
    }

    // Only the marks move: the pressed button stays.
    _choose(date) {
        this._chosen = date;
        for (const child of this._grid.get_children()) {
            if (child._day)
                child[sameDay(child._day, date) ? 'add_style_class_name' : 'remove_style_class_name']('elegido');
        }
        if (this._form) {
            this._form.dia = date.getDate();
            this._form.mes = date.getMonth();
            this._form.anio = date.getFullYear();
            this._paintFormDate();
            return;
        }
        this._paintCard();
    }

    // The chosen day and its reminders (each with ×), and the +.
    _paintCard() {
        if (!this._card || this._form)
            return;
        this._card.destroy_all_children();
        const chosen = this._chosen;
        const top = new St.BoxLayout({style_class: 'isla-cal-tarjeta-fila'});
        const day = capital(format(chosen, _('%A %-d de %B')));
        top.add_child(new St.Label({style_class: 'isla-cal-sel', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            text: sameDay(chosen, new Date()) ? fmt(_('Hoy, {dia}'), {dia: day}) : day}));
        const add = new St.Button({style_class: 'isla-cal-mas', accessible_name: _('Nuevo recordatorio'), can_focus: true,
            y_align: Clutter.ActorAlign.CENTER, child: new St.Icon({icon_name: 'list-add-symbolic', style_class: 'isla-cal-mas-icono'})});
        add.connect('clicked', () => this._openForm());
        top.add_child(add);
        this._card.add_child(top);
        const notes = this._notesOn(chosen);
        if (!notes.length) {
            this._card.add_child(new St.Label({style_class: 'isla-cal-vacio', text: _('Sin recordatorios')}));
            return;
        }
        for (const note of notes) {
            const row = new St.BoxLayout({style_class: 'isla-cal-nota'});
            const text = new St.Label({style_class: 'isla-cal-nota-texto', text: note.texto, x_expand: true,
                y_align: Clutter.ActorAlign.CENTER});
            text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            const remove = new St.Button({style_class: 'isla-cal-quitar', accessible_name: _('Quitar recordatorio'),
                can_focus: true, child: new St.Icon({icon_name: 'window-close-symbolic', style_class: 'isla-cal-quitar-icono'})});
            remove.connect('clicked', () => {
                this._saveNotes(this._notes().filter(n => n.id !== note.id));
                this._paint();
            });
            row.add_child(text);
            row.add_child(remove);
            this._card.add_child(row);
        }
    }

    // ---------- the form ----------
    _openForm() {
        const c = this._chosen;
        this._form = {dia: c.getDate(), mes: c.getMonth(), anio: c.getFullYear()};
        this._card.destroy_all_children();
        this._entry = new St.Entry({style_class: 'isla-cal-campo', hint_text: _('¿Qué quieres recordar?'),
            can_focus: true, x_expand: true});
        this._entry.clutter_text.connect('activate', () => this._saveForm());
        this._card.add_child(this._entry);

        // Day and month, each with ‹ ›.
        const dates = new St.BoxLayout({style_class: 'isla-cal-fecha'});
        const stepper = (name, step) => {
            const box = new St.BoxLayout({style_class: 'isla-cal-paso', x_expand: true});
            const label = new St.Label({style_class: 'isla-cal-paso-valor', x_expand: true,
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            box.add_child(this._arrow('go-previous-symbolic', fmt(_('{campo} anterior'), {campo: name}), () => step(-1), true));
            box.add_child(label);
            box.add_child(this._arrow('go-next-symbolic', fmt(_('{campo} siguiente'), {campo: name}), () => step(1), true));
            dates.add_child(box);
            return label;
        };
        this._dayLabel = stepper(_('Día'), d => {
            const f = this._form;
            const max = daysIn(f.anio, f.mes);
            f.dia = (f.dia - 1 + d + max) % max + 1;
            this._paintFormDate();
        });
        this._monthLabel = stepper(_('Mes'), d => {
            const f = this._form;
            f.mes = (f.mes + d + 12) % 12;
            // Day and month only: the next time that date comes (today counts).
            const today = dayStart(new Date());
            f.anio = today.getFullYear();
            f.dia = Math.min(f.dia, daysIn(f.anio, f.mes));
            if (new Date(f.anio, f.mes, f.dia) < today)
                f.anio++;
            f.dia = Math.min(f.dia, daysIn(f.anio, f.mes));
            this._paintFormDate();
        });
        this._card.add_child(dates);

        const buttons = new St.BoxLayout({style_class: 'isla-cal-botones'});
        const cancel = new St.Button({style_class: 'isla-cal-boton', label: _('Cancelar'), can_focus: true, x_expand: true});
        cancel.connect('clicked', () => this._closeForm());
        const save = new St.Button({style_class: 'isla-cal-boton guardar', label: _('Guardar'), can_focus: true, x_expand: true});
        save.connect('clicked', () => this._saveForm());
        buttons.add_child(cancel);
        buttons.add_child(save);
        this._card.add_child(buttons);
        this._paintFormDate();
        this._entry.grab_key_focus();
    }

    _paintFormDate() {
        const f = this._form;
        this._dayLabel.text = String(f.dia);
        const month = capital(format(new Date(f.anio, f.mes, 1), '%B'));
        this._monthLabel.text = f.anio === new Date().getFullYear() ? month : `${month} ${f.anio}`;
    }

    _saveForm() {
        const text = this._entry?.get_text().trim();
        if (!text) {
            this._entry?.grab_key_focus();
            return;
        }
        const f = this._form;
        const list = this._notes();
        list.push({id: `${Date.now()}`, texto: text, dia: f.dia, mes: f.mes + 1, anio: f.anio, avisado: false});
        list.sort((a, b) => noteDate(a) - noteDate(b));
        this._saveNotes(list);
        // Show the day it was saved on.
        this._chosen = new Date(f.anio, f.mes, f.dia);
        this._shown = new Date(f.anio, f.mes, 1);
        this._closeForm();
        this._announce();
    }

    _closeForm() {
        this._form = null;
        this._entry = this._dayLabel = this._monthLabel = null;
        this._paint();
    }

    // ---------- open / close ----------
    toggle(anchor) {
        if (this._panel)
            this.close();
        else
            this.open(anchor);
    }

    open(anchor) {
        if (this._panel)
            return;
        // Still leaving: done now.
        this._finishClosing?.();
        const look = islandLook(this._state);
        const content = this._build(look);
        this._goToday();
        const panel = this._panel = new St.Widget({layout_manager: new Clutter.BinLayout(), reactive: true});
        // The island's color and transparency, like every other panel (and Aurora's halo).
        if (look.style)
            content.style = look.style;
        dressFrame(look, panel, content, 20);
        Main.layoutManager.addTopChrome(panel);
        this._place(anchor);
        panel.connect('captured-event', (_a, event) => this._onEvent(event));
        panel.connect('key-press-event', (_a, event) => {
            const key = event.get_key_symbol();
            if (!this._form && (key === Clutter.KEY_Page_Up || key === Clutter.KEY_Page_Down)) {
                this._moveMonth(key === Clutter.KEY_Page_Up ? -1 : 1);
                return Clutter.EVENT_STOP;
            }
            if (key !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            if (this._form)
                this._closeForm();
            else
                this.close();
            return Clutter.EVENT_STOP;
        });
        this._grab = Main.pushModal(panel, {actionMode: Shell.ActionMode.POPUP});
        // Over a maximized window drawn straight to the screen (X11).
        global.compositor.disable_unredirect();
        panel.set({opacity: 0, translation_x: this._fromRight ? SHIFT : -SHIFT});
        panel.ease({opacity: 255, translation_x: 0, duration: ms(IN_TIME), mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }

    // Next to the side clock's edge, centered in height, inside the work area.
    _place(anchor) {
        const panel = this._panel;
        const mon = Main.layoutManager.primaryMonitor;
        const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [, w] = panel.get_preferred_width(-1);
        const [, h] = panel.get_preferred_height(w);
        this._fromRight = this._settings.get_string('reloj-lateral-borde') !== 'izquierdo';
        let x = this._fromRight ? mon.x + mon.width - w - GAP * sf : mon.x + GAP * sf;
        if (anchor?.get_stage()) {
            const [ax] = anchor.get_transformed_position();
            const [aw] = anchor.get_transformed_size();
            x = this._fromRight ? ax - w - GAP * sf : ax + aw + GAP * sf;
        }
        x = Math.min(Math.max(x, area.x), area.x + area.width - w);
        const y = Math.min(Math.max(mon.y + (mon.height - h) / 2, area.y), area.y + area.height - h);
        panel.set_position(Math.round(x), Math.round(y));
    }

    _onEvent(event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        if (this._panel.contains(global.stage.get_event_actor(event)))
            return Clutter.EVENT_PROPAGATE;
        this.close();
        return Clutter.EVENT_STOP;
    }

    get isOpen() {
        return !!this._panel;
    }

    close(animate = true) {
        const panel = this._panel;
        if (!panel)
            return;
        this._panel = null;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        global.compositor.enable_unredirect();
        panel.reactive = false;
        this._form = null;
        this._card = this._grid = this._gridLayout = this._month = this._year = null;
        this._entry = this._dayLabel = this._monthLabel = null;
        const done = () => {
            if (this._finishClosing !== done)
                return;
            this._finishClosing = null;
            panel.remove_all_transitions();
            Main.layoutManager.removeChrome(panel);
            panel.destroy();
        };
        this._finishClosing = done;
        if (animate) {
            panel.ease({opacity: 0, translation_x: this._fromRight ? SHIFT : -SHIFT, duration: ms(OUT_TIME),
                mode: Clutter.AnimationMode.EASE_IN_QUAD, onStopped: done});
        } else {
            done();
        }
    }

    destroy() {
        this.close(false);
        GLib.source_remove(this._checkId);
        this._state.disconnect(this._commandId);
        Main.overview.disconnect(this._overviewId);
        Main.wm.removeKeybinding(KEY);
        this._giveBackShortcut();
    }
}
