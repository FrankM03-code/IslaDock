// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Avisos flotantes: each notification appears alone at the top center of the
// screen as a small card (icon, title, one or two lines), with no island and
// no bar around it, and leaves by itself. GNOME's own banners are held back
// while this runs (the notifications still reach GNOME's list). A click opens
// what the notification points to; the × or a right click dismisses it.
// Same rules as GNOME's banners: none in do-not-disturb, none for low urgency,
// critical ones stay until they are dealt with. The cards look like the island
// (its color, transparency, edge and blur, Aurora's halo, Vidrio oscuro's
// lens), so the set reads as one. Each new card also nudges the dock, which
// peeks out for a moment when a window keeps it hidden.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {dressFrame, islandLook} from './look.js';
import {ms} from './timing.js';

const MAX_CARDS = 3;
const SHOW_TIME = 5000;
const IN_TIME = 200;
const OUT_TIME = 160;
const SHIFT = 12;
const TOP_GAP = 12;
const RADIUS = 18;

const oneLine = s => (s ?? '').replace(/\s+/g, ' ').trim();

export class FloatingNotices {
    constructor({state}) {
        this._state = state;
        this._sources = new Map();       // source -> [signal ids]
        this._notes = new Map();         // notification -> [signal ids]
        this._cards = [];
        this._box = new St.BoxLayout({style_class: 'isla-flotantes', orientation: Clutter.Orientation.VERTICAL,
            visible: false});
        Main.layoutManager.addTopChrome(this._box);
        this._boxId = this._box.connect('notify::size', () => this._place());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._place());
        this._blockGnomeBanners();
        this._trayIds = [
            Main.messageTray.connect('source-added', (_t, source) => this._watch(source)),
            Main.messageTray.connect('source-removed', (_t, source) => this._unwatch(source)),
        ];
        Main.messageTray.getSources().forEach(s => this._watch(s));
    }

    // GNOME's banner stays away while we run, whatever else blocks or unblocks it
    // (the top bar's menus do); what others ask for is kept and given back.
    _blockGnomeBanners() {
        const tray = Main.messageTray;
        const proto = Object.getPrototypeOf(tray);
        let desc = null;
        for (let p = proto; p && !desc; p = Object.getPrototypeOf(p))
            desc = Object.getOwnPropertyDescriptor(p, 'bannerBlocked');
        if (!desc?.set)
            return;
        this._bannerSetter = desc.set;
        this._othersBlock = !!tray.bannerBlocked;
        Object.defineProperty(tray, 'bannerBlocked', {
            configurable: true,
            get: () => this._othersBlock,
            set: v => {
                this._othersBlock = !!v;
            },
        });
        desc.set.call(tray, true);
    }

    _restoreGnomeBanners() {
        if (!this._bannerSetter)
            return;
        const tray = Main.messageTray;
        delete tray.bannerBlocked;
        this._bannerSetter.call(tray, this._othersBlock);
        this._bannerSetter = null;
    }

    _watch(source) {
        if (this._sources.has(source))
            return;
        this._sources.set(source, [source.connect('notification-added', (_s, n) => this._onNotification(source, n))]);
    }

    _unwatch(source) {
        this._sources.get(source)?.forEach(id => source.disconnect(id));
        this._sources.delete(source);
    }

    _wantsBanner(notification) {
        if (notification.urgency === MessageTray.Urgency.LOW)
            return false;
        return notification.source?.policy?.showBanners || notification.urgency === MessageTray.Urgency.CRITICAL;
    }

    _onNotification(source, notification) {
        if (this._notes.has(notification))
            return;
        this._notes.set(notification, [
            // An update of the same notification asks again by clearing "acknowledged".
            notification.connect('notify::acknowledged', () => {
                if (!notification.acknowledged)
                    this._show(source, notification);
            }),
            notification.connect('destroy', () => {
                this._forget(notification);
                this._cards.find(c => c.notification === notification)?.dismiss();
            }),
        ]);
        this._show(source, notification);
    }

    _forget(notification) {
        this._notes.get(notification)?.forEach(id => notification.disconnect(id));
        this._notes.delete(notification);
    }

    _show(source, notification) {
        if (this._state.dnd || !this._wantsBanner(notification))
            return;
        // Seen here: GNOME won't queue it as a banner (and won't show it later).
        notification.acknowledged = true;
        const existing = this._cards.find(c => c.notification === notification);
        if (existing) {
            existing.update();
            return;
        }
        const card = new Card(source, notification, islandLook(this._state), () => this._remove(card));
        this._cards.unshift(card);
        this._box.insert_child_at_index(card.actor, 0);
        this._box.show();
        while (this._cards.length > MAX_CARDS)
            this._cards[this._cards.length - 1].dismiss();
        this._holdRedirect(true);
        card.animateIn();
        this._state.command('nudge');
    }

    _remove(card) {
        this._cards = this._cards.filter(c => c !== card);
        if (!this._cards.length) {
            this._box.hide();
            this._holdRedirect(false);
        }
    }

    // On X11 a window that fills the monitor (maximized, with no top bar) may be
    // drawn straight to the screen, over the shell: GNOME's banners stop that
    // while they show, and so do the cards.
    _holdRedirect(on) {
        if (on === !!this._redirectHeld)
            return;
        this._redirectHeld = on;
        if (on)
            global.compositor.disable_unredirect();
        else
            global.compositor.enable_unredirect();
    }

    // Top center of the primary monitor, under the top bar when it is there.
    _place() {
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const panel = Main.layoutManager.panelBox;
        const top = mon.y + (panel.visible ? panel.height : 0) + TOP_GAP * sf;
        const [w] = this._box.get_size();
        this._box.set_position(Math.round(mon.x + (mon.width - w) / 2), Math.round(top));
        // Vidrio oscuro's lenses read their place on screen when allocated: once the box has moved.
        if (!this._later) {
            this._later = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._later = 0;
                this._cards.forEach(c => c.actor.get_children().forEach(a => a.queue_relayout()));
                return false;
            });
        }
    }

    destroy() {
        if (this._later)
            global.compositor.get_laters().remove(this._later);
        this._later = 0;
        this._trayIds.forEach(id => Main.messageTray.disconnect(id));
        this._trayIds = [];
        for (const source of [...this._sources.keys()])
            this._unwatch(source);
        for (const notification of [...this._notes.keys()])
            this._forget(notification);
        this._cards.forEach(c => c.destroy());
        this._cards = [];
        this._holdRedirect(false);
        this._restoreGnomeBanners();
        Main.layoutManager.disconnect(this._monitorsId);
        this._box.disconnect(this._boxId);
        Main.layoutManager.removeChrome(this._box);
        this._box.destroy();
    }
}

class Card {
    constructor(source, notification, look, onGone) {
        this.notification = notification;
        this._source = source;
        this._onGone = onGone;
        // A frame: the island's blurred wallpaper (when it has one) under the card.
        this.actor = new St.Widget({layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
        const actor = this._button = new St.Button({style_class: 'isla-flotante', reactive: true, track_hover: true,
            can_focus: false, button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE});
        if (look.light)
            actor.add_style_class_name('clara');
        if (look.style)
            actor.style = look.style;
        dressFrame(look, this.actor, actor, RADIUS);
        const box = new St.BoxLayout({style_class: 'isla-flotante-caja', x_expand: true});
        this._icon = new St.Icon({style_class: 'isla-flotante-icono', fallback_icon_name: 'dialog-information-symbolic',
            y_align: Clutter.ActorAlign.CENTER});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._title = new St.Label({style_class: 'isla-flotante-titulo'});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._body = new St.Label({style_class: 'isla-flotante-cuerpo'});
        const body = this._body.clutter_text;
        body.line_wrap = true;
        body.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        body.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._title);
        text.add_child(this._body);
        this._close = new St.Button({style_class: 'isla-flotante-cerrar', reactive: true, can_focus: false,
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}), opacity: 0,
            y_align: Clutter.ActorAlign.START, accessible_name: 'Cerrar'});
        box.add_child(this._icon);
        box.add_child(text);
        box.add_child(this._close);
        actor.set_child(box);
        this.update();

        this._close.connect('clicked', () => this.dismiss());
        actor.connect('clicked', (_b, button) => {
            if (button === 3) {
                this.dismiss();
                return;
            }
            Main.overview.hide();
            this.dismiss();
            notification.activate();
        });
        // The mouse over it holds it; leaving gives it its time again.
        actor.connect('notify::hover', () => {
            this._close.ease({opacity: actor.hover ? 255 : 0, duration: 120});
            if (actor.hover)
                this._stopTimer();
            else
                this._startTimer();
        });
    }

    update() {
        const n = this.notification;
        this._icon.gicon = n.gicon ?? this._source.icon ?? null;
        this._title.text = oneLine(n.title || this._source.title);
        this._body.text = oneLine(n.body);
        this._body.visible = !!this._body.text;
        this._startTimer();
    }

    _startTimer() {
        this._stopTimer();
        if (this.notification.urgency === MessageTray.Urgency.CRITICAL || this._gone)
            return;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOW_TIME, () => {
            this._timer = 0;
            this.dismiss();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopTimer() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
    }

    animateIn() {
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.actor.set({opacity: 0, translation_y: -SHIFT * sf});
        this.actor.ease({opacity: 255, translation_y: 0, duration: ms(IN_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // Leaves the screen; the notification itself stays in GNOME's list.
    dismiss() {
        if (this._gone)
            return;
        this._gone = true;
        this._stopTimer();
        this._onGone();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._button.reactive = false;
        this.actor.ease({opacity: 0, translation_y: -SHIFT * sf, duration: ms(OUT_TIME),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD, onStopped: () => this.actor.destroy()});
    }

    destroy() {
        this._gone = true;
        this._stopTimer();
        this.actor.destroy();
    }
}
