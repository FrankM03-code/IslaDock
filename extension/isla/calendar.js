// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Calendario: with the top bar hidden, GNOME's date menu cannot be opened.
// This is IslaDock's own small month calendar: the month with ‹ Hoy ›, a grid
// of day squares (the week starts on Monday; a dot marks days with reminders)
// and a card with the chosen day's reminders. The + turns the card into a
// short form: what to remember, its day, month, hour and minutes, Guardar.
// Reminders live in 'recordatorios' (JSON). At their time an alarm rings (the
// theme's alarm sound, again and again for up to a minute) with a notification
// that stays; clicking or closing it (or opening the calendar) stops the alarm. One missed while IslaDock
// was off is only announced. Old reminders without a time count as 8:00.
// The panel is solid: light over a light island, dark otherwise.
// It opens from the side clock (click) or with Super+M ('atajo-calendario'),
// which GNOME uses for the date menu ('toggle-message-tray'): while this runs
// that binding gives it up and gets it back after ('calendario-liberado').
// The panel comes out of the middle of the dock: it grows up from the island
// (scale and rise, with a small overshoot) and sinks back into it on closing.
// Its bottom stays above the dock: when it grows (more reminders, the form) it
// moves up; past a few reminders their list scrolls.
//
// Commands it listens to: 'calendar-toggle'.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {_, fmt, localName} from './i18n.js';
import {dressFrame, islandLook} from './look.js';
import {dockMonitor, dockWorkArea} from './monitor.js';
import {ms} from './timing.js';

const KEY = 'atajo-calendario';
const KEPT = 'calendario-liberado';
const NOTES = 'recordatorios';
const TRAY_SCHEMA = 'org.gnome.shell.keybindings';
const TRAY_KEY = 'toggle-message-tray';
const GAP = 10;            // between the island and the panel
const IN_TIME = 240;
const OUT_TIME = 120;
const RISE = 28;           // px it comes up from the dock
const SMALL = 0.82;        // the scale it grows from
const CELLS = 42;          // six weeks of day squares, made once and reused
const NOTICE_HOUR = 8;     // the time of old reminders saved without one
const CHECK_EVERY = 60;    // seconds, at most, between two looks at the reminders
const RING_EVERY = 3;      // seconds between two rings of the alarm
const RING_FOR = 60;       // seconds the alarm rings if nobody stops it
const LATE = 10 * 60;      // seconds: a reminder missed by more is only announced
const MINUTE_STEP = 5;

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const capital = s => s.charAt(0).toLocaleUpperCase() + s.slice(1);
const format = (d, f) => GLib.DateTime.new_local(d.getFullYear(), d.getMonth() + 1, d.getDate(),
    d.getHours(), d.getMinutes(), 0).format(f);
const daysIn = (year, month) => new Date(year, month + 1, 0).getDate();
const noteDate = n => new Date(n.anio, n.mes - 1, n.dia);
const noteTime = n => new Date(n.anio, n.mes - 1, n.dia, n.hora ?? NOTICE_HOUR, n.minuto ?? 0);
const two = n => String(n).padStart(2, '0');

export class CalendarPanel {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._panel = null;
        this._commandId = state.connect('command', (_s, name, ...args) => {
            if (name === 'calendar-toggle')
                this.toggle();
        });
        this._overviewId = Main.overview.connect('showing', () => this.close(false));
        this._freeShortcut();
        Main.wm.addKeybinding(KEY, settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => {
                Main.overview.hide();
                this.toggle(null);
            });
        this._checkId = 0;
        this._rings = new Set();
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

    // Due reminders now; then a wake-up at the next one's minute (or within a
    // minute anyway: after a suspend the clock may have jumped).
    _announce() {
        const now = new Date();
        const list = this._notes();
        let changed = false;
        let next = CHECK_EVERY * 1000;
        for (const note of list) {
            if (note.avisado)
                continue;
            const due = noteTime(note) - now;
            if (due > 0) {
                next = Math.min(next, due);
                continue;
            }
            note.avisado = true;
            changed = true;
            this._alarm(note, -due / 1000 <= LATE);
        }
        if (changed) {
            this._saveNotes(list);
            if (this._panel && !this._form)
                this._paintCard();
        }
        if (this._checkId)
            GLib.source_remove(this._checkId);
        this._checkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(250, next + 50), () => {
            this._checkId = 0;
            this._announce();
            return GLib.SOURCE_REMOVE;
        });
    }

    // A notification that stays until it is dealt with; with `ring`, the alarm
    // sounds until then (or RING_FOR seconds).
    _alarm(note, ring) {
        if (!this._source) {
            this._source = new MessageTray.Source({title: _('Recordatorios'), iconName: 'alarm-symbolic'});
            this._source.connect('destroy', () => (this._source = null));
            Main.messageTray.add(this._source);
        }
        const hour = `${two(note.hora ?? NOTICE_HOUR)}:${two(note.minuto ?? 0)}`;
        const notification = new MessageTray.Notification({source: this._source, title: _('Recordatorio'),
            body: `${hour} · ${note.texto}`, urgency: ring ? MessageTray.Urgency.CRITICAL : MessageTray.Urgency.NORMAL});
        this._source.addNotification(notification);
        if (!ring)
            return;
        const player = global.display.get_sound_player();
        const ringing = {cancellable: new Gio.Cancellable(), id: 0, left: Math.ceil(RING_FOR / RING_EVERY)};
        const stop = () => {
            if (!this._rings.delete(ringing))
                return;
            ringing.cancellable.cancel();
            if (ringing.id)
                GLib.source_remove(ringing.id);
            ringing.id = 0;
        };
        ringing.stop = stop;
        this._rings.add(ringing);
        const once = () => player.play_from_theme('alarm-clock-elapsed', _('Recordatorio'), ringing.cancellable);
        once();
        ringing.id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RING_EVERY, () => {
            if (--ringing.left <= 0) {
                ringing.id = 0;
                stop();
                return GLib.SOURCE_REMOVE;
            }
            once();
            return GLib.SOURCE_CONTINUE;
        });
        notification.connect('activated', stop);
        notification.connect('destroy', stop);
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
        // The day squares stay put; a month change only rewrites them.
        this._cells = [];
        for (let i = 0; i < CELLS; i++) {
            const inner = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER});
            const number = new St.Label({x_align: Clutter.ActorAlign.CENTER});
            const mark = new St.Widget({style_class: 'isla-cal-punto', x_align: Clutter.ActorAlign.CENTER});
            inner.add_child(number);
            inner.add_child(mark);
            const day = new St.Button({style_class: 'isla-cal-dia', child: inner, can_focus: true, x_expand: true});
            day._number = number;
            day._mark = mark;
            day._day = null;
            day.connect('clicked', () => day._day && this._choose(day._day));
            this._gridLayout.attach(day, i % 7, 1 + Math.floor(i / 7), 1, 1);
            this._cells.push(day);
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
        const marked = new Set(this._notes().map(n => noteDate(n).getTime()));
        const offset = (shown.getDay() + 6) % 7;      // Monday first
        const total = daysIn(shown.getFullYear(), shown.getMonth());
        this._cells.forEach((day, i) => {
            const n = i - offset + 1;
            if (n < 1 || n > total) {
                day._day = null;
                day.hide();
                return;
            }
            const date = new Date(shown.getFullYear(), shown.getMonth(), n);
            day._day = date;
            day._number.text = String(n);
            day._mark.opacity = marked.has(date.getTime()) ? 255 : 0;
            day.accessible_name = format(date, '%A %-d %B');
            const weekend = date.getDay() === 0 || date.getDay() === 6;
            day[weekend ? 'add_style_class_name' : 'remove_style_class_name']('finde');
            day[sameDay(date, now) ? 'add_style_class_name' : 'remove_style_class_name']('hoy');
            day[sameDay(date, this._chosen) ? 'add_style_class_name' : 'remove_style_class_name']('elegido');
            day.show();
        });
        this._paintCard();
    }

    // Only the marks move: the pressed button stays.
    _choose(date) {
        this._chosen = date;
        for (const day of this._cells) {
            if (day._day)
                day[sameDay(day._day, date) ? 'add_style_class_name' : 'remove_style_class_name']('elegido');
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
        // A few fit; past that the list scrolls (the panel would cover the screen).
        const list = new St.BoxLayout({style_class: 'isla-cal-notas-caja', vertical: true});
        const scroll = new St.ScrollView({style_class: 'isla-cal-notas', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true, child: list});
        for (const note of notes) {
            const row = new St.BoxLayout({style_class: 'isla-cal-nota'});
            row.add_child(new St.Label({style_class: 'isla-cal-nota-hora', y_align: Clutter.ActorAlign.CENTER,
                text: `${two(note.hora ?? NOTICE_HOUR)}:${two(note.minuto ?? 0)}`}));
            const text = new St.Label({style_class: 'isla-cal-nota-texto', text: note.texto, x_expand: true,
                y_align: Clutter.ActorAlign.CENTER});
            text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            const remove = new St.Button({style_class: 'isla-cal-quitar', accessible_name: _('Quitar recordatorio'),
                can_focus: true, child: new St.Icon({icon_name: 'window-close-symbolic', style_class: 'isla-cal-quitar-icono'})});
            remove.connect('clicked', () => {
                this._saveNotes(this._notes().filter(n => n.id !== note.id));
                this._paint();
                this._announce();
            });
            row.add_child(text);
            row.add_child(remove);
            list.add_child(row);
        }
        this._card.add_child(scroll);
    }

    // ---------- the form ----------
    _openForm() {
        const c = this._chosen;
        // Today: the next round hour; another day: 8:00.
        const now = new Date();
        const hora = sameDay(c, now) ? Math.min(now.getHours() + 1, 23) : NOTICE_HOUR;
        this._form = {dia: c.getDate(), mes: c.getMonth(), anio: c.getFullYear(), hora, minuto: 0};
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

        // The alarm's time: its own row, unlike the date's ‹ ›: an alarm icon and
        // big hour and minutes, each with ˄ ˅ (the wheel over a number works too).
        const alarm = new St.BoxLayout({style_class: 'isla-cal-alarma'});
        alarm.add_child(new St.Icon({icon_name: 'alarm-symbolic', style_class: 'isla-cal-alarma-icono',
            y_align: Clutter.ActorAlign.CENTER}));
        alarm.add_child(new St.Label({style_class: 'isla-cal-alarma-texto', text: _('Alarma'), x_expand: true,
            y_align: Clutter.ActorAlign.CENTER}));
        const spinner = (name, step) => {
            const box = new St.BoxLayout({style_class: 'isla-cal-giro', reactive: true, y_align: Clutter.ActorAlign.CENTER});
            const label = new St.Label({style_class: 'isla-cal-giro-valor', y_align: Clutter.ActorAlign.CENTER});
            const arrows = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER});
            for (const [icon, d, what] of [['pan-up-symbolic', 1, _('{campo} siguiente')], ['pan-down-symbolic', -1, _('{campo} anterior')]]) {
                const b = new St.Button({style_class: 'isla-cal-giro-flecha', can_focus: true,
                    accessible_name: fmt(what, {campo: name}), child: new St.Icon({icon_name: icon, style_class: 'isla-cal-giro-icono'})});
                b.connect('clicked', () => step(d));
                arrows.add_child(b);
            }
            box.connect('scroll-event', (_a, event) => {
                const dir = event.get_scroll_direction();
                if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.DOWN)
                    step(dir === Clutter.ScrollDirection.UP ? 1 : -1);
                return Clutter.EVENT_STOP;
            });
            box.add_child(label);
            box.add_child(arrows);
            return [box, label];
        };
        const [hourBox, hourLabel] = spinner(_('Hora'), d => {
            this._form.hora = (this._form.hora + d + 24) % 24;
            this._paintFormDate();
        });
        const [minuteBox, minuteLabel] = spinner(_('Minutos'), d => {
            this._form.minuto = (this._form.minuto + d * MINUTE_STEP + 60) % 60;
            this._paintFormDate();
        });
        this._hourLabel = hourLabel;
        this._minuteLabel = minuteLabel;
        alarm.add_child(hourBox);
        alarm.add_child(new St.Label({style_class: 'isla-cal-giro-dos', text: ':', y_align: Clutter.ActorAlign.CENTER}));
        alarm.add_child(minuteBox);
        this._card.add_child(alarm);

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
        this._hourLabel.text = two(f.hora);
        this._minuteLabel.text = two(f.minuto);
    }

    _saveForm() {
        const text = this._entry?.get_text().trim();
        if (!text) {
            this._entry?.grab_key_focus();
            return;
        }
        const f = this._form;
        const list = this._notes();
        list.push({id: `${Date.now()}`, texto: text, dia: f.dia, mes: f.mes + 1, anio: f.anio,
            hora: f.hora, minuto: f.minuto, avisado: false});
        list.sort((a, b) => noteTime(a) - noteTime(b));
        this._saveNotes(list);
        // Show the day it was saved on.
        this._chosen = new Date(f.anio, f.mes, f.dia);
        this._shown = new Date(f.anio, f.mes, 1);
        this._closeForm();
        this._announce();
    }

    _closeForm() {
        this._form = null;
        this._entry = this._dayLabel = this._monthLabel = this._hourLabel = this._minuteLabel = null;
        this._paint();
    }

    // ---------- open / close ----------
    toggle() {
        if (this._panel)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._panel)
            return;
        // A ringing alarm stops: whoever opens the calendar has heard it.
        [...this._rings].forEach(r => r.stop());
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
        this._place();
        // Grown or shrunk (a reminder, the form): the bottom stays over the dock.
        content.connect('notify::height', () => this._panel === panel && this._place());
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
        panel.set({pivot_point: new Graphene.Point({x: 0.5, y: 1}), opacity: 0, scale_x: SMALL, scale_y: SMALL,
            translation_y: RISE});
        panel.ease({opacity: 255, duration: ms(IN_TIME * 0.6), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        panel.ease({scale_x: 1, scale_y: 1, translation_y: 0, duration: ms(IN_TIME),
            mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    // Centered on the dock, just above the island, inside the work area.
    _place() {
        const panel = this._panel;
        const area = dockWorkArea();
        const mon = dockMonitor();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [, w] = panel.get_preferred_width(-1);
        const [, h] = panel.get_preferred_height(w);
        let center = mon.x + mon.width / 2;
        let top = area.y + area.height;
        const island = this._state.skin?.isla?._bg;
        if (island?.get_stage() && island.visible) {
            const [ix, iy] = island.get_transformed_position();
            const [iw] = island.get_transformed_size();
            center = ix + iw / 2;
            // A hidden island sits below the screen: then from the bottom edge.
            top = Math.min(iy, mon.y + mon.height);
        }
        let x = center - w / 2;
        x = Math.min(Math.max(x, area.x + 4 * sf), area.x + area.width - w - 4 * sf);
        const y = Math.max(top - GAP * sf - h, area.y + 4 * sf);
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
        this._card = this._grid = this._gridLayout = this._cells = this._month = this._year = null;
        this._entry = this._dayLabel = this._monthLabel = this._hourLabel = this._minuteLabel = null;
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
            panel.ease({opacity: 0, scale_x: SMALL, scale_y: SMALL, translation_y: RISE, duration: ms(OUT_TIME),
                mode: Clutter.AnimationMode.EASE_IN_QUAD, onStopped: done});
        } else {
            done();
        }
    }

    destroy() {
        this.close(false);
        if (this._checkId)
            GLib.source_remove(this._checkId);
        this._checkId = 0;
        [...this._rings].forEach(r => r.stop());
        this._source?.destroy();
        this._state.disconnect(this._commandId);
        Main.overview.disconnect(this._overviewId);
        Main.wm.removeKeybinding(KEY);
        this._giveBackShortcut();
    }
}
