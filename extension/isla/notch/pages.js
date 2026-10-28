// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The pages of the open top island, compact (Frank's second design, isla-notch v2).
// Each one: {id, title (shown in small capitals; it may change: notch.refreshTitle()),
// actor, shown(on), minute(), destroy()}.
//   Música        the song IslaDock follows (state.music, media.js): cover, title, artist,
//                 a thin bar to jump in the song with its times; the buttons on the right
//   Temporizador  IslaDock's own timer (state.timer, timer.js): the time inside the ring;
//                 Pomodoro, 5 or 15 minutes or a time of your own; pause and stop while it runs
//   Captura       screenshots and screen recording: capture.js
//   Tareas        a short to-do list ('tareas'): the list, ＋ and ✓ (clear the done ones) beside it
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {_, fmt} from '../i18n.js';
import {clock, hbox, iconButton, label, pillButton, ring, spacer, vbox} from './widgets.js';

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const RING = 52;
const RING_LINE = 4;

const ellipsize = l => (l.clutter_text.ellipsize = Pango.EllipsizeMode.END);
// 3:05 (songs, the ring): no leading zero.
const short = seconds => clock(seconds).replace(/^0(\d)/, '$1');

// A ring with a label inside it.
function ringWith(fraction) {
    const box = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
    const area = ring(RING, RING_LINE, fraction);
    const text = label('isla-sup-anillo-texto', '', {x_align: Clutter.ActorAlign.CENTER});
    box.add_child(area);
    box.add_child(text);
    return {box, area, text};
}

// ---------- Música ----------
export class MusicPage {
    constructor({state}) {
        this.id = 'musica';
        this.title = _('Música');
        this._state = state;
        this._pos = 0;
        this.actor = hbox({style_class: 'isla-sup-pagina isla-sup-musica', x_expand: true});

        this._coverButton = new St.Button({style_class: 'isla-sup-caratula-boton', can_focus: true,
            accessible_name: _('Abrir el reproductor'), y_align: Clutter.ActorAlign.CENTER});
        this._cover = new St.Bin({style_class: 'isla-sup-caratula'});
        this._coverIcon = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 20,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._cover.set_child(this._coverIcon);
        this._coverButton.set_child(this._cover);
        this._coverButton.connect('clicked', () => state.command('media', 'raise'));
        this.actor.add_child(this._coverButton);

        const col = vbox({style_class: 'isla-sup-musica-col', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = label('isla-sup-fuerte');
        this._artist = label('isla-sup-tenue');
        ellipsize(this._title);
        ellipsize(this._artist);
        col.add_child(this._title);
        col.add_child(this._artist);
        this._progress = vbox();
        this._track = new St.Widget({style_class: 'isla-sup-pista', reactive: true, x_expand: true});
        this._fill = new St.Widget({style_class: 'isla-sup-pista-llena'});
        this._track.add_child(this._fill);
        this._track.connect('notify::width', () => this._paintProgress());
        this._track.connect('button-press-event', (actor, event) => this._seek(actor, event));
        const times = hbox({style_class: 'isla-sup-tiempos'});
        this._elapsed = label('isla-sup-mini', '0:00');
        this._remaining = label('isla-sup-mini', '-0:00');
        times.add_child(this._elapsed);
        times.add_child(spacer());
        times.add_child(this._remaining);
        this._progress.add_child(this._track);
        this._progress.add_child(times);
        col.add_child(this._progress);
        this.actor.add_child(col);

        const controls = hbox({style_class: 'isla-sup-controles', y_align: Clutter.ActorAlign.CENTER});
        const prev = iconButton('media-skip-backward-symbolic', 'isla-sup-boton', 12, _('Anterior'));
        this._play = iconButton('media-playback-start-symbolic', 'isla-sup-boton isla-sup-play', 13, _('Reproducir o pausar'));
        const next = iconButton('media-skip-forward-symbolic', 'isla-sup-boton', 12, _('Siguiente'));
        prev.connect('clicked', () => state.command('media', 'previous'));
        this._play.connect('clicked', () => state.command('media', 'playpause'));
        next.connect('clicked', () => state.command('media', 'next'));
        this._controls = [prev, this._play, next];
        this._controls.forEach(b => controls.add_child(b));
        this.actor.add_child(controls);

        this._infoId = state.connect('music-info', () => this._update());
        this._update();
    }

    _update() {
        const m = this._state.music;
        this._title.text = m?.title ?? _('Nada sonando');
        this._artist.text = m ? m.artist || m.by || '' : _('Abre Spotify o Firefox…');
        this._play.child.icon_name = m?.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._controls.forEach(b => (b.reactive = !!m));
        this.actor[m ? 'remove_style_class_name' : 'add_style_class_name']('vacia');
        this._progress.opacity = m?.length ? 255 : 0;
        if (m?.cover !== this._coverUri) {
            this._coverUri = m?.cover ?? null;
            if (this._coverUri) {
                this._cover.set_child(null);
                this._cover.style = `background-image: url("${this._coverUri}");`;
            } else {
                this._cover.style = null;
                this._cover.set_child(this._coverIcon);
            }
        }
        if (m?.trackId !== this._trackId) {
            this._trackId = m?.trackId;
            this._pos = 0;
        }
        this._paintProgress();
        this._askPosition();
    }

    // While it is on screen, where the song goes, once a second.
    shown(on) {
        this._shown = on;
        if (on && !this._pollId) {
            this._askPosition();
            this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._askPosition();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!on && this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }

    _askPosition() {
        const m = this._state.music;
        if (!this._shown || !m?.length || !m.bus)
            return;
        this._cancellable?.cancel();
        const cancellable = this._cancellable = new Gio.Cancellable();
        Gio.DBus.session.call(m.bus, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']), new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE, 1000, cancellable, (bus, res) => {
                try {
                    const [value] = bus.call_finish(res).deepUnpack();
                    this._pos = Number(value.unpack()) / 1e6;
                    this._paintProgress();
                } catch {}
            });
    }

    _seek(actor, event) {
        const m = this._state.music;
        if (!m?.length || !m.trackId || !GLib.Variant.is_object_path(m.trackId))
            return Clutter.EVENT_PROPAGATE;
        const [x] = event.get_coords();
        const [ax] = actor.get_transformed_position();
        const frac = Math.max(0, Math.min(1, (x - ax) / actor.width));
        this._pos = frac * m.length;
        Gio.DBus.session.call(m.bus, MPRIS_PATH, PLAYER_IFACE, 'SetPosition',
            new GLib.Variant('(ox)', [m.trackId, Math.round(this._pos * 1e6)]), null, Gio.DBusCallFlags.NONE, -1, null, null);
        this._paintProgress();
        return Clutter.EVENT_STOP;
    }

    _paintProgress() {
        const len = this._state.music?.length ?? 0;
        const pos = Math.min(this._pos, len);
        this._fill.width = len > 0 ? Math.round(pos / len * this._track.width) : 0;
        this._elapsed.text = short(pos);
        this._remaining.text = `-${short(len - pos)}`;
    }

    destroy() {
        this.shown(false);
        this._cancellable?.cancel();
        this._state.disconnect(this._infoId);
        if (this._cover.child !== this._coverIcon)
            this._coverIcon.destroy();
        this.actor.destroy();
    }
}

// ---------- Temporizador ----------
export class TimerPage {
    constructor({state}) {
        this.id = 'temporizador';
        this.title = _('Temporizador');
        this._state = state;
        // Ring and text together in the middle of the island (Frank: the right side looked empty).
        this.actor = hbox({style_class: 'isla-sup-pagina isla-sup-tempo', x_expand: true, x_align: Clutter.ActorAlign.CENTER});

        const r = ringWith(() => {
            const t = this._state.timer;
            return t && !t.done ? t.left / t.total : 0;
        });
        this._ring = r.area;
        this._time = r.text;
        this.actor.add_child(r.box);

        const col = vbox({y_align: Clutter.ActorAlign.CENTER, style_class: 'isla-sup-col'});
        this._mode = label('isla-sup-fuerte');
        this._caption = label('isla-sup-tenue');
        ellipsize(this._caption);
        this._row = hbox({style_class: 'isla-sup-fila'});
        col.add_child(this._mode);
        col.add_child(this._caption);
        col.add_child(this._row);
        this.actor.add_child(col);

        this._infoId = state.connect('timer-info', () => this._update());
        this._update();
    }

    _command(...args) {
        this._state.command('timer', ...args);
    }

    // The chips change only with the kind of moment: nothing set, running, paused, done.
    _buttons(kind) {
        if (kind === this._kind)
            return;
        this._kind = kind;
        this._row.destroy_all_children();
        const add = (text, cls, icon, fn) => {
            const b = pillButton(text, cls, icon);
            b.connect('clicked', fn);
            this._row.add_child(b);
        };
        if (kind === 'nada') {
            add(_('Pomodoro'), 'isla-sup-acento', 'media-playback-start-symbolic', () => this._command('pomodoro'));
            for (const min of [5, 15])
                add(fmt(_('{n} min'), {n: min}), '', null, () => this._command('start', min * 60));
            add(_('Otro…'), '', null, () => this._command('ask'));
        } else if (kind === 'listo') {
            add(_('Cerrar'), 'isla-sup-acento', 'object-select-symbolic', () => this._command('stop'));
        } else {
            const paused = kind === 'pausa';
            add(paused ? _('Reanudar') : _('Pausar'), 'isla-sup-acento',
                paused ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic', () => this._command('pause'));
            add(_('Detener'), '', 'media-playback-stop-symbolic', () => this._command('stop'));
        }
    }

    _update() {
        const t = this._state.timer;
        if (!t) {
            this._buttons('nada');
            this._time.text = '25:00';
            this._mode.text = _('Enfoque');
            this._caption.text = _('Pomodoro: 25 min de trabajo y 5 de descanso');
        } else if (t.done) {
            this._buttons('listo');
            this._time.text = '0:00';
            this._mode.text = _('¡Listo!');
            this._caption.text = t.kind === 'pomodoro' ? _('Pomodoro terminado') : _('Se acabó el tiempo');
        } else {
            this._buttons(t.paused ? 'pausa' : 'corre');
            this._time.text = short(t.left);
            this._mode.text = t.kind !== 'pomodoro' ? _('Temporizador')
                : t.phase === 'descanso' ? _('Descanso') : _('Enfoque');
            this._caption.text = t.paused ? _('En pausa') : t.caption ?? '';
        }
        this.actor[t && !t.done && !t.paused ? 'add_style_class_name' : 'remove_style_class_name']('corriendo');
        if (this._ring.mapped)
            this._ring.queue_repaint();
    }

    shown(on) {
        if (on)
            this._ring.queue_repaint();
    }

    destroy() {
        this._state.disconnect(this._infoId);
        this.actor.destroy();
    }
}

// ---------- Tareas ----------
export class TasksPage {
    constructor({settings, notch}) {
        this.id = 'tareas';
        this._settings = settings;
        this._notch = notch;
        this.actor = hbox({style_class: 'isla-sup-pagina isla-sup-tareas', x_expand: true});

        const col = vbox({x_expand: true, y_expand: true});
        this._entry = new St.Entry({style_class: 'isla-sup-entrada', hint_text: _('Nueva tarea y Enter…'),
            can_focus: true, visible: false});
        this._entry.clutter_text.connect('activate', () => this._addTyped());
        this._entry.clutter_text.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this.stopTyping();
            return Clutter.EVENT_STOP;
        });
        col.add_child(this._entry);
        this._rows = vbox({x_expand: true});
        this._scroll = new St.ScrollView({style_class: 'isla-sup-tareas-scroll', x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true});
        this._scroll.set_child(this._rows);
        col.add_child(this._scroll);
        this.actor.add_child(col);

        const side = vbox({style_class: 'isla-sup-tareas-lado', y_align: Clutter.ActorAlign.CENTER});
        const add = pillButton('', 'isla-sup-acento', 'list-add-symbolic');
        add.accessible_name = _('Agregar');
        add.connect('clicked', () => this._startTyping());
        // ✓: while typing it adds what was typed (and ends typing); otherwise it clears the done ones.
        this._done = pillButton('', '', 'object-select-symbolic');
        this._done.accessible_name = _('Quitar las hechas');
        this._done.connect('clicked', () => {
            if (this._entry.visible) {
                this._addTyped();
                this.stopTyping();
            } else {
                this._save(this._list().filter(t => !t.hecha));
            }
        });
        side.add_child(add);
        side.add_child(this._done);
        this.actor.add_child(side);

        this._id = settings.connect('changed::tareas', () => this._rebuild());
        this._rebuild();
    }

    // The wheel scrolls the list only over it and only when it is longer than its box.
    scrollsItself(event) {
        const adj = this._scroll.vadjustment ?? this._scroll.get_vscroll_bar?.()?.get_adjustment();
        if (!adj || adj.upper - adj.lower <= adj.page_size + 1)
            return false;
        const [x, y] = event.get_coords();
        const [sx, sy] = this._scroll.get_transformed_position();
        const [sw, sh] = this._scroll.get_transformed_size();
        return x >= sx && x < sx + sw && y >= sy && y < sy + sh;
    }

    // "Tareas · 1/3"
    get title() {
        const list = this._list();
        return list.length ? `${_('Tareas')} · ${list.filter(t => t.hecha).length}/${list.length}` : _('Tareas');
    }

    _list() {
        try {
            const list = JSON.parse(this._settings.get_string('tareas'));
            return Array.isArray(list) ? list.filter(t => t && typeof t.texto === 'string') : [];
        } catch {
            return [];
        }
    }

    _save(list) {
        this._settings.set_string('tareas', JSON.stringify(list));
    }

    _addTyped() {
        const text = this._entry.text.trim();
        if (!text)
            return;
        this._entry.text = '';
        this._save([{texto: text, hecha: false}, ...this._list()]);
    }

    _startTyping() {
        this._entry.show();
        this._done.accessible_name = _('Agregar');
        this._notch.grabKeyboard(this._entry);
    }

    stopTyping() {
        if (!this._entry.visible)
            return;
        this._entry.text = '';
        this._entry.hide();
        this._done.accessible_name = _('Quitar las hechas');
        this._notch.releaseKeyboard();
    }

    _rebuild() {
        this._rows.destroy_all_children();
        const list = this._list();
        this._notch.refreshTitle(this);
        if (!list.length) {
            this._rows.add_child(label('isla-sup-tenue isla-sup-vacio', _('Sin tareas. Toca ＋ para agregar.')));
            return;
        }
        list.forEach((task, i) => {
            const row = hbox({style_class: `isla-sup-tarea${task.hecha ? ' hecha' : ''}`, reactive: true, track_hover: true});
            const check = new St.Button({style_class: 'isla-sup-check', can_focus: true, y_align: Clutter.ActorAlign.CENTER,
                accessible_name: task.texto, child: new St.Icon({icon_name: 'object-select-symbolic', icon_size: 8})});
            check.connect('clicked', () => {
                list[i] = {...task, hecha: !task.hecha};
                this._save(list);
            });
            const text = label('isla-sup-tarea-texto', task.texto, {x_expand: true});
            ellipsize(text);
            const del = iconButton('window-close-symbolic', 'isla-sup-boton isla-sup-quitar', 9, _('Borrar'));
            del.connect('clicked', () => this._save(list.filter((_t, k) => k !== i)));
            row.add_child(check);
            row.add_child(text);
            row.add_child(del);
            this._rows.add_child(row);
        });
    }

    shown(on) {
        if (!on)
            this.stopTyping();
    }

    destroy() {
        this._settings.disconnect(this._id);
        this.actor.destroy();
    }
}
