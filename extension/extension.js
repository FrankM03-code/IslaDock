// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// islaDock: the dock as an island on the bottom edge of the screen.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {IconResolver} from './iconResolver.js';
import {DoNotDisturb} from './isla/dnd.js';
import {Gestures} from './isla/gestures.js';
import {Isla} from './isla/isla.js';
import {Media} from './isla/media.js';
import {Notices} from './isla/notices.js';
import {Previews} from './isla/previews.js';
import {PrefsWindow} from './isla/prefsWindow.js';
import {Search} from './isla/search.js';
import {Timer} from './isla/timer.js';
import {Progress} from './isla/progress.js';
import {Stack} from './isla/stack/stack.js';
import {IslaState} from './isla/state.js';

// Modules that a setting can switch off: [key or null, factory].
const MODULES = {
    gestures: [null, ctx => new Gestures(ctx)],
    dnd: [null, ctx => new DoNotDisturb(ctx)],
    media: ['isla-musica', ctx => new Media(ctx)],
    notices: ['isla-avisos', ctx => new Notices(ctx)],
    timer: [null, ctx => new Timer(ctx)],
    search: [null, ctx => new Search(ctx)],
    previews: ['isla-vistas-previas', ctx => new Previews(ctx)],
    progress: ['isla-progreso', ctx => new Progress(ctx)],
    stack: [null, ctx => new Stack(ctx)],
    prefsWindow: [null, ctx => new PrefsWindow(ctx)],
};

export default class IslaDockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // Vidrio líquido was replaced by Vidrio oscuro (2026-10-21).
        if (this._settings.get_string('isla-piel') === 'vidrio-liquido')
            this._settings.set_string('isla-piel', 'vidrio-oscuro');
        this._resolver = new IconResolver(this.dir, this._settings);
        this._modules = new Map();
        this._ids = [];
        if (Main.layoutManager._startingUp)
            this._startId = Main.layoutManager.connect('startup-complete', () => this._build());
        else
            this._build();
    }

    _build() {
        if (this._startId) {
            Main.layoutManager.disconnect(this._startId);
            this._startId = 0;
        }
        this._state = new IslaState();
        this._isla = new Isla({settings: this._settings, resolver: this._resolver, state: this._state});
        this._ctx = {state: this._state, settings: this._settings, capsule: this._isla.capsule, title: this.metadata.name};
        for (const [name, [key]] of Object.entries(MODULES)) {
            this._sync(name);
            if (key)
                this._ids.push(this._settings.connect(`changed::${key}`, () => this._sync(name)));
        }
    }

    _sync(name) {
        const [key, create] = MODULES[name];
        const on = !key || this._settings.get_boolean(key);
        const module = this._modules.get(name);
        if (on && !module) {
            try {
                this._modules.set(name, create(this._ctx));
            } catch (e) {
                console.error(`isla-dock: no se pudo iniciar ${name}: ${e.message}`);
            }
        } else if (!on && module) {
            module.destroy();
            this._modules.delete(name);
        }
    }

    disable() {
        if (this._startId)
            Main.layoutManager.disconnect(this._startId);
        this._startId = 0;
        this._ids.forEach(id => this._settings.disconnect(id));
        this._ids = [];
        // Modules first: they hand back what they lent to the island.
        for (const module of this._modules.values())
            module.destroy();
        this._modules.clear();
        this._isla?.destroy();
        this._isla = null;
        this._state?.destroy();
        this._state = null;
        this._ctx = null;
        this._resolver.destroy();
        this._resolver = null;
        this._settings = null;
    }
}
