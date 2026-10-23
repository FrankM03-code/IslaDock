// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The island's state machine and the activity priorities. Modules never call
// each other: they publish activities and commands here and listen to its
// signals, so each one can be switched off without breaking the rest.
//
// Signals:
//   'mode-changed' (newMode, oldMode)
//   'activities-changed'
//   'dnd-changed' (on)
//   'compact-changed' (on)      the open dock would not fit the screen: panels drop their text
//   'command' (name, ...args)   e.g. 'media', 'playpause' | 'toggle-dnd' | 'volume-level', 0.4
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

export const Mode = {
    COLLAPSED: 'colapsada',
    EXPANDED: 'expandida',
    NOTICE: 'aviso',
    SEARCH: 'busqueda',
};

// Lower number = more important (section 3 of ISLA.md). The notice itself is a mode.
export const Priority = {
    RECORDING: 1,
    TIMER_DONE: 2,
    MUSIC: 3,
    PROGRESS: 4,
    TIMER: 5,
};

const ALLOWED = {
    [Mode.COLLAPSED]: [Mode.EXPANDED, Mode.NOTICE, Mode.SEARCH],
    [Mode.EXPANDED]: [Mode.COLLAPSED, Mode.SEARCH],
    [Mode.NOTICE]: [Mode.COLLAPSED, Mode.EXPANDED, Mode.SEARCH],
    [Mode.SEARCH]: [Mode.COLLAPSED, Mode.EXPANDED],
};

export class IslaState extends Signals.EventEmitter {
    constructor() {
        super();
        this._mode = Mode.COLLAPSED;
        this._activities = new Map();   // id -> {priority, mini, panel, order}
        this._order = 0;
        this.dnd = false;
        this.notice = null;
        this.compact = false;
        this._holds = new Set();
    }

    get mode() {
        return this._mode;
    }

    // Returns false when the transition is not allowed from the current mode.
    setMode(mode) {
        if (mode === this._mode)
            return true;
        if (!ALLOWED[this._mode].includes(mode))
            return false;
        const old = this._mode;
        this._mode = mode;
        this.emit('mode-changed', mode, old);
        return true;
    }

    // An activity owns two actors: a miniature for the collapsed island and a
    // panel for the expanded one (either may be null).
    setActivity(id, {priority, mini = null, panel = null}) {
        const old = this._activities.get(id);
        this._activities.set(id, {id, priority, mini, panel, order: old?.order ?? this._order++});
        if (!old || old.priority !== priority || old.mini !== mini || old.panel !== panel)
            this.emit('activities-changed');
    }

    removeActivity(id) {
        if (this._activities.delete(id))
            this.emit('activities-changed');
    }

    // Most important first; equal priorities keep their arrival order.
    get activities() {
        return [...this._activities.values()].sort((a, b) => a.priority - b.priority || a.order - b.order);
    }

    get mainActivity() {
        return this.activities[0] ?? null;
    }

    // A module that needs the island open (a menu, a preview card) holds it.
    hold(id) {
        this._holds.add(id);
    }

    release(id) {
        if (this._holds.delete(id) && !this._holds.size)
            this.command('maybe-fold');
    }

    get keepOpen() {
        return this._holds.size > 0;
    }

    setDnd(on) {
        if (this.dnd === on)
            return;
        this.dnd = on;
        this.emit('dnd-changed', on);
    }

    setCompact(on) {
        if (this.compact === on)
            return;
        this.compact = on;
        this.emit('compact-changed', on);
    }

    command(name, ...args) {
        this.emit('command', name, ...args);
    }

    destroy() {
        this._activities.clear();
        this.disconnectAll();
    }
}
