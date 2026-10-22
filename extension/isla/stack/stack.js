// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Pila de descargas: the Downloads button of the open island shows the latest
// downloads as a diagonal cascade or a grid. This module owns the folder model
// and the popup, keeps the button's dot and ring up to date and, when a
// download finishes, opens the island as a notice.
//
// Commands it listens to: 'stack-toggle' (anchor actor).
// Commands it sends: 'downloads-state' ({busy, fresh, progress}), 'notice'.
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {DownloadsModel} from './downloadsModel.js';
import {StackPopup} from './stackPopup.js';

// Browsers that publish LauncherEntry progress for their downloads.
const DOWNLOADERS = /firefox|chrom|brave|vivaldi|edge|epiphany|librewolf|floorp|zen|transmission|fragments|motrix/i;

export class Stack {
    constructor({state, settings, capsule}) {
        this._state = state;
        this._settings = settings;
        this._model = new DownloadsModel(settings);
        this._popup = new StackPopup({state, settings, model: this._model, capsule});
        this._ids = [
            [state, state.connect('command', (_s, name, ...args) => {
                if (name === 'stack-toggle')
                    this._popup.toggle(args[0]);
            })],
            [state, state.connect('launcher-progress', () => this._update())],
            [this._model, this._model.connect('changed', () => this._update())],
            [this._model, this._model.connect('seen', () => this._update())],
            [this._model, this._model.connect('finished', (_m, entry) => this._finished(entry))],
        ];
    }

    // A real percentage only when exactly one download runs and exactly one
    // downloader publishes progress: otherwise it can't be told whose it is.
    _realProgress(partials) {
        const published = (this._state.launcherProgress ?? []).filter(p => DOWNLOADERS.test(p.id));
        return partials.length === 1 && published.length === 1 ? published[0].progress : null;
    }

    _update() {
        const partials = this._model.files.filter(f => f.partial);
        const progress = this._realProgress(partials);
        for (const f of partials)
            f.progress = progress;
        this._state.command('downloads-state', {busy: partials.length > 0, fresh: this._model.fresh, progress});
    }

    _finished(entry) {
        if (this._state.dnd || !this._settings.get_boolean('stack-show-aviso'))
            return;
        this._state.command('notice', {
            actor: this._noticeActor(entry),
            color: [47, 125, 225],
            activate: () => this._state.command('stack-open'),
        });
    }

    _noticeActor(entry) {
        const box = new St.BoxLayout({style_class: 'isla-aviso'});
        box.add_child(new St.Icon({style_class: 'isla-aviso-icono', gicon: entry.gicon, fallback_icon_name: 'folder-download-symbolic',
            y_align: Clutter.ActorAlign.CENTER}));
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        const title = new St.Label({style_class: 'isla-aviso-titulo', text: 'Descarga lista'});
        const body = new St.Label({style_class: 'isla-aviso-cuerpo', text: entry.display});
        body.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        text.add_child(title);
        text.add_child(body);
        box.add_child(text);
        return box;
    }

    destroy() {
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
        this._popup.destroy();
        this._model.destroy();
        this._state.command('downloads-state', {busy: false, fresh: false, progress: null});
    }
}
