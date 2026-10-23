// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Pila de descargas: the Downloads button of the open island shows the latest
// downloads as a diagonal cascade, a grid or a list. This module owns the
// folder model and the popup, keeps the button's dot and ring up to date and,
// when a download finishes, sends a notification (it shows at the top, like
// every other one).
//
// Commands it listens to: 'stack-toggle' (anchor actor).
// Commands it sends: 'downloads-state' ({busy, fresh, progress, transfer}).
//
// Browsers on GNOME publish no percentage, so while something downloads the
// size of its partial file is read every second: how much has arrived and how
// fast (the total is unknown, so no percentage or time left is made up).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {DownloadsModel} from './downloadsModel.js';
import {StackPopup} from './stackPopup.js';

// Browsers that publish LauncherEntry progress for their downloads.
const DOWNLOADERS = /firefox|chrom|brave|vivaldi|edge|epiphany|librewolf|floorp|zen|transmission|fragments|motrix/i;
const SAMPLE = 1000;     // ms between readings of the partial files
const SMOOTH = 0.4;      // weight of the newest speed reading

function transferText(bytes, speed) {
    if (!bytes)
        return null;
    const size = GLib.format_size(bytes);
    return speed > 0 ? `${size} · ${GLib.format_size(Math.round(speed))}/s` : size;
}

export class Stack {
    constructor({state, settings, capsule}) {
        this._state = state;
        this._settings = settings;
        this._model = new DownloadsModel(settings);
        this._popup = new StackPopup({state, settings, model: this._model, capsule});
        this._rates = new Map();     // partial file path -> {bytes, at (µs), speed (bytes/s) or null}
        this._sampleId = 0;
        this._cancellable = new Gio.Cancellable();
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
        for (const f of partials) {
            f.progress = progress;
            const rate = this._rates.get(f.path);
            f.transfer = transferText(rate?.bytes ?? f.size, rate?.speed);
        }
        this._keepSampling(partials.length > 0);
        // All downloads together on the button.
        const bytes = partials.reduce((sum, f) => sum + (this._rates.get(f.path)?.bytes ?? f.size ?? 0), 0);
        const speed = partials.reduce((sum, f) => sum + (this._rates.get(f.path)?.speed ?? 0), 0);
        this._state.command('downloads-state', {busy: partials.length > 0, fresh: this._model.fresh, progress,
            transfer: transferText(bytes, speed)});
    }

    _keepSampling(on) {
        if (on && !this._sampleId) {
            this._sampleId = GLib.timeout_add(GLib.PRIORITY_LOW, SAMPLE, () => {
                this._sample();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!on && this._sampleId) {
            GLib.source_remove(this._sampleId);
            this._sampleId = 0;
            this._rates.clear();
        }
    }

    // Reads every partial file's size; when all have answered, the texts change in place.
    _sample() {
        const partials = this._model.files.filter(f => f.partial && f.path);
        for (const path of [...this._rates.keys()]) {
            if (!partials.some(f => f.path === path))
                this._rates.delete(path);
        }
        let left = partials.length;
        for (const f of partials) {
            Gio.File.new_for_path(f.path).query_info_async('standard::size', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_LOW, this._cancellable, (file, res) => {
                    try {
                        this._record(f.path, file.query_info_finish(res).get_size());
                    } catch (e) {
                        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            return;
                    }
                    if (--left === 0) {
                        this._update();
                        this._model.emit('transfer');
                    }
                });
        }
    }

    _record(path, bytes) {
        const now = GLib.get_monotonic_time();
        const last = this._rates.get(path);
        let speed = last?.speed ?? null;
        if (last && now > last.at) {
            const fresh = Math.max(0, bytes - last.bytes) / ((now - last.at) / 1e6);
            speed = speed === null ? fresh : SMOOTH * fresh + (1 - SMOOTH) * speed;
        }
        this._rates.set(path, {bytes, at: now, speed});
    }

    _finished(entry) {
        if (!this._settings.get_boolean('stack-show-aviso'))
            return;
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Descargas', iconName: 'folder-download-symbolic'});
            this._source.connect('destroy', () => (this._source = null));
            Main.messageTray.add(this._source);
        }
        const notification = new MessageTray.Notification({source: this._source, title: 'Descarga lista',
            body: entry.display, gicon: entry.gicon, isTransient: true});
        notification.connect('activated', () => this._state.command('stack-open'));
        this._source.addNotification(notification);
    }

    destroy() {
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
        this._cancellable.cancel();
        this._keepSampling(false);
        this._source?.destroy();
        this._popup.destroy();
        this._model.destroy();
        this._state.command('downloads-state', {busy: false, fresh: false, progress: null});
    }
}
