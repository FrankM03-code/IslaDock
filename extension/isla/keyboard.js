// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Distribución de teclado: with more than one input source, its short name
// (ES, EN…) in the folded island and, in the open dock, a button that moves
// to the next one. With a single source nothing shows.
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';
import {_, fmt} from './i18n.js';

const ORDER = 20;

export class KeyboardStatus {
    constructor({state}) {
        this._state = state;
        this._manager = getInputSourceManager();
        this._folded = new St.Label({style_class: 'isla-teclado', y_align: Clutter.ActorAlign.CENTER});
        this._open = new St.Button({style_class: 'isla-teclado isla-teclado-boton', can_focus: true, reactive: true,
            track_hover: true, y_align: Clutter.ActorAlign.CENTER, label: ''});
        this._open.connect('clicked', () => this._next());
        this._ids = [
            this._manager.connect('sources-changed', () => this._sync()),
            this._manager.connect('current-source-changed', () => this._sync()),
        ];
        this._sync();
    }

    _sources() {
        return Object.values(this._manager.inputSources ?? {}).sort((a, b) => a.index - b.index);
    }

    _next() {
        const sources = this._sources();
        if (sources.length < 2)
            return;
        const at = sources.indexOf(this._manager.currentSource);
        sources[(at + 1) % sources.length].activate(true);
    }

    _sync() {
        const sources = this._sources();
        const current = this._manager.currentSource;
        if (sources.length < 2 || !current) {
            this._state.removeStatus('keyboard');
            return;
        }
        const name = current.shortName.toUpperCase();
        this._folded.text = name;
        this._open.label = name;
        this._open.accessible_name = fmt(_('Teclado: {nombre}. Clic para cambiar'), {nombre: current.displayName});
        this._state.setStatus('keyboard', {order: ORDER, folded: this._folded, open: this._open});
    }

    destroy() {
        this._state.removeStatus('keyboard');
        this._ids.forEach(id => this._manager.disconnect(id));
        this._folded.destroy();
        this._open.destroy();
    }
}
