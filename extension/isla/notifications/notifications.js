// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Notification center (notificaciones-isla-dock.md, 2026-10-24): IslaDock's own
// notifications instead of GNOME's. The bell on the dock (right after the
// player) carries the unread count and sways when one arrives; a click opens the
// panel over it (panel.js), a right click the quick menu (No molestar, Limpiar
// todo). Each notice rises as a popup over the dock, by the bell, for 5 s (held
// while the pointer is on it; critical ones stay) and then waits in the panel.
// In do not disturb only critical ones pop up; the bell turns into the moon.
// While this runs GNOME's banners are held back and its own list (the calendar
// menu's) is hidden; both come back when it stops.
//
// Commands it listens to: 'notifications-toggle' (anchor), 'notifications-clear'.
// Commands it sends: 'notifications-count' (sway), 'notifications-open', 'panel-open', 'nudge'.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {NotificationStore} from './store.js';
import {NotificationPanel, when} from './panel.js';
import {addPanelChrome, dropChrome} from '../chrome.js';
import {GnomeBanners, wantsBanner} from '../banners.js';
import {dockLook, dressFrame} from '../look.js';
import {dockMonitor, dockWorkArea, insideDock} from '../monitor.js';
import {notchNotices} from '../notch/place.js';
import {Mode} from '../state.js';
import {ms} from '../timing.js';
import {_} from '../i18n.js';

const GAP = 12;
const ARROW = 16;
const IN_TIME = 250;
const OUT_TIME = 160;
const RISE = 14;
const RADIUS = 22;
const TOAST_RADIUS = 16;
const SHOW_TIME = 5000;
const MAX_HEIGHT = 0.7;

export class Notifications {
    constructor({state, settings, capsule, uuid}) {
        this._state = state;
        this._settings = settings;
        this._capsule = capsule;
        this._uuid = uuid;
        this.store = new NotificationStore(GLib.build_filenamev([GLib.get_user_data_dir(), 'isla-dock', 'notificaciones.json']));
        this._banners = new GnomeBanners();
        this._banners.hold();
        this._hideGnomeList();
        this._ids = [
            [this.store, this.store.connect('changed', () => this._count())],
            [this.store, this.store.connect('arrived', (_s, entry, n) => this._arrived(entry, n))],
            [state, state.connect('command', (_s, name, ...args) => {
                if (name === 'notifications-toggle')
                    this.toggle(args[0]);
                else if (name === 'notifications-clear')
                    this.store.dismissAll();
            })],
            [state, state.connect('dnd-changed', () => {
                this._content?.setDnd(this._dndInfo());
                this._count();
            })],
            // The dock narrows when the hover zoom ends: the open panel keeps within its edges.
            [capsule, capsule.connect('notify::width', () => this._panel && this._place())],
            [state, state.connect('skin-changed', () => this.close(false))],
            [state, state.connect('mode-changed', (_s, mode) => mode !== Mode.EXPANDED && this.close())],
            [Main.overview, Main.overview.connect('showing', () => this.close(false))],
        ];
        this._count();
    }

    // ---------- GNOME's own ----------
    // The calendar menu's notification list: hidden while the center runs.
    _hideGnomeList() {
        const list = Main.panel?.statusArea?.dateMenu?._messageList;
        if (!list)
            return;
        this._gnomeList = list;
        list.hide();
        this._gnomeListId = list.connect('notify::visible', () => list.visible && list.hide());
    }

    _showGnomeList() {
        const list = this._gnomeList;
        if (!list)
            return;
        list.disconnect(this._gnomeListId);
        list.visible = Main.sessionMode.hasNotifications && !Main.sessionMode.isGreeter;
        this._gnomeList = null;
    }

    // ---------- the bell ----------
    _count(sway = false) {
        this._state.notifUnread = this.store.unread;
        this._state.notifWaiting = this.store.unread;
        this._state.command('notifications-count', sway);
    }

    _dndInfo() {
        const until = Number(this._settings.get_int64('no-molestar-hasta'));
        return {on: !!this._state.dnd, until, mode: until ? this._settings.get_string('no-molestar-modo') : 'siempre'};
    }

    _arrived(entry, notification) {
        // Seen here: GNOME won't queue it as a banner (nor show it when the center stops).
        notification.acknowledged = true;
        if (this._panel) {
            this.store.markAllRead();
            return;
        }
        this._count(true);
        const critical = notification.urgency === MessageTray.Urgency.CRITICAL;
        // The top island shows it instead (isla/notch/notices.js); here it waits in the panel.
        if ((this._state.dnd && !critical) || !wantsBanner(notification) || notchNotices(this._settings))
            return;
        // Several in the same moment (two reminders due together): only the last one pops up. Built
        // and replaced within one frame, a popup was left in Clutter's queue and allocated dead.
        this._nextToast = entry;
        this._toastIdle ||= GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._toastIdle = 0;
            const next = this._nextToast;
            this._nextToast = null;
            this._toast(next);
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- the panel ----------
    get isOpen() {
        return !!this._panel;
    }

    toggle(anchor) {
        if (this._panel)
            this.close();
        else
            this.open(anchor);
    }

    _look(content) {
        const look = dockLook(this._state);
        // Light islands get the design's pink, see-through like the dock (in the stylesheet);
        // dark ones keep the island's color, as see-through as the dock.
        if (!look.light) {
            content.add_style_class_name('oscura');
            if (look.style)
                content.style = look.style;
        }
        return look;
    }

    open(anchor) {
        if (this._panel || this._state.mode !== Mode.EXPANDED)
            return;
        this._dropToast(false);
        const mon = dockMonitor();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const content = this._content = new NotificationPanel({
            store: this.store,
            fresh: this.store.unread,
            dnd: this._dndInfo(),
            maxHeight: Math.round(mon.height / sf * MAX_HEIGHT - 190),
            on: {
                activate: id => this._act(() => this.store.activate(id)),
                action: (id, i) => this._act(() => this.store.runAction(id, i)),
                dismiss: id => this.store.dismiss(id),
                clearAll: () => this.store.dismissAll(),
                clearHistory: () => this.store.clearHistory(),
                dnd: value => this._state.command('dnd-set', value),
                settings: () => {
                    this.close();
                    Main.extensionManager.openExtensionPrefs(this._uuid, '', {});
                },
                resize: () => this._place(),
            },
        });
        const frame = this._panel = new St.Widget({layout_manager: new Clutter.BinLayout(), reactive: true});
        const look = this._look(content.actor);
        dressFrame(look, frame, content.actor, RADIUS);
        // The arrow under the panel, pointing at the bell: a turned square half hidden behind it.
        this._arrow = new St.Widget({style_class: `isla-np-flecha${look.light ? '' : ' oscura'}`,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}), rotation_angle_z: 45});
        if (!look.light && look.style)
            this._arrow.style = look.style;
        this._anchor = anchor;
        // Only its tip shows: the panel is see-through, and the half behind it would show as a diamond.
        const tip = new St.Widget({clip_to_allocation: true});
        tip.add_child(this._arrow);
        this._arrow = tip;
        addPanelChrome(this._arrow);
        addPanelChrome(frame);
        this._place();
        // Its final size comes a moment later: placed again so it stays within the dock.
        frame.connect('notify::height', () => this._place());
        frame.connect('notify::width', () => this._place());
        frame.connect('captured-event', (_a, event) => this._onEvent(event));
        frame.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._grab = Main.pushModal(frame, {actionMode: Shell.ActionMode.POPUP});
        frame.grab_key_focus();
        for (const actor of [frame, this._arrow]) {
            actor.set({opacity: 0, translation_y: RISE / 2});
            actor.ease({opacity: 255, translation_y: 0, duration: ms(180), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._state.command('panel-open', 'notifications', true);
        this._state.hold('notifications');
        this._state.command('hide-tooltip');
        // Opening it reads them all.
        this.store.markAllRead();
    }

    // Activating closes the panel first (the app comes to the front).
    _act(fn) {
        this.close();
        Main.overview.hide();
        fn();
    }

    // Centered over the bell but within the dock's edges, above the island, inside the work area;
    // the arrow under the bell.
    _place() {
        const frame = this._panel;
        if (!frame)
            return;
        const anchor = this._anchor?.get_stage() ? this._anchor : this._capsule;
        const [ax] = anchor.get_transformed_position();
        const [aw] = anchor.get_transformed_size();
        const [, cy] = this._capsule?.get_transformed_position() ?? anchor.get_transformed_position();
        const [, w] = frame.get_preferred_width(-1);
        const [, h] = frame.get_preferred_height(w);
        const area = dockWorkArea();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let x = insideDock(ax + aw / 2 - w / 2, w, this._capsule);
        x = Math.min(Math.max(x, area.x + 4 * sf), area.x + area.width - w - 4 * sf);
        const y = Math.max(cy - GAP * sf - h, area.y + 4 * sf);
        frame.set_position(Math.round(x), Math.round(y));
        const half = ARROW * sf / 2;
        const center = Math.min(Math.max(ax + aw / 2, x + RADIUS * sf), x + w - RADIUS * sf);
        // The turned square's half diagonal hangs under the panel's edge.
        const reach = Math.ceil(half * Math.SQRT2);
        this._arrow.set_size(2 * reach, reach);
        this._arrow.set_position(Math.round(center - reach), Math.round(y + h));
        this._arrow.get_first_child().set_position(reach - half, -half - 1);
    }

    _onEvent(event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        if (this._panel.contains(global.stage.get_event_actor(event)))
            return Clutter.EVENT_PROPAGATE;
        // Outside (the bell too: its click would open it again).
        this.close();
        return Clutter.EVENT_STOP;
    }

    close(animate = true) {
        const frame = this._panel;
        if (!frame)
            return;
        const arrow = this._arrow;
        this._panel = null;
        this._content = null;
        this._arrow = null;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        frame.reactive = false;
        const done = () => [frame, arrow].forEach(dropChrome);
        if (animate) {
            arrow.ease({opacity: 0, duration: ms(OUT_TIME)});
            frame.ease({opacity: 0, translation_y: RISE / 2, duration: ms(OUT_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: done});
        } else {
            done();
        }
        this._state.command('panel-open', 'notifications', false);
        this._state.release('notifications');
    }

    // ---------- the popup ----------
    // Only the latest shows: a new one takes the place of the one on screen.
    _toast(entry) {
        this._dropToast(false);
        const toast = this._toastActor = new St.Widget({layout_manager: new Clutter.BinLayout(), reactive: true});
        const card = new St.Button({style_class: 'isla-np-aviso', reactive: true, track_hover: true, can_focus: false,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE, accessible_name: `${entry.appName}: ${entry.title}`});
        const look = this._look(card);
        dressFrame(look, toast, card, TOAST_RADIUS);
        // One row (notificaciones-compactas.md): icon | app · time and the title | the first action, ×.
        const row = new St.BoxLayout({style_class: 'isla-np-fila', x_expand: true});
        const tile = new St.Bin({style_class: `isla-np-icono ${entry.kind}`, y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({gicon: this.store.gicon(entry), icon_size: 18, fallback_icon_name: 'dialog-information-symbolic'})});
        row.add_child(tile);
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'isla-np-texto',
            y_align: Clutter.ActorAlign.CENTER});
        const meta = new St.BoxLayout({style_class: 'isla-np-meta'});
        const app = new St.Label({style_class: `isla-np-app ${entry.kind}`, text: entry.appName || _('Sistema')});
        app.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        meta.add_child(app);
        meta.add_child(new St.Label({style_class: 'isla-np-hora', text: `·  ${when(entry.time)}`}));
        text.add_child(meta);
        const title = new St.Label({style_class: 'isla-np-titulo-aviso', text: (entry.title || entry.body || '').replace(/\s+/g, ' ')});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(title);
        row.add_child(text);
        if (entry.actions.length) {
            const b = new St.Button({style_class: 'isla-np-accion', label: entry.actions[0], can_focus: false,
                y_align: Clutter.ActorAlign.CENTER});
            b.connect('clicked', () => {
                this._dropToast(true);
                Main.overview.hide();
                this.store.runAction(entry.id, 0);
            });
            row.add_child(b);
        }
        const close = new St.Button({style_class: 'isla-np-cerrar', can_focus: false, accessible_name: _('Cerrar'),
            y_align: Clutter.ActorAlign.CENTER, child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 11})});
        close.connect('clicked', () => this._dropToast(true));
        row.add_child(close);
        card.set_child(row);
        card.connect('clicked', (_b, button) => {
            this._dropToast(true);
            if (button === 1) {
                Main.overview.hide();
                this.store.activate(entry.id);
            }
        });
        card.connect('notify::hover', () => {
            // A popup on its way out (or a newer one in its place) keeps its own timer.
            if (this._toastActor !== toast)
                return;
            if (card.hover)
                this._stopToastTimer();
            else
                this._startToastTimer(entry);
        });
        addPanelChrome(toast);
        global.compositor.disable_unredirect();
        this._placeToast();
        toast.connect('notify::height', () => this._placeToast());
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        toast.set({opacity: 0, translation_y: RISE * sf});
        toast.ease({opacity: 255, translation_y: 0, duration: ms(IN_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._startToastTimer(entry);
        // A window keeps the dock hidden: it peeks out with the popup.
        this._state.command('nudge');
    }

    // Over the dock, by the bell when the dock is open; else over the island's middle.
    _placeToast() {
        const toast = this._toastActor;
        if (!toast)
            return;
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const area = dockWorkArea();
        const mon = dockMonitor();
        const [, w] = toast.get_preferred_width(-1);
        const [, h] = toast.get_preferred_height(w);
        const bell = this._state.mode === Mode.EXPANDED ? this._state.skin?.isla?._apps?.notificationsItem : null;
        const anchor = bell?.mapped ? bell : this._capsule;
        const [ax] = anchor.get_transformed_position();
        const [aw] = anchor.get_transformed_size();
        const [, cy] = this._capsule.get_transformed_position();
        const top = Math.min(cy, mon.y + mon.height - 40 * sf);
        let x = ax + aw / 2 - w / 2;
        x = Math.min(Math.max(x, area.x + 8 * sf), area.x + area.width - w - 8 * sf);
        toast.set_position(Math.round(x), Math.round(top - GAP * sf - h));
    }

    _startToastTimer(entry) {
        this._stopToastTimer();
        if (entry.urgency === MessageTray.Urgency.CRITICAL)
            return;
        this._toastTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOW_TIME, () => {
            this._toastTimer = 0;
            this._dropToast(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopToastTimer() {
        if (this._toastTimer)
            GLib.source_remove(this._toastTimer);
        this._toastTimer = 0;
    }

    // It leaves the screen; the notice stays in the panel.
    _dropToast(animate) {
        this._stopToastTimer();
        if (this._toastIdle)
            GLib.source_remove(this._toastIdle);
        this._toastIdle = 0;
        this._nextToast = null;
        const toast = this._toastActor;
        if (!toast)
            return;
        this._toastActor = null;
        global.compositor.enable_unredirect();
        const done = () => dropChrome(toast);
        if (!animate) {
            toast.remove_all_transitions();
            done();
            return;
        }
        // No clicks while it fades (not before an immediate destroy: the 'insensitive' style it
        // queues then reached the dead actor, St-CRITICAL "not in the stage").
        toast.reactive = false;
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        toast.ease({opacity: 0, translation_y: RISE * sf, duration: ms(OUT_TIME), mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: done});
    }

    destroy() {
        this.close(false);
        this._dropToast(false);
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
        this._showGnomeList();
        this._banners.release();
        this.store.destroy();
        this.store = null;
        this._state.notifUnread = this._state.notifWaiting = 0;
    }
}
