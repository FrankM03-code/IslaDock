// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The open stack: picks the view, places it over its button (Descargas, or
// Archivos for the folders) inside the work area, holds the island open and
// takes the keyboard. Esc, a click outside it, the overview or a skin change
// close it. A model may bring its own labels, menu and folder action.
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {CascadeView} from './cascadeView.js';
import {GridView} from './gridView.js';
import {ListView} from './listView.js';
import * as FileActions from './fileActions.js';
import {Mode} from '../state.js';
import {dockWorkArea} from '../monitor.js';

const VIEWS = {cascade: CascadeView, grid: GridView, list: ListView};

export class StackPopup {
    constructor({state, settings, model, capsule, holdId = 'stack'}) {
        this._state = state;
        this._holdId = holdId;
        this._capsule = capsule;
        this._settings = settings;
        this._model = model;
        this._view = null;
        this._ids = [
            [state, state.connect('skin-changed', () => this.close(false))],
            [state, state.connect('mode-changed', (_s, mode) => mode !== Mode.EXPANDED && this.close())],
            [Main.overview, Main.overview.connect('showing', () => this.close(false))],
            [model, model.connect('changed', () => this._refill())],
            // How much of each download has arrived: new texts, same view.
            [model, model.connect('transfer', () => this._view?.updateTransfer())],
        ];
    }

    get isOpen() {
        return !!this._view;
    }

    toggle(anchor) {
        if (this._view)
            this.close();
        else
            this.open(anchor);
    }

    _kind() {
        const view = this._settings.get_string('stack-view');
        return VIEWS[view] ? view : 'cascade';
    }

    _max(kind) {
        return this._settings.get_int(`stack-${kind}-max`);
    }

    open(anchor) {
        // Only over the open island (its button must be on screen).
        if (this._view || !this._state.skin || this._state.mode !== Mode.EXPANDED)
            return;
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const style = this._state.skin.getStackStyle();
        const on = {
            open: entry => {
                this.close();
                FileActions.launch(entry.uri);
            },
            menu: (entry, actor) => this._openMenu(entry, actor),
            folder: () => {
                this.close();
                if (this._model.openMain)
                    this._model.openMain();
                else
                    FileActions.openFolder(this._model.folder);
            },
        };
        this._kindShown = this._kind();
        const View = VIEWS[this._kindShown];
        const view = this._view = new View({style, sf, on, labels: this._model.labels});
        this._anchor = anchor;
        Main.layoutManager.addTopChrome(view.actor);
        view.fill(this._model.files, this._model.total, this._max(this._kindShown));
        this._place();
        view.actor.connect('captured-event', (_a, event) => this._onEvent(event));
        view.actor.connect('key-press-event', (_a, event) => this._onKey(event));
        this._grab = Main.pushModal(view.actor, {actionMode: Shell.ActionMode.POPUP});
        view.focus(0);
        view.animateIn();
        this._state.hold(this._holdId);
        this._state.command('hide-tooltip');
        if (this._model.markSeen) {
            this._model.markSeen();
            this._model.emit('seen');
        }
    }

    _place() {
        const anchor = this._anchor;
        const capsule = this._capsule;
        const [ax] = anchor.get_transformed_position();
        const [aw] = anchor.get_transformed_size();
        const [, cy] = capsule?.get_transformed_position() ?? anchor.get_transformed_position();
        const area = dockWorkArea();
        this._view.place(ax + aw / 2, cy, area);
    }

    // The folder changed while the stack is open: the same view, refilled.
    _refill() {
        const view = this._view;
        if (!view)
            return;
        view.fill(this._model.files, this._model.total, this._max(this._kindShown));
        this._place();
        const focus = global.stage.get_key_focus();
        if (!focus || !view.actor.contains(focus))
            view.focus(0);
    }

    _onEvent(event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        const target = global.stage.get_event_actor(event);
        if (this._view.actor.contains(target) || this._menu?.actor.contains(target))
            return Clutter.EVENT_PROPAGATE;
        this.close();
        return Clutter.EVENT_STOP;
    }

    _onKey(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        const focus = global.stage.get_key_focus();
        const inside = focus && this._view.actor.contains(focus);
        if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter, Clutter.KEY_space].includes(symbol)) {
            if (inside && focus instanceof St.Button)
                focus.emit('clicked', 1);
            return Clutter.EVENT_STOP;
        }
        if ((symbol === Clutter.KEY_Menu || (symbol === Clutter.KEY_F10 && event.get_state() & Clutter.ModifierType.SHIFT_MASK)) &&
            inside && focus.entry) {
            this._openMenu(focus.entry, focus);
            return Clutter.EVENT_STOP;
        }
        return this._view.navigate(symbol) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    // Abrir · Mostrar en la carpeta · Copiar ruta · Mover a la papelera
    _openMenu(entry, actor) {
        this._closeMenu();
        const menu = this._menu = new PopupMenu.PopupMenu(actor, 0.5, St.Side.BOTTOM);
        menu.actor.add_style_class_name('isla-menu');
        Main.uiGroup.add_child(menu.actor);
        this._menuManager = new PopupMenu.PopupMenuManager(this._view.actor);
        this._menuManager.addMenu(menu);
        if (this._model.fillMenu)
            this._model.fillMenu(menu, entry, () => this.close());
        else
            this._fillFileMenu(menu, entry);
        menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                this._view?.focus(0);
        });
        menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _fillFileMenu(menu, entry) {
        menu.addAction('Abrir', () => {
            this.close();
            FileActions.launch(entry.uri);
        });
        menu.addAction('Mostrar en la carpeta', () => {
            this.close();
            FileActions.showInFolder(entry);
        });
        menu.addAction('Copiar ruta', () => FileActions.copyPath(entry));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Mover a la papelera…', () => {
            this.close();
            FileActions.confirmTrash(entry);
        });
    }

    _closeMenu() {
        if (!this._menu)
            return;
        this._menu.destroy();
        this._menu = null;
        this._menuManager = null;
    }

    close(animate = true) {
        const view = this._view;
        if (!view)
            return;
        this._view = null;
        this._closeMenu();
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        view.actor.reactive = false;
        const done = () => {
            Main.layoutManager.removeChrome(view.actor);
            view.destroy();
        };
        if (animate)
            view.animateOut(done);
        else
            done();
        this._state.release(this._holdId);
    }

    destroy() {
        this.close(false);
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
    }
}
