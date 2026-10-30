// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Isla superior ('isla-superior'): a second island at the top center of the
// primary monitor, hanging from the screen edge like a notch.
// Compact (Frank's second design, isla-notch v2). Folded it shows the time (or
// the timer's countdown), every few seconds taking turns with the weather (GNOME's
// weather, the one the calendar shows) and, while something plays, the song: then
// the island widens (MUSIC_W) with the cover and "Title · Artist". A new song
// takes its turn at once. A status dot (accent; the cover's color
// while music plays; red while the timer runs) and the music bars. The pointer resting
// on it for 1.5 s opens it downwards (a quick look at the time does not): a header with
// the page name in small capitals, the bars and the date and time (a click opens IslaDock's calendar
// under the island); under it the pages (pages.js), changed with the dots or the
// wheel (anywhere on the open island). A click anywhere that is not a button opens the
// calendar under the island. It folds again shortly after the pointer leaves.
// It wears the island's skin like every IslaDock panel (look.js): its color and
// edge, light pieces over a light island and Aurora's halo on Aurora.
// With the GNOME top bar shown it sits over the bar's clock; with it hidden it
// takes the bar's place and hangs from a thin strip along the top edge
// ('isla-superior-franja' px, 0 = none) in the island's own color, joined to it by
// two small inward curves, like a MacBook's notch (Frank's isla-franja.png): island,
// strip and curves read as one piece. The strip keeps maximized windows under it.
// With 0 px the curves stay, against the screen edge (Frank liked the shape).
// It wears the dock's own transparency (look.js dockLook), strip and curves too; the
// frame is clipped under the strip so the island never paints twice over it.
// Notifications ('isla-superior-avisos', Frank's isla-notificaciones design, notices.js):
// one arriving widens the folded island sideways (NOTICE_W) with only the app's icon and
// name and "· Nuevo mensaje" / "· 3 mensajes" (never the message), a beating dot or a
// counter; after 6 s it folds back and the status dot keeps the notice color until they
// are seen. The pointer or a click opens the card: app, time, an avatar with the sender's
// initial, who writes and the message (two lines), Descartar and Abrir; the wheel passes
// to the next. Green (#25D366), red for critical ones. Folding after seeing them takes
// them off the island (they stay in GNOME's list and IslaDock's center).
// 'isla-superior-ocultar' = 'maximizada': while a maximized window is on its monitor
// (and workspace) the folded island slides up out of sight; the pointer at the top edge
// brings it back, and a notification shows it for its 6 s.
// The floating notices go under it (state.topInset).
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import GnomeDesktop from 'gi://GnomeDesktop';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {chromeParams} from '../chrome.js';
import {dayShort} from '../dates.js';
import {dockLook, dressFrame} from '../look.js';
import {ms} from '../timing.js';
import {_, fmt, ngettext} from '../i18n.js';
import {NotchNotices} from './notices.js';
import {CapturePage} from './capture.js';
import {MusicPage, TasksPage, TimerPage} from './pages.js';
import {notchNotices, onTop} from './place.js';
import {degrees} from '../weather.js';
import {TYPES} from '../restBar.js';
import {Wave, clock, hbox, label, pillButton, spacer, vbox} from './widgets.js';

const FOLDED_W = 150;
const OPEN_W = 380;
const OPEN_H = 116;
const BAR_H = 24;          // folded height without GNOME's top bar
const ABOVE = 24;          // px of the card kept above the screen edge: its top corners never show
const FRAME_MARGIN = 20;   // room in the frame for the nod of the timer
const FOLDED_R = 14;
const OPEN_R = 22;
const SWAP_EVERY = 6;      // s between the turns of the time, the weather and the song, folded
const MUSIC_W = 260;       // folded and widened by the song's turn
const CURVE = 12;          // the inward curves where the island meets the strip
const NOTICE_W = 260;      // folded and widened by a notification
const NOTICE_TIME = 6000;  // ms it stays widened
const BODY_MAX = 140;      // characters of the message on the card (two lines)
const HIDE_TIME = 220;
const SCROLL_GAP = 220;    // ms between two page changes by the wheel
const EDGE_H = 2;          // px of the top edge that bring the hidden island back
const PEEK_LEAVE = 700;    // ms after the pointer leaves before it hides again
const OPEN_DELAY = 1500;   // ms the pointer rests on the folded island before it opens (a glance at the time does not)
const NOTICE_DELAY = 400;  // widened by a notification: its card opens sooner
const CLOSE_DELAY = 450;
const GROW_TIME = 380;
const SHRINK_TIME = 280;
const PAGE_KEYS = ['isla-musica', 'musica-lugar', 'temporizador-lugar', 'isla-superior-captura', 'isla-superior-tareas'];

export class TopIsland {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._open = false;
        this._grab = null;
        this._pages = [];
        this._page = -1;
        this._timeouts = new Map();
        this._scrollAt = 0;
        this._build();
        this._makePages();

        this._clock = new GnomeDesktop.WallClock({time_only: true});
        this._ids = [
            [this._clock, this._clock.connect('notify::clock', () => this._minute())],
            [state, state.connect('skin-changed', () => this._dress())],
            // Clásica ↔ Clásica oscura is the same skin: dressed again once the island took its colors.
            [settings, settings.connect('changed::isla-oscura', () => this._later('dress', 120, () => this._dress()))],
            [state, state.connect('music-info', () => this._syncStatus())],
            [state, state.connect('timer-info', () => this._syncStatus())],
            [state, state.connect('command', (_s, name, n) => name === 'pulse' && this._pulse(n))],
            [Main.overview, Main.overview.connect('showing', () => this._overview(true))],
            [Main.overview, Main.overview.connect('hidden', () => this._overview(false))],
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._fit())],
            [global.display, global.display.connect('in-fullscreen-changed', () => this._holdRedirect())],
            ...PAGE_KEYS.map(key => [settings, settings.connect(`changed::${key}`, () => this._makePages())]),
            // GNOME's top bar comes or goes (the module that hides it runs apart): fit once it did.
            [settings, settings.connect('changed::ocultar-barra-superior', () => this._later('fit', 50, () => this._fit()))],
            [settings, settings.connect('changed::isla-superior-franja', () => this._fit())],
            [settings, settings.connect('changed::isla-superior-avisos', () => this._watchNotices())],
            [state, state.connect('dnd-changed', () => this._syncStatus())],
            // GNOME's light/dark switch reloads every stylesheet: once it settled, the island again.
            [St.ThemeContext.get_for_stage(global.stage), St.ThemeContext.get_for_stage(global.stage).connect('changed',
                () => this._later('restyle', 250, () => this._restyled()))],
        ];
        this._watchNotices();
        this._fit();
        this._minute();
        this._syncStatus();
        this._holdRedirect();
        this._watchWeather();
        this._watchWindows();
    }

    // ---------- actors ----------
    _build() {
        // The frame carries the skin's layers (Aurora's halo) around the card. It is as big as the
        // open island and never moves: the card grows inside it from its top center (its x eases
        // with its width, so it stays centered without placing anything during a layout).
        // Only the card takes the pointer.
        this._frame = new St.Widget({name: 'IslaSuperior', width: OPEN_W + 2 * FRAME_MARGIN, height: OPEN_H + ABOVE + FRAME_MARGIN});
        this._card = new St.Widget({style_class: 'isla-sup', reactive: true, track_hover: true,
            width: FOLDED_W, height: BAR_H + ABOVE});
        this._card.x = (this._frame.width - FOLDED_W) / 2;
        this._card.set_pivot_point(0.5, 0);
        this._card.connect('notify::height', () => this._barH && this._styleCard());
        this._clip = new St.Widget({clip_to_allocation: true});
        this._clip.add_constraint(new Clutter.BindConstraint({source: this._card, coordinate: Clutter.BindCoordinate.SIZE}));
        this._card.add_child(this._clip);

        // Folded: dot, the time or the weather (they swap), bars.
        this._folded = hbox({style_class: 'isla-sup-plegada'});
        this._dot = new St.Widget({style_class: 'isla-sup-punto', y_align: Clutter.ActorAlign.CENTER});
        const swap = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, clip_to_allocation: true});
        this._timeBox = hbox({style_class: 'isla-sup-clima', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._timeIcon = new St.Icon({style_class: 'isla-sup-hora-icono', icon_size: 15, y_align: Clutter.ActorAlign.CENTER});
        this._time = label('isla-sup-plegada-hora');
        this._timeBox.add_child(this._timeIcon);
        this._timeBox.add_child(this._time);
        this._weather = hbox({style_class: 'isla-sup-clima', x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER, opacity: 0, visible: false});
        this._weatherIcon = new St.Icon({style_class: 'isla-sup-clima-icono', icon_size: 16, y_align: Clutter.ActorAlign.CENTER});
        this._weatherTemp = label('isla-sup-plegada-hora');
        this._weather.add_child(this._weatherIcon);
        this._weather.add_child(this._weatherTemp);
        this._song = hbox({style_class: 'isla-sup-cancion', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            opacity: 0, visible: false});
        this._songCover = new St.Bin({style_class: 'isla-sup-cancion-caratula', y_align: Clutter.ActorAlign.CENTER});
        this._songIcon = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 11});
        this._songCover.set_child(this._songIcon);
        this._songTitle = label('isla-sup-cancion-titulo', '', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._songTitle.clutter_text.ellipsize = 3;
        this._song.add_child(this._songCover);
        this._song.add_child(this._songTitle);
        // Recording (Captura): the time and a square to stop (the status dot turns red);
        // then "Video guardado" for a moment.
        this._rec = hbox({style_class: 'isla-sup-grabando', x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER, opacity: 0, visible: false});
        this._recTime = label('isla-sup-plegada-hora');
        this._recStop = new St.Button({style_class: 'isla-sup-grabando-parar', can_focus: true, y_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Detener grabación'), child: new St.Widget({style_class: 'isla-sup-grabando-cuadro',
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER})});
        this._recStop.connect('clicked', () => this._pages.find(p => p.id === 'captura')?.stopRecording());
        this._rec.add_child(this._recTime);
        this._rec.add_child(this._recStop);
        swap.add_child(this._timeBox);
        swap.add_child(this._weather);
        swap.add_child(this._song);
        swap.add_child(this._rec);
        this._wave = new Wave();
        this._folded.add_child(this._dot);
        this._folded.add_child(swap);
        this._folded.add_child(this._wave.actor);
        this._clip.add_child(this._folded);

        // Open: header, pages, dots.
        this._opened = vbox({style_class: 'isla-sup-abierta', width: OPEN_W, height: OPEN_H, opacity: 0, visible: false});
        // Header: PAGE NAME ······ bars  dom 25 · 15:35
        const header = hbox({style_class: 'isla-sup-cabecera'});
        this._title = label('isla-sup-titulo', '', {x_expand: true});
        header.add_child(this._title);
        this._headWave = new Wave();
        header.add_child(this._headWave.actor);
        this._date = label('isla-sup-fecha');
        this._date.clutter_text.use_markup = true;
        this._dateButton = new St.Button({style_class: 'isla-sup-fecha-boton', can_focus: true, child: this._date,
            accessible_name: _('Calendario'), y_align: Clutter.ActorAlign.CENTER});
        this._dateButton.connect('clicked', () => this._openCalendar());
        header.add_child(this._dateButton);
        this._opened.add_child(header);

        // The pages, no arrows: the wheel or the dots change them.
        this._stack = new St.Widget({style_class: 'isla-sup-cuerpo', layout_manager: new Clutter.BinLayout(),
            x_expand: true, y_expand: true, clip_to_allocation: true});
        this._empty = label('isla-sup-tenue', _('Elige qué mostrar en Preferencias → Arriba'),
            {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._stack.add_child(this._empty);
        this._opened.add_child(this._stack);
        this._dots = hbox({style_class: 'isla-sup-puntos', x_align: Clutter.ActorAlign.CENTER});
        this._opened.add_child(this._dots);
        this._clip.add_child(this._opened);

        // Widened by a notification: icon, APP · Nuevo mensaje, a beating dot or a counter.
        this._alert = hbox({style_class: 'isla-sup-alerta', width: NOTICE_W, opacity: 0, visible: false});
        this._alertIcon = new St.Icon({style_class: 'isla-sup-alerta-icono', icon_size: 16, y_align: Clutter.ActorAlign.CENTER});
        this._alertApp = label('isla-sup-alerta-app');
        this._alertText = label('isla-sup-alerta-texto');
        this._alertApp.clutter_text.ellipsize = 3;
        this._alertDot = new St.Widget({style_class: 'isla-sup-alerta-punto', y_align: Clutter.ActorAlign.CENTER});
        this._alertCount = label('isla-sup-contador');
        for (const a of [this._alertIcon, this._alertApp, this._alertText, spacer(), this._alertDot, this._alertCount])
            this._alert.add_child(a);
        this._clip.add_child(this._alert);

        // Open on a notification: the card (_paintNotice).
        this._noticeView = vbox({style_class: 'isla-sup-aviso', width: OPEN_W, height: OPEN_H, opacity: 0, visible: false});
        const top = hbox({style_class: 'isla-sup-aviso-cabecera'});
        this._noticeIcon = new St.Icon({style_class: 'isla-sup-aviso-icono', icon_size: 14, y_align: Clutter.ActorAlign.CENTER});
        this._noticeApp = label('isla-sup-titulo', '', {x_expand: true});
        this._noticeWhen = label('isla-sup-aviso-hora');
        top.add_child(this._noticeIcon);
        top.add_child(this._noticeApp);
        top.add_child(this._noticeWhen);
        this._noticeView.add_child(top);
        const middle = this._noticeMiddle = hbox({style_class: 'isla-sup-aviso-medio', y_expand: true});
        this._avatar = new St.Bin({style_class: 'isla-sup-avatar', y_align: Clutter.ActorAlign.START,
            child: label('isla-sup-avatar-letra', '', {x_align: Clutter.ActorAlign.CENTER})});
        const words = vbox({x_expand: true});
        this._noticeTitle = label('isla-sup-fuerte');
        this._noticeTitle.clutter_text.ellipsize = 3;
        this._noticeBody = new St.Label({style_class: 'isla-sup-aviso-cuerpo'});
        this._noticeBody.clutter_text.line_wrap = true;
        words.add_child(this._noticeTitle);
        words.add_child(this._noticeBody);
        middle.add_child(this._avatar);
        middle.add_child(words);
        this._noticeView.add_child(middle);
        const buttons = hbox({style_class: 'isla-sup-aviso-botones', x_align: Clutter.ActorAlign.END});
        this._noticeCount = label('isla-sup-mini', '', {x_expand: true});
        const dismiss = pillButton(_('Descartar'));
        dismiss.connect('clicked', () => this._noticeAction('dismiss'));
        this._openButton = pillButton('', 'isla-sup-abrir');
        this._openButton.connect('clicked', () => this._noticeAction('open'));
        buttons.add_child(this._noticeCount);
        buttons.add_child(dismiss);
        buttons.add_child(this._openButton);
        this._noticeView.add_child(buttons);
        this._clip.add_child(this._noticeView);

        this._card.connect('notify::hover', () => this._onHover());
        this._card.connect('button-release-event', (_a, event) => {
            // Not the release of a click that began outside (it comes here while the keyboard was held).
            if (event.get_button() !== Clutter.BUTTON_PRIMARY || !this._pointerInside())
                return Clutter.EVENT_PROPAGATE;
            // Widened by a notification: the click opens its card.
            if (this._view === 'alert') {
                this._setOpen(true, 'notice');
                return Clutter.EVENT_STOP;
            }
            // Anywhere that is not a button (or another control): the calendar, under the island.
            if (this._onControl(event))
                return Clutter.EVENT_PROPAGATE;
            this._openCalendar();
            return Clutter.EVENT_STOP;
        });
        this._card.connect('captured-event', (_a, event) => this._onCaptured(event));

        // The strip along the top edge, under the island; never takes the pointer.
        this._strip = new St.Widget({name: 'IslaSuperiorFranja', reactive: false, visible: false});
        Main.layoutManager.addTopChrome(this._strip, {affectsStruts: true, trackFullscreen: true});
        // The curves hang beside the card in the frame: constraints keep them at its edges while it grows.
        this._curves = ['izquierda', 'derecha'].map(side => {
            const curve = new St.DrawingArea({reactive: false, width: CURVE, height: CURVE, visible: false});
            curve.connect('repaint', a => this._paintCurve(a, side));
            // Both side edges snap (one alone stretches the curve): left one ends at the card's left
            // edge, right one starts at its right edge, CURVE px wide.
            const edge = side === 'izquierda' ? Clutter.SnapEdge.LEFT : Clutter.SnapEdge.RIGHT;
            const offset = side === 'izquierda' ? -CURVE : CURVE;
            curve.add_constraint(new Clutter.SnapConstraint({source: this._card, from_edge: Clutter.SnapEdge.LEFT,
                to_edge: edge, offset: Math.min(0, offset)}));
            curve.add_constraint(new Clutter.SnapConstraint({source: this._card, from_edge: Clutter.SnapEdge.RIGHT,
                to_edge: edge, offset: Math.max(0, offset)}));
            return curve;
        });

        this._dress();
        Main.layoutManager.addTopChrome(this._frame, chromeParams({affectsInputRegion: false, trackFullscreen: true}));
        Main.layoutManager.trackChrome(this._card, chromeParams({affectsInputRegion: true}));
    }

    // The skin's look: its color and edge on the card, light pieces over a light island, its layers around.
    _dress() {
        // With the dock's own transparency, like the notification center's panels.
        const look = dockLook(this._state);
        this._look = look;
        this._card[look.light ? 'add_style_class_name' : 'remove_style_class_name']('clara');
        // Strip and curves take the island's exact color and transparency: one piece.
        const m = /background-color:\s*rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(look.style ?? '');
        this._fill = m ? [...m.slice(1, 4).map(Number), m[4] !== undefined ? Number(m[4]) : 1] : [10, 10, 12, 0.86];
        this._strip.style = `background-color: rgba(${this._fill.join(', ')});`;
        this._curves.forEach(c => c.queue_repaint());
        this._styleCard();
        if (this._clock)
            this._syncStatus();
        const skin = this._state.skin;
        if (this._card.get_parent() && this._framedFor === skin)
            return;
        this._framedFor = skin;
        this._frame.get_children().filter(c => c !== this._card && !this._curves.includes(c)).forEach(c => c.destroy());
        this._card.get_parent()?.remove_child(this._card);
        this._curves.forEach(c => c.get_parent()?.remove_child(c));
        dressFrame(look, this._frame, this._card, OPEN_R);
        // Over the skin's layers (Aurora's halo), beside the card.
        this._curves.forEach(c => this._frame.add_child(c));
    }

    // After a theme change: dressed again and the folded content shown afresh, as a click
    // left it. Recording while going from light to dark, the folded island stayed blank
    // until clicked (Frank, 2026-10-30).
    _restyled() {
        this._dress();
        const turn = this._turn ?? 'time';
        const turns = {time: this._timeBox, weather: this._weather, music: this._song, rec: this._rec};
        for (const [name, actor] of Object.entries(turns)) {
            actor.remove_all_transitions();
            actor.set({visible: name === turn, opacity: 255, translation_y: 0});
        }
        const view = this._viewActor(this._view ?? 'folded');
        view.remove_all_transitions();
        view.set({visible: true, opacity: 255, scale_x: 1, scale_y: 1});
        this._card.queue_relayout();
        global.stage.queue_redraw();
    }

    get _stripOn() {
        return this._stripH > 0;
    }

    // The inward curves: whenever the island hangs from the top edge (not over GNOME's bar),
    // with or without the strip (0 px leaves the curves against the screen edge).
    get _curvesOn() {
        return !this._barShown;
    }

    // The corners follow the card's height while it grows or shrinks (folded ones at the
    // folded height, open ones at the open height): no jump when the animation ends.
    _styleCard() {
        const h = this._card.height - ABOVE;
        const t = Math.max(0, Math.min(1, (h - this._barH) / (OPEN_H - this._barH)));
        const r = Math.round(FOLDED_R + t * (OPEN_R - FOLDED_R));
        // Joined to the curves (and the strip): no edge line across the joint.
        const joint = this._curvesOn ? ' border-width: 0;' : '';
        const style = `${this._look?.style ?? ''}${joint} border-radius: ${r}px;`;
        if (style !== this._card.style)
            this._card.style = style;
    }

    // A square of the island's color minus a quarter circle centered on its lower outer corner.
    _paintCurve(area, side) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const [r, g, b, a] = this._fill ?? [10, 10, 12, 0.86];
        cr.setSourceRGBA(r / 255, g / 255, b / 255, a);
        cr.setFillRule(Cairo.FillRule.EVEN_ODD);
        cr.rectangle(0, 0, w, h);
        cr.arc(side === 'izquierda' ? 0 : w, h, Math.min(w, h), 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    }

    _waveColor() {
        const m = this._state.music;
        return this._state.skin?.waveColor ?? (m?.color ? `rgb(${m.color.join(', ')})` : null);
    }

    // ---------- place ----------
    get _monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    // Folded as tall as GNOME's top bar while it shows (over its clock), else BAR_H.
    _fit() {
        const panel = Main.layoutManager.panelBox;
        const barShown = this._barShown = panel.visible && Main.panel.height > 0;
        this._barH = barShown ? Math.max(24, Main.panel.height) : BAR_H;
        this._hideBarClock(barShown);
        // The strip takes the bar's place: none while the bar shows.
        this._stripH = barShown ? 0 : this._settings.get_int('isla-superior-franja');
        const mon = this._monitor;
        // Hidden it would still keep the windows down (its strut): no height then.
        if (mon) {
            this._strip.set_position(mon.x, mon.y);
            this._strip.set_size(mon.width, this._stripH);
        }
        this._strip.visible = this._stripOn && !Main.overview.visible;
        this._curves.forEach(c => {
            c.visible = this._curvesOn;
            c.y = ABOVE + this._stripH;
        });
        // Under the strip only: the strip already paints that band (no double transparency there).
        // Wide and deep enough for the shadow and Aurora's halo.
        if (this._stripOn)
            this._frame.set_clip(-80, ABOVE + this._stripH, this._frame.width + 160, this._frame.height + 80);
        else
            this._frame.remove_clip();
        this._styleCard();
        this._folded.set_size(this._foldedW, this._barH);
        this._alert.height = this._barH;
        for (const view of [this._folded, this._opened, this._alert, this._noticeView])
            view.y = ABOVE;
        this._placeInside(this._targetWidth);
        if (!this._open) {
            this._card.remove_transition('height');
            this._card.height = this._barH + ABOVE;
        }
        this._center();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const inset = this._hidden ? 0 : Math.round(this._barH * sf);
        if (this._state.topInset !== inset) {
            this._state.topInset = inset;
            this._state.emit('top-inset-changed');
        }
    }

    // The card centered in the frame and both views centered in the card, for a card `w` wide.
    _placeInside(w, time = 0, mode = Clutter.AnimationMode.LINEAR) {
        const at = [[this._card, (this._frame.width - w) / 2], [this._folded, (w - this._foldedW) / 2], [this._opened, (w - OPEN_W) / 2],
            [this._alert, (w - NOTICE_W) / 2], [this._noticeView, (w - OPEN_W) / 2]];
        for (const [actor, x] of at) {
            if (time)
                actor.ease({x: Math.round(x), duration: time, mode});
            else
                actor.x = Math.round(x);
        }
    }

    _center() {
        const mon = this._monitor;
        if (mon)
            this._frame.set_position(Math.round(mon.x + (mon.width - this._frame.width) / 2), mon.y - ABOVE);
    }

    // The bar's own clock would peek out around the folded island.
    _hideBarClock(hide) {
        const clock = Main.panel.statusArea.dateMenu?.container;
        if (!clock)
            return;
        if (hide && !this._clockHidden) {
            this._clockHidden = true;
            clock.opacity = 0;
        } else if (!hide && this._clockHidden) {
            this._clockHidden = false;
            clock.opacity = 255;
        }
    }

    // On X11 a window filling the monitor (maximized with no top bar) can be drawn straight to
    // the screen, over the shell: keep it composited while the island shows, but not under a
    // fullscreen app (the island hides there).
    _holdRedirect() {
        const want = !this._monitor?.inFullscreen && !this._gone;
        if (want === !!this._redirectHeld)
            return;
        this._redirectHeld = want;
        if (want)
            global.compositor.disable_unredirect();
        else
            global.compositor.enable_unredirect();
    }

    // ---------- open / fold ----------
    _later(name, delay, fn) {
        this._clear(name);
        // Taking the card away moves the hover too: nothing new once it is going.
        if (this._gone)
            return;
        this._timeouts.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeouts.delete(name);
            fn();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _clear(name) {
        const id = this._timeouts.get(name);
        if (id)
            GLib.source_remove(id);
        this._timeouts.delete(name);
    }

    // After a grab ends the hover flag can be stale: what counts is where the pointer is.
    _pointerInside() {
        const [x, y] = global.get_pointer();
        const [cx, cy] = this._card.get_transformed_position();
        const [w, h] = this._card.get_transformed_size();
        return x >= cx && x < cx + w && y >= cy && y < cy + h;
    }

    _onHover() {
        if (this._grab)
            return;
        // Recording (and its "Video guardado"): it stays the small pill under the pointer.
        if (this._recShown && !this._open)
            return;
        if (this._card.hover && this._pointerInside())
            this._later('hover', this._view === 'alert' ? NOTICE_DELAY : OPEN_DELAY, () => this._setOpen(true, this._wantedView));
        else
            this._later('hover', CLOSE_DELAY, () => this._setOpen(false));
    }

    // Opening shows the notifications first while some wait to be seen.
    get _wantedView() {
        return this._notices?.list.length ? 'notice' : 'pages';
    }

    // ---------- the four views: folded, alert (widened), pages, notice (the card) ----------
    _viewActor(view) {
        return {folded: this._folded, alert: this._alert, pages: this._opened, notice: this._noticeView}[view];
    }

    _viewSize(view) {
        if (view === 'pages' || view === 'notice')
            return [OPEN_W, OPEN_H];
        return [view === 'alert' ? NOTICE_W : this._foldedW, this._barH];
    }

    // Wider while the song has its turn.
    get _foldedW() {
        return this._turn === 'music' ? MUSIC_W : FOLDED_W;
    }

    get _targetWidth() {
        return this._viewSize(this._view ?? 'folded')[0];
    }

    _setOpen(open, which = 'pages') {
        if (!open && this._view === 'notice')
            this._notices?.clear();        // seen: off the island
        this._show(open ? which : this._alerting ? 'alert' : 'folded');
    }

    _show(view) {
        const old = this._view ?? 'folded';
        if (old === view)
            return;
        this._view = view;
        this._open = view === 'pages' || view === 'notice';
        this._clear('hover');
        const [w, h] = this._viewSize(view);
        const growing = w * h > this._card.width * (this._card.height - ABOVE);
        const time = ms(growing ? GROW_TIME : SHRINK_TIME);
        const mode = growing ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_CUBIC;
        if (old === 'pages')
            this._pages[this._page]?.shown?.(false);
        if (view === 'notice')
            this._paintNotice();
        const out = this._viewActor(old), inn = this._viewActor(view);
        // A big view shrinks with the card as it goes: never cut by the card's edges halfway.
        const [ow, oh] = this._viewSize(old);
        const fit = (vw, vh) => Math.min(1, w / vw, h / vh);
        out.set_pivot_point(0.5, 0);
        out.ease({opacity: 0, scale_x: fit(ow, oh), scale_y: fit(ow, oh), duration: ms(growing ? 110 : 160),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (this._view !== old)
                    out.hide();
                out.set_scale(1, 1);
            }});
        inn.remove_all_transitions();
        inn.set_scale(1, 1);
        inn.show();
        inn.ease({opacity: 255, duration: ms(growing ? GROW_TIME - 100 : SHRINK_TIME), delay: ms(80),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._card.ease({width: w, height: h + ABOVE, duration: time, mode,
            onStopped: () => this._styleCard()});
        this._placeInside(w, time, mode);
        this._repaintWhileResizing();
        if (view === 'pages')
            this._pages[this._page]?.shown?.(true);
        this._syncStatus();
        this._checkHide();
    }

    // ---------- hiding behind a maximized window ----------
    _watchWindows() {
        // The top edge: a thin strip that brings the hidden island back.
        this._edge = new St.Widget({name: 'IslaSuperiorBorde', reactive: true, track_hover: true, visible: false});
        this._edge.connect('notify::hover', () => {
            if (this._edge.hover)
                this._peek(true);
        });
        // Shown only while the island is away (and never over a fullscreen app): visible, it is
        // part of the input region on X11 and would take clicks at the top edge from the windows.
        Main.layoutManager.addTopChrome(this._edge, chromeParams({affectsInputRegion: true}));
        this._windowSignals = new Map();
        global.get_window_actors().forEach(a => a.meta_window && this._watchWindow(a.meta_window));
        this._windowIds = [
            [global.display, global.display.connect('window-created', (_d, w) => {
                this._watchWindow(w);
                this._queueHideCheck();
            })],
            [global.display, global.display.connect('restacked', () => this._queueHideCheck())],
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => this._queueHideCheck())],
            [global.display, global.display.connect('in-fullscreen-changed', () => this._checkHide())],
            [this._settings, this._settings.connect('changed::isla-superior-ocultar', () => this._checkHide())],
            [this._card, this._card.connect('notify::hover', () => {
                if (!this._card.hover && this._peeking)
                    this._later('peek', PEEK_LEAVE, () => this._peek(false));
                else if (this._card.hover)
                    this._clear('peek');
            })],
        ];
        this._checkHide();
    }

    _watchWindow(w) {
        if (this._windowSignals.has(w))
            return;
        // Maximizing changes its size (the property itself is gone in newer Mutter).
        const ids = [
            w.connect('size-changed', () => this._queueHideCheck()),
            w.connect('notify::minimized', () => this._queueHideCheck()),
            w.connect('position-changed', () => this._queueHideCheck()),
            w.connect('unmanaged', () => {
                ids.forEach(id => w.disconnect(id));
                this._windowSignals.delete(w);
                this._queueHideCheck();
            }),
        ];
        this._windowSignals.set(w, ids);
    }

    _unwatchWindows() {
        this._windowIds?.forEach(([obj, id]) => obj.disconnect(id));
        this._windowIds = null;
        for (const [w, ids] of this._windowSignals ?? [])
            ids.forEach(id => w.disconnect(id));
        this._windowSignals?.clear();
        if (this._edge) {
            Main.layoutManager.removeChrome(this._edge);
            this._edge.destroy();
        }
        this._edge = null;
    }

    _queueHideCheck() {
        if (!this._timeouts.has('hide'))
            this._later('hide', 150, () => this._checkHide());
    }

    // A window maximized (at least in height: it covers the top) on the island's monitor and workspace.
    _maximizedBehind() {
        const mon = Main.layoutManager.primaryIndex;
        const ws = global.workspace_manager.get_active_workspace();
        return global.get_window_actors().some(actor => {
            const w = actor.meta_window;
            if (!w || w.minimized || !w.showing_on_its_workspace() || w.get_monitor() !== mon ||
                !w.located_on_workspace(ws) || !TYPES.includes(w.get_window_type()))
                return false;
            return w.is_maximized?.() ?? (w.maximized_vertically || w.get_maximized?.() === Meta.MaximizeFlags.BOTH);
        });
    }

    _shouldHide() {
        if (this._settings.get_string('isla-superior-ocultar') !== 'maximizada' || this._peeking || this._grab)
            return false;
        // Open, widened by a notice or under the pointer: it stays.
        if ((this._view ?? 'folded') !== 'folded' || this._card.hover)
            return false;
        return this._maximizedBehind();
    }

    _checkHide() {
        if (this._gone || !this._edge)
            return;
        const hide = this._shouldHide();
        this._placeEdge();
        this._edge.visible = hide && !this._monitor?.inFullscreen;
        if (hide === !!this._hidden)
            return;
        this._hidden = hide;
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._frame.ease({translation_y: hide ? -(this._barH + this._stripH + 8) * sf : 0, duration: ms(HIDE_TIME),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        // The notices go up to the edge while it is away.
        const inset = hide ? 0 : Math.round(this._barH * sf);
        if (this._state.topInset !== inset) {
            this._state.topInset = inset;
            this._state.emit('top-inset-changed');
        }
    }

    _placeEdge() {
        const mon = this._monitor;
        if (!mon || !this._edge)
            return;
        const w = FOLDED_W + 80;
        this._edge.set_position(Math.round(mon.x + (mon.width - w) / 2), mon.y);
        this._edge.set_size(w, EDGE_H);
    }

    // Brought out by the pointer at the edge; away again a moment after it leaves the island.
    _peek(on) {
        this._clear('peek');
        this._peeking = on;
        if (on && !this._card.hover)
            this._later('peek', PEEK_LEAVE + 800, () => this._peek(false));
        this._checkHide();
    }

    // The card's shadow and Aurora's blurred halo reach past what Clutter repaints when the card
    // shrinks: on X11 their old pixels stayed on the screen after folding. While it changes size
    // (and once more at the end) the whole screen is repainted.
    _repaintWhileResizing() {
        const transition = this._card.get_transition('height');
        if (!transition) {
            global.stage.queue_redraw();
            return;
        }
        const frameId = transition.connect('new-frame', () => global.stage.queue_redraw());
        transition.connect('stopped', () => {
            transition.disconnect(frameId);
            if (this._gone)
                return;
            global.stage.queue_redraw();
            this._later('repaint', 60, () => global.stage.queue_redraw());
        });
    }

    _overview(showing) {
        if (showing) {
            this._setOpen(false);
            this._frame.ease({opacity: 0, duration: ms(150), onStopped: () => Main.overview.visible && this._frame.hide()});
            this._strip.hide();
        } else {
            this._strip.visible = this._stripOn;
            this._frame.show();
            this._frame.ease({opacity: 255, duration: ms(200)});
        }
    }

    // The timer rang: the island nods `n` times.
    _pulse(n = 1) {
        if (!onTop(this._settings, 'temporizador-lugar') || !St.Settings.get().enable_animations)
            return;
        let left = n;
        const beat = () => {
            if (left-- <= 0 || this._gone)
                return;
            this._card.ease({scale_x: 1.08, scale_y: 1.08, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._card.ease({scale_x: 1, scale_y: 1, duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK, onComplete: beat})});
        };
        beat();
    }

    _openCalendar() {
        this._setOpen(false);
        // The folded part stays where it is while the card shrinks: the calendar comes out under it.
        this._state.command('calendar-toggle', this._folded, 'arriba');
    }

    // ---------- pages ----------
    _makePages() {
        const s = this._settings;
        const wanted = [
            ['musica', s.get_boolean('isla-musica') && onTop(s, 'musica-lugar'), () => new MusicPage({state: this._state})],
            ['temporizador', onTop(s, 'temporizador-lugar'), () => new TimerPage({state: this._state})],
            ['captura', s.get_boolean('isla-superior-captura'), () => new CapturePage({notch: this})],
            ['tareas', s.get_boolean('isla-superior-tareas'), () => new TasksPage({settings: s, notch: this})],
        ].filter(([, on]) => on);
        const ids = wanted.map(([id]) => id);
        if (ids.join() === this._pages.map(p => p.id).join())
            return;
        const current = this._pages[this._page]?.id ?? s.get_string('isla-superior-pagina');
        // Pages that stay keep their state (a task being typed, the timer's buttons).
        const old = new Map(this._pages.map(p => [p.id, p]));
        this._pages = wanted.map(([id, , make]) => {
            const page = old.get(id) ?? make();
            old.delete(id);
            return page;
        });
        old.forEach(p => p.destroy());
        for (const page of this._pages) {
            if (!page.actor.get_parent()) {
                page.actor.hide();
                this._stack.add_child(page.actor);
            }
        }
        this._dots.destroy_all_children();
        this._pages.forEach((_p, i) => {
            const dot = new St.Button({style_class: 'isla-sup-punto-pagina', can_focus: false, y_align: Clutter.ActorAlign.CENTER,
                child: new St.Widget({style_class: 'isla-sup-punto-pagina-in'})});
            dot.connect('clicked', () => this._goPage(i));
            this._dots.add_child(dot);
        });
        this._dots.visible = this._pages.length > 1;
        this._empty.visible = !this._pages.length;
        this._page = -1;
        this._goPage(Math.max(0, ids.indexOf(current)), false);
    }

    _goPage(i, save = true) {
        const n = this._pages.length;
        if (!n) {
            this._title.text = _('Isla superior').toUpperCase();
            return;
        }
        i = ((i % n) + n) % n;
        if (i === this._page)
            return;
        const old = this._pages[this._page];
        const page = this._pages[i];
        const dir = this._page < 0 ? 0 : (i > this._page ? 1 : -1);
        if (old) {
            old.shown?.(false);
            old.actor.ease({opacity: 0, translation_x: -28 * dir, duration: ms(140), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    if (this._pages[this._page] !== old) {
                        old.actor.hide();
                        old.actor.translation_x = 0;
                    }
                }});
        }
        page.actor.remove_all_transitions();
        page.actor.show();
        page.actor.set({opacity: dir ? 0 : 255, translation_x: 28 * dir});
        page.actor.ease({opacity: 255, translation_x: 0, duration: ms(220), delay: old ? ms(60) : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._page = i;
        this.refreshTitle(page);
        this._dots.get_children().forEach((d, k) => d[k === i ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked'));
        if (this._view === 'pages')
            page.shown?.(true);
        if (save)
            this._settings.set_string('isla-superior-pagina', page.id);
    }

    // A page's name changed (Tareas · 1/3): shown if it is the current one.
    refreshTitle(page) {
        if (this._title && page === this._pages[this._page])
            this._title.text = page.title.toUpperCase();
    }

    // A press on a button, a task, the song bar…: theirs, not the island's.
    _onControl(event) {
        for (let a = global.stage.get_event_actor(event); a && a !== this._card; a = a.get_parent()) {
            if (a.reactive)
                return true;
        }
        return false;
    }

    // The wheel changes page (or notification) anywhere on the open island. Only a task list
    // longer than its box keeps the wheel while the pointer is on it (it scrolls); a short one
    // does not stop the pages there. A touchpad's small steps add up to one page.
    _onScroll(event) {
        // On the folded island the wheel opens it at once, without the hover wait; the pages
        // only start turning after the scroll gap so that same swipe does not flip one.
        if (!this._open && !this._grab) {
            this._scrollAt = GLib.get_monotonic_time();
            this._scrollSum = 0;
            this._setOpen(true, this._wantedView);
            return Clutter.EVENT_STOP;
        }
        const notice = this._view === 'notice';
        if (!this._open || (notice ? (this._notices?.list.length ?? 0) : this._pages.length) < 2)
            return Clutter.EVENT_PROPAGATE;
        let d = 0;
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
            d = -1;
        else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
            d = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            this._scrollSum = (this._scrollSum ?? 0) + (Math.abs(dx) > Math.abs(dy) ? dx : dy);
            if (Math.abs(this._scrollSum) >= 1) {
                d = Math.sign(this._scrollSum);
                this._scrollSum = 0;
            }
        }
        const page = this._pages[this._page];
        if (!notice && page?.scrollsItself?.(event))
            return Clutter.EVENT_PROPAGATE;
        const now = GLib.get_monotonic_time();
        if (d && now - this._scrollAt > SCROLL_GAP * 1000) {
            this._scrollAt = now;
            if (notice) {
                const n = this._notices.list.length;
                this._noticeIndex = ((this._noticeIndex + d) % n + n) % n;
                this._paintNotice();
            } else {
                this._goPage(this._page + d);
            }
        }
        return Clutter.EVENT_STOP;
    }

    // ---------- Captura ----------
    fold() {
        this._setOpen(false);
    }

    // Folded and out of sight while `fn` runs (a screenshot, GNOME's screenshot tool), so the
    // island is never in the picture; a moment first for the screen to be painted without it.
    async hideWhile(fn) {
        this._show('folded');
        this._clear('hover');
        this._frame.hide();
        global.stage.queue_redraw();
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
        try {
            await fn();
        } finally {
            if (!this._gone && !Main.overview.visible)
                this._frame.show();
        }
    }

    // A short word on the folded island ("Captura guardada"), `time` ms.
    say(message, time) {
        this.setRecording(null, message, time);
    }

    // While recording `seconds` is the time so far: the folded island is the small pill. Else
    // `message` ("Video guardado") stays `time` ms, then the time comes back.
    setRecording(seconds, message = null, time = SWAP_EVERY * 1000) {
        if (this._gone)
            return;
        this._clear('rec');
        const was = [this._recording, this._recShown].join();
        this._recording = seconds !== null;
        this._recShown = this._recording || !!message;
        this._recTime.text = this._recording ? clock(seconds).replace(/^0(\d)/, '$1') : message ?? '';
        this._recStop.visible = this._recording;
        this._rec[this._recording ? 'remove_style_class_name' : 'add_style_class_name']('nota');
        if (message)
            this._later('rec', time, () => this.setRecording(null));
        if ([this._recording, this._recShown].join() !== was)
            this._syncStatus();
        if (this._recShown)
            this._swap('rec');
        else if (this._turn === 'rec')
            this._swap('time');
    }

    // ---------- typing (tasks) ----------
    grabKeyboard(actor) {
        if (!this._grab)
            this._grab = Main.pushModal(this._card, {actionMode: Shell.ActionMode.POPUP});
        this._clear('hover');
        actor.grab_key_focus();
    }

    releaseKeyboard() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._onHover();
    }

    // While typing, a click outside ends it and folds the island.
    _onCaptured(event) {
        // The wheel is seen here, before the children: the task list's scroll view kept it even
        // with nothing to scroll and the pages got stuck on Tareas.
        if (event.type() === Clutter.EventType.SCROLL)
            return this._onScroll(event);
        if (!this._grab || event.type() !== Clutter.EventType.BUTTON_PRESS)
            return Clutter.EVENT_PROPAGATE;
        if (this._card.contains(global.stage.get_event_actor(event)))
            return Clutter.EVENT_PROPAGATE;
        this._pages.forEach(p => p.stopTyping?.());
        this._setOpen(false);
        return Clutter.EVENT_STOP;
    }

    // ---------- what it shows ----------
    _minute() {
        const now = GLib.DateTime.new_now_local();
        const date = GLib.markup_escape_text(`${dayShort(now)} ${now.get_day_of_month()}`, -1);
        this._date.clutter_text.set_markup(`${date} · <b>${GLib.markup_escape_text(this._clock.clock, -1)}</b>`);
        this._pages.forEach(p => p.minute?.());
        this._syncStatus();
    }

    _syncStatus() {
        const timer = onTop(this._settings, 'temporizador-lugar') ? this._state.timer : null;
        const music = this._state.music;
        const running = timer && !timer.done;
        if (timer?.done)
            this._time.text = _('¡Listo!');
        else if (running)
            this._time.text = clock(timer.left);
        else
            this._time.text = this._clock.clock;
        this._time[timer ? 'add_style_class_name' : 'remove_style_class_name']('tempo');
        this._timeIcon[timer ? 'add_style_class_name' : 'remove_style_class_name']('tempo');
        this._timeIcon.icon_name = timer?.done ? 'object-select-symbolic' : timer ? 'alarm-symbolic' : 'preferences-system-time-symbolic';
        // Notifications not seen yet: the notice color until they are.
        const waiting = this._notices?.list.length ? (this._notices.critical ? 'aviso urgente' : 'aviso') : '';
        const kind = waiting || (this._recording ? 'grabando' : running && !timer.paused ? 'tempo' : timer?.done ? 'listo' : music?.playing ? 'musica' : '');
        const color = kind === 'musica' ? this._waveColor() : null;
        this._dot.style_class = `isla-sup-punto${kind ? ` ${kind}` : ''}`;
        this._dot.style = color ? `background-color: ${color};` : null;
        // The countdown stays put: no turns while the timer runs. A new song takes its turn at once;
        // a stopped one gives it back.
        const song = music?.playing && onTop(this._settings, 'musica-lugar') ? `${music.title ?? ''}\n${music.artist || music.by || ''}` : null;
        this._paintSong(music);
        if (running && this._turn !== 'time')
            this._swap('time');
        else if (song && song !== this._lastSong)
            this._swap('music', true);
        else if (!song && this._turn === 'music')
            this._swap('time');
        this._lastSong = song;
        this._wave.color = this._headWave.color = this._waveColor();
        this._wave.playing = this._headWave.playing = !!music?.playing;
        this._wave.actor.visible = !!music;
    }

    // ---------- notifications ----------
    _watchNotices() {
        const on = notchNotices(this._settings);
        if (on && !this._notices) {
            this._noticeIndex = 0;
            this._notices = new NotchNotices({state: this._state, onChange: ask => this._noticesChanged(ask)});
        } else if (!on && this._notices) {
            this._notices.destroy();
            this._notices = null;
            this._setAlert(false);
            if (this._view === 'notice')
                this._show('pages');
        }
    }

    _noticesChanged(ask) {
        const list = this._notices.list;
        if (!list.length) {
            this._setAlert(false);
            if (this._view === 'notice')
                this._show(this._card.hover ? 'pages' : 'folded');
        } else if (this._view === 'notice') {
            this._noticeIndex = ask ? 0 : Math.min(this._noticeIndex, list.length - 1);
            this._paintNotice();
        } else if (ask && !this._open) {
            this._setAlert(true);
        }
        this._paintAlert();
        this._syncStatus();
    }

    // Widened sideways for NOTICE_TIME, then back; what was there (time, weather, timer) waits.
    _setAlert(on) {
        this._clear('alert');
        if (on)
            this._later('alert', NOTICE_TIME, () => this._setAlert(false));
        if (this._alerting === on)
            return;
        this._alerting = on;
        this._alertDot.remove_all_transitions();
        this._alertDot.opacity = 255;
        if (on && St.Settings.get().enable_animations)
            this._alertDot.ease({opacity: 90, duration: 700, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, repeatCount: -1, autoReverse: true});
        if (!this._open)
            this._show(on ? 'alert' : 'folded');
    }

    // Never the message here: the app and how many.
    _paintAlert() {
        const list = this._notices?.list ?? [];
        const newest = list[0];
        if (!newest)
            return;
        const app = this._appName(newest);
        const same = list.filter(e => this._appName(e) === app).length;
        this._alertIcon.gicon = this._appIcon(newest);
        this._alertApp.text = app;
        this._alertText.text = same > 1 ? fmt(ngettext('· {n} mensaje', '· {n} mensajes', same), {n: same}) : _('· Nuevo mensaje');
        this._alertCount.text = String(list.length);
        this._alertCount.visible = list.length > 1;
        this._alertDot.visible = list.length <= 1;
        const urgent = this._notices.critical;
        for (const a of [this._alertDot, this._alertCount])
            a[urgent ? 'add_style_class_name' : 'remove_style_class_name']('urgente');
    }

    _appName(entry) {
        return entry.source?.title || entry.notification.source?.title || _('Notificación');
    }

    _appIcon(entry) {
        return entry.source?.icon ?? entry.notification.gicon ?? null;
    }

    _paintNotice() {
        const list = this._notices?.list ?? [];
        const entry = list[this._noticeIndex ?? 0] ?? list[0];
        if (!entry)
            return;
        const n = entry.notification;
        const app = this._appName(entry);
        this._noticeIcon.gicon = this._appIcon(entry);
        this._noticeApp.text = app.toUpperCase();
        const minutes = Math.floor((Date.now() - entry.at) / 60000);
        this._noticeWhen.text = minutes < 1 ? _('ahora') : GLib.DateTime.new_from_unix_local(Math.floor(entry.at / 1000)).format('%H:%M');
        const title = (n.title ?? '').trim() || app;
        this._noticeTitle.text = title;
        this._avatar.child.text = title.charAt(0).toLocaleUpperCase();
        // Plain text (some apps send markup), two lines at most.
        let body = (n.body ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        if (body.length > BODY_MAX)
            body = `${body.slice(0, BODY_MAX - 1).trimEnd()}…`;
        this._noticeBody.text = body;
        this._noticeBody.visible = !!body;
        this._noticeCount.text = list.length > 1 ? `${list.indexOf(entry) + 1} / ${list.length}` : '';
        this._openButton._label.text = fmt(_('Abrir {app}'), {app: app.length > 16 ? `${app.slice(0, 15)}…` : app});
        const urgent = n.urgency === MessageTray.Urgency.CRITICAL;
        this._openButton[urgent ? 'add_style_class_name' : 'remove_style_class_name']('urgente');
    }

    _noticeAction(what) {
        const list = this._notices?.list ?? [];
        const entry = list[this._noticeIndex ?? 0] ?? list[0];
        if (!entry)
            return;
        if (what === 'open') {
            // Opening a window: the island folds behind it.
            this._notices.open(entry);
            this._show('folded');
        } else {
            this._notices.dismiss(entry);
        }
    }

    // ---------- weather, folded ----------
    _watchWeather() {
        // The turns go on without weather too (time and song).
        this._swapId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SWAP_EVERY, () => {
            this._swap();
            return GLib.SOURCE_CONTINUE;
        });
        this._weatherClient = Main.panel.statusArea.dateMenu?._weatherItem?._weatherClient ?? null;
        if (!this._weatherClient)
            return;
        this._weatherId = this._weatherClient.connect('changed', () => this._syncWeather());
        this._syncWeather();
    }

    _syncWeather() {
        const client = this._weatherClient;
        const info = client?.info;
        const temp = client?.available && client.hasLocation && info?.is_valid() ? degrees(info) : null;
        this._weatherReady = temp !== null;
        if (this._weatherReady) {
            this._weatherIcon.icon_name = info.get_symbolic_icon_name();
            this._weatherTemp.text = `${temp}°`;
        } else if (this._turn === 'weather') {
            this._swap('time');
        }
    }

    _paintSong(m) {
        if (!m)
            return;
        const by = m.artist || m.by || '';
        this._songTitle.text = by ? `${m.title ?? ''} · ${by}` : m.title ?? '';
        if (m.cover !== this._songUri) {
            this._songUri = m.cover ?? null;
            this._songCover.set_child(this._songUri ? null : this._songIcon);
            this._songCover.style = this._songUri ? `background-image: url("${this._songUri}");` : null;
        }
    }

    // The next turn (time → weather → song → time…), or `to`; a soft vertical slide. The song's turn
    // widens the folded island; `restart` gives the new turn a whole SWAP_EVERY.
    _swap(to = null, restart = false) {
        const timer = onTop(this._settings, 'temporizador-lugar') ? this._state.timer : null;
        const free = !(timer && !timer.done) && !this._alerting;
        const can = {time: !this._recShown, weather: free && this._weatherReady && !this._recShown,
            music: free && !!this._state.music?.playing && onTop(this._settings, 'musica-lugar') && !this._recShown,
            rec: !!this._recShown};
        // Recording, or its "Video guardado": nothing else takes turns.
        if (this._recShown)
            to = 'rec';
        const turn = this._turn ?? 'time';
        if (!to) {
            const order = ['time', 'weather', 'music'];
            to = turn;
            for (let i = 1; i <= order.length; i++) {
                const next = order[(order.indexOf(turn) + i) % order.length];
                if (can[next]) {
                    to = next;
                    break;
                }
            }
        }
        if (!can[to])
            to = this._recShown ? 'rec' : 'time';
        if (restart)
            this._restartTurns();
        if (to === turn)
            return;
        this._turn = to;
        const actors = {time: this._timeBox, weather: this._weather, music: this._song, rec: this._rec};
        const [out, inn] = [actors[turn], actors[to]];
        out.ease({opacity: 0, translation_y: -10, duration: ms(260), mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                if (this._gone || this._turn === turn)
                    return;
                out.hide();
                out.translation_y = 0;
            }});
        inn.remove_all_transitions();
        inn.show();
        inn.set({opacity: 0, translation_y: 10});
        inn.ease({opacity: 255, translation_y: 0, duration: ms(320), delay: ms(140), mode: Clutter.AnimationMode.EASE_OUT_BACK});
        if (turn === 'music' || to === 'music')
            this._resizeFolded();
    }

    // In or out of the song's turn: the folded island grows or shrinks sideways.
    _resizeFolded() {
        const w = this._foldedW;
        this._folded.width = w;
        if (this._view && this._view !== 'folded')
            return;
        const growing = w > this._card.width;
        const time = ms(growing ? GROW_TIME : SHRINK_TIME);
        const mode = growing ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_CUBIC;
        this._card.ease({width: w, duration: time, mode, onStopped: () => this._styleCard()});
        this._placeInside(w, time, mode);
        this._repaintWhileResizing();
    }

    _restartTurns() {
        if (!this._swapId)
            return;
        GLib.source_remove(this._swapId);
        this._swapId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SWAP_EVERY, () => {
            this._swap();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        this._unwatchWindows();
        this._gone = true;
        this._notices?.destroy();
        this._notices = null;
        this._alertDot.remove_all_transitions();
        if (this._swapId)
            GLib.source_remove(this._swapId);
        this._swapId = 0;
        if (this._weatherId)
            this._weatherClient.disconnect(this._weatherId);
        this._weatherId = 0;
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._holdRedirect();
        this._hideBarClock(false);
        this._wave.stop();
        this._headWave.stop();
        this._pages.forEach(p => p.destroy());
        this._pages = [];
        // The skin's layers hang on the card by constraints: they go first, then the card, then the frame.
        this._card.remove_all_transitions();
        this._frame.hide();
        this._frame.get_children().filter(c => c !== this._card).forEach(c => c.destroy());
        this._card.destroy();
        this._frame.destroy();
        Main.layoutManager.removeChrome(this._strip);
        this._strip.destroy();
        this._state.topInset = 0;
        this._state.emit('top-inset-changed');
    }
}
