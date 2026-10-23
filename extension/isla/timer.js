// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Timer and Pomodoro (B1). Right click on the island: 5, 15, 25 minutes, a
// custom time, a Pomodoro (25 min of work and 5 of rest, 4 blocks) or stop.
// Folded: a ring that closes and the time left; open: one row as tall as the
// icons with the ring, the time, pause and stop (also in the right-click menu). When it ends: the theme's "complete" sound, a GNOME
// notification, the island beats 3 times and stays first until touched.
// The state lives in GSettings, so it survives a restart of the Shell.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {pillSizes, pillStyle, roundButton} from './pill.js';
import {onButton} from './press.js';
import {Priority} from './state.js';
import {_, fmt} from './i18n.js';

const WORK = 25 * 60, REST = 5 * 60, BLOCKS = 4;

function clock(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
    const two = n => String(n).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

// A ring that closes as time goes by: `fraction` is what is left.
function ringArea(size, line) {
    const area = new St.DrawingArea({style_class: 'isla-anillo', y_align: Clutter.ActorAlign.CENTER});
    area.fraction = 1;
    area.connect('repaint', () => {
        if (!area.mapped)
            return;
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const node = area.get_theme_node();
        const fg = node.get_foreground_color();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const lw = line * sf;
        const r = Math.min(w, h) / 2 - lw / 2;
        cr.setLineWidth(lw);
        cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.18);
        cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI);
        cr.stroke();
        if (area.fraction > 0) {
            cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.95);
            cr.setLineCap(1 /* ROUND */);
            cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * area.fraction);
            cr.stroke();
        }
        cr.$dispose();
    });
    area.style = `width: ${size}px; height: ${size}px;`;
    return area;
}

export class Timer {
    constructor({state, settings, capsule}) {
        this._state = state;
        this._settings = settings;
        this._capsule = capsule;
        this._buildActors();
        this._buildMenu();
        this._ids = [
            [capsule, capsule.connect('button-release-event', (_a, event) => {
                if (event.get_button() !== Clutter.BUTTON_SECONDARY || onButton(event, capsule))
                    return Clutter.EVENT_PROPAGATE;
                this._openMenu();
                return Clutter.EVENT_STOP;
            })],
            [settings, settings.connect('changed::tamano-base', () => {
                this._applySize();
                state.command('resize');
            })],
            [state, state.connect('compact-changed', (_s, compact) => this._setCompact(compact))],
            [state, state.connect('command', (_s, name) => {
                if (name === 'island-click' && this._data?.done)
                    this._acknowledge();
            })],
        ];
        this._load();
    }

    // ---------- actors ----------
    _buildActors() {
        this._mini = new St.BoxLayout({style_class: 'isla-tempo-mini', y_align: Clutter.ActorAlign.CENTER});
        this._miniRing = ringArea(16, 2.5);
        this._miniRing.connect('notify::mapped', a => a.mapped && a.queue_repaint());
        this._miniTime = new St.Label({style_class: 'isla-tempo-hora', y_align: Clutter.ActorAlign.CENTER});
        this._mini.add_child(this._miniRing);
        this._mini.add_child(this._miniTime);

        this._panel = new St.BoxLayout({style_class: 'isla-tempo isla-pildora', y_align: Clutter.ActorAlign.CENTER});
        this._ring = ringArea(26, 3);
        this._ring.connect('notify::mapped', a => a.mapped && a.queue_repaint());
        this._time = new St.Label({style_class: 'isla-tempo-grande', y_align: Clutter.ActorAlign.CENTER});
        // What the old second line said ("En pausa", "bloque 2 de 4"…) is now the accessible name.
        this._caption = '';
        this._pauseButton = new St.Button({style_class: 'isla-boton-redondo', can_focus: false, y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'media-playback-pause-symbolic', style_class: 'isla-boton-icono'})});
        this._pauseButton.connect('clicked', () => this._togglePause());
        this._stopButton = new St.Button({style_class: 'isla-boton-redondo', can_focus: false, y_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Detener'), child: new St.Icon({icon_name: 'media-playback-stop-symbolic', style_class: 'isla-boton-icono'})});
        this._stopButton.connect('clicked', () => this.stop());
        // Touching the ring of a finished timer acknowledges it.
        this._panelButton = new St.Button({can_focus: false, child: this._ring, y_align: Clutter.ActorAlign.CENTER});
        this._panelButton.connect('clicked', () => this._data?.done && this._acknowledge());
        for (const actor of [this._panelButton, this._time, this._pauseButton, this._stopButton])
            this._panel.add_child(actor);
        // Compact (a dock wider than the screen): only the ring, pause and stop.
        this._setCompact(this._state.compact);
        this._applySize();
    }

    // As tall as the icons ('tamano-base').
    _applySize() {
        const z = pillSizes(this._settings);
        this._panel.style = pillStyle(z, {left: 7});
        this._ring.style = `width: ${z.px(26)}px; height: ${z.px(26)}px;`;
        this._time.style = `font-size: ${z.font(14)}px;`;
        roundButton(this._pauseButton, z);
        roundButton(this._stopButton, z);
    }

    _setCompact(compact) {
        this._time.visible = !compact;
    }

    _buildMenu() {
        this._menuManager = new PopupMenu.PopupMenuManager(this._capsule);
        this._menu = new PopupMenu.PopupMenu(this._capsule, 0.5, St.Side.BOTTOM);
        this._menu.actor.add_style_class_name('isla-menu');
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();
        this._menuManager.addMenu(this._menu);
        this._menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._state.hold('timer-menu');
            else
                this._state.release('timer-menu');
        });
    }

    _openMenu() {
        const menu = this._menu;
        menu.removeAll();
        const timers = new PopupMenu.PopupSubMenuMenuItem(_('Temporizador'));
        for (const min of [5, 15, 25])
            timers.menu.addAction(fmt(_('{n} minutos'), {n: min}), () => this.start(min * 60));
        timers.menu.addAction(_('Personalizado…'), () => this._askMinutes());
        menu.addMenuItem(timers);
        menu.addAction(_('Pomodoro (25 + 5 min, 4 bloques)'), () => this.startPomodoro());
        if (this._data && !this._data.done) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction(this._data.paused !== null ? _('Reanudar') : _('Pausar'), () => this._togglePause());
            menu.addAction(_('Detener'), () => this.stop());
        }
        menu.open(true);
    }

    _askMinutes() {
        const dialog = new ModalDialog.ModalDialog();
        const content = new Dialog.MessageDialogContent({title: _('Temporizador'), description: _('¿Cuántos minutos?')});
        const entry = new St.Entry({style_class: 'isla-entrada-minutos', text: '10', can_focus: true});
        content.add_child(entry);
        dialog.contentLayout.add_child(content);
        const accept = () => {
            const minutes = parseFloat(entry.text.replace(',', '.'));
            dialog.close();
            if (minutes > 0 && minutes <= 24 * 60)
                this.start(Math.round(minutes * 60));
        };
        entry.clutter_text.connect('activate', accept);
        dialog.addButton({label: _('Cancelar'), action: () => dialog.close(), key: Clutter.KEY_Escape});
        dialog.addButton({label: _('Empezar'), action: accept, default: true});
        dialog.open();
        entry.clutter_text.set_selection(0, -1);
        entry.grab_key_focus();
    }

    // ---------- state (kept in GSettings) ----------
    _now() {
        return GLib.get_real_time() / 1e6;
    }

    _save() {
        const d = this._data;
        this._settings.set_int64('temporizador-fin', d ? Math.round(d.end * 1e6) : 0);
        this._settings.set_string('temporizador-modo', d ? JSON.stringify({...d, end: undefined}) : '');
    }

    _load() {
        const end = this._settings.get_int64('temporizador-fin');
        let data = null;
        try {
            data = JSON.parse(this._settings.get_string('temporizador-modo') || 'null');
        } catch {}
        if (!end || !data) {
            this._data = null;
            this._refresh();
            return;
        }
        this._data = {...data, end: end / 1e6};
        // It ended while the Shell was off.
        if (!this._data.done && this._data.paused === null && this._data.end <= this._now())
            this._finish(false);
        this._refresh();
    }

    start(seconds) {
        this._data = {kind: 'timer', total: seconds, end: this._now() + seconds, paused: null, done: false};
        this._save();
        this._refresh();
    }

    startPomodoro() {
        this._data = {kind: 'pomodoro', total: WORK, end: this._now() + WORK, paused: null, done: false,
            block: 1, phase: 'trabajo'};
        this._save();
        this._refresh();
    }

    stop() {
        this._data = null;
        this._save();
        this._refresh();
    }

    _togglePause() {
        const d = this._data;
        if (!d || d.done)
            return;
        if (d.paused === null) {
            d.paused = Math.max(0, d.end - this._now());
        } else {
            d.end = this._now() + d.paused;
            d.paused = null;
        }
        this._save();
        this._refresh();
    }

    _left() {
        const d = this._data;
        return d.paused !== null ? d.paused : Math.max(0, d.end - this._now());
    }

    _tick() {
        const d = this._data;
        if (d && !d.done && d.paused === null && this._left() <= 0) {
            this._finish(true);
            return;
        }
        this._paint();
    }

    _finish(live) {
        const d = this._data;
        // Pomodoro: work → rest → next block; the last work block ends it.
        if (d.kind === 'pomodoro' && !(d.phase === 'trabajo' && d.block >= BLOCKS)) {
            const rest = d.phase === 'trabajo';
            d.phase = rest ? 'descanso' : 'trabajo';
            if (!rest)
                d.block++;
            d.total = rest ? REST : WORK;
            d.end = this._now() + d.total;
            this._save();
            if (live)
                this._alarm(rest ? _('Pomodoro: descanso de 5 minutos') : fmt(_('Pomodoro: bloque {n} de {total}'), {n: d.block, total: BLOCKS}), false);
            this._refresh();
            return;
        }
        d.done = true;
        d.paused = null;
        this._save();
        if (live)
            this._alarm(d.kind === 'pomodoro' ? _('Pomodoro terminado') : _('Se acabó el tiempo'), true);
        this._refresh();
    }

    _alarm(text, beat) {
        try {
            global.display.get_sound_player().play_from_theme('complete', text, null);
        } catch {}
        Main.notify(_('Temporizador'), text);
        this._state.command('pulse', beat ? 3 : 1);
    }

    _acknowledge() {
        this.stop();
    }

    // ---------- drawing ----------
    _refresh() {
        const d = this._data;
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (!d) {
            this._state.removeActivity('timer');
            return;
        }
        if (!d.done && d.paused === null) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        }
        this._paint();
        this._state.setActivity('timer', {priority: d.done ? Priority.TIMER_DONE : Priority.TIMER, mini: this._mini, panel: this._panel});
    }

    _paint() {
        const d = this._data;
        if (!d)
            return;
        const left = d.done ? 0 : this._left();
        const fraction = d.done ? 0 : left / d.total;
        const text = d.done ? '¡Listo!' : clock(left);
        this._miniTime.text = text;
        this._time.text = text;
        if (d.done)
            this._caption = _('Toca la isla para cerrarlo');
        else if (d.kind === 'pomodoro')
            this._caption = fmt(d.phase === 'trabajo' ? _('Trabajo · bloque {n} de {total}') : _('Descanso · bloque {n} de {total}'),
                {n: d.block, total: BLOCKS});
        else
            this._caption = d.paused !== null ? _('En pausa') : fmt(_('Temporizador de {tiempo}'), {tiempo: clock(d.total)});
        this._panel.accessible_name = `${text} · ${this._caption}`;
        this._pauseButton.visible = !d.done;
        this._pauseButton.child.icon_name = d.paused !== null ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic';
        for (const ring of [this._miniRing, this._ring]) {
            ring.fraction = fraction;
            if (ring.mapped)
                ring.queue_repaint();
        }
        this._mini.style_class = `isla-tempo-mini${d.done ? ' listo' : ''}`;
        this._panel.style_class = `isla-tempo isla-pildora${d.done ? ' listo' : ''}${d.paused !== null ? ' pausa' : ''}`;
    }

    destroy() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
        this._state.release('timer-menu');
        this._menu.destroy();
        this._state.removeActivity('timer');
        this._mini.destroy();
        this._panel.destroy();
    }
}
