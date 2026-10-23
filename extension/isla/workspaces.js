// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Espacios de trabajo: one dot per workspace, the active one longer. Folded it
// only shows; in the open dock a click on a dot goes to that workspace and the
// wheel over the dots goes to the next or previous one. With dynamic
// workspaces the empty one GNOME keeps at the end is not counted, so with a
// single workspace in use nothing shows ('espacios-trabajo' switches it off).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';

const ORDER = 10;

export class WorkspacesStatus {
    constructor({state}) {
        this._state = state;
        this._manager = global.workspace_manager;
        this._mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._folded = new St.BoxLayout({style_class: 'isla-espacios', y_align: Clutter.ActorAlign.CENTER});
        this._open = new St.BoxLayout({style_class: 'isla-espacios isla-espacios-abierto', y_align: Clutter.ActorAlign.CENTER,
            reactive: true});
        this._open.connect('scroll-event', (_a, event) => this._onScroll(event));
        this._ids = [
            this._manager.connect('active-workspace-changed', () => this._sync()),
            this._manager.connect('notify::n-workspaces', () => this._sync()),
            this._manager.connect('workspaces-reordered', () => this._sync()),
        ];
        this._mutterId = this._mutter.connect('changed::dynamic-workspaces', () => this._sync());
        // An empty workspace at the end comes and goes as windows move.
        this._wsIds = new Map();
        this._sync();
    }

    _watchWorkspaces() {
        const now = new Set();
        for (let i = 0; i < this._manager.n_workspaces; i++) {
            const ws = this._manager.get_workspace_by_index(i);
            now.add(ws);
            if (!this._wsIds.has(ws)) {
                this._wsIds.set(ws, [ws.connect('window-added', () => this._queueSync()),
                    ws.connect('window-removed', () => this._queueSync())]);
            }
        }
        for (const [ws, ids] of this._wsIds) {
            if (!now.has(ws)) {
                ids.forEach(id => ws.disconnect(id));
                this._wsIds.delete(ws);
            }
        }
    }

    _queueSync() {
        if (this._later)
            return;
        this._later = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._later = 0;
            this._sync();
            return false;
        });
    }

    // Workspaces shown: all, but the trailing empty one of dynamic workspaces.
    _count() {
        let n = this._manager.n_workspaces;
        const active = this._manager.get_active_workspace_index();
        if (this._mutter.get_boolean('dynamic-workspaces') && n > 1 && active !== n - 1) {
            const last = this._manager.get_workspace_by_index(n - 1);
            if (!last.list_windows().some(w => !w.skip_taskbar))
                n--;
        }
        return n;
    }

    _go(index) {
        const ws = this._manager.get_workspace_by_index(index);
        ws?.activate(global.get_current_time());
    }

    _onScroll(event) {
        const dir = event.get_scroll_direction();
        let step = 0;
        if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
            step = -1;
        else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
            step = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            const d = Math.abs(dy) > Math.abs(dx) ? dy : dx;
            // A touchpad sends many small steps: one workspace per gesture.
            const now = event.get_time();
            if (Math.abs(d) < 0.5 || now - (this._lastScroll ?? 0) < 250)
                return Clutter.EVENT_STOP;
            this._lastScroll = now;
            step = d > 0 ? 1 : -1;
        }
        const at = this._manager.get_active_workspace_index();
        const to = Math.max(0, Math.min(this._count() - 1, at + step));
        if (step && to !== at)
            this._go(to);
        return Clutter.EVENT_STOP;
    }

    _fill(box, n, active, buttons) {
        while (box.get_n_children() > n)
            box.get_last_child().destroy();
        while (box.get_n_children() < n) {
            const i = box.get_n_children();
            if (buttons) {
                const b = new St.Button({style_class: 'isla-espacio-boton', can_focus: true, reactive: true, track_hover: true,
                    y_align: Clutter.ActorAlign.CENTER, child: new St.Widget({style_class: 'isla-espacio'})});
                b.connect('clicked', () => this._go(i));
                box.add_child(b);
            } else {
                box.add_child(new St.Widget({style_class: 'isla-espacio', y_align: Clutter.ActorAlign.CENTER}));
            }
        }
        box.get_children().forEach((child, i) => {
            const dot = buttons ? child.child : child;
            if (i === active)
                dot.add_style_class_name('activo');
            else
                dot.remove_style_class_name('activo');
            if (buttons)
                child.accessible_name = `Espacio de trabajo ${i + 1}`;
        });
    }

    _sync() {
        this._watchWorkspaces();
        const n = this._count();
        if (n < 2) {
            this._state.removeStatus('workspaces');
            return;
        }
        const active = this._manager.get_active_workspace_index();
        this._fill(this._folded, n, active, false);
        this._fill(this._open, n, active, true);
        this._state.setStatus('workspaces', {order: ORDER, folded: this._folded, open: this._open});
    }

    destroy() {
        if (this._later)
            global.compositor.get_laters().remove(this._later);
        this._later = 0;
        this._state.removeStatus('workspaces');
        this._ids.forEach(id => this._manager.disconnect(id));
        this._mutter.disconnect(this._mutterId);
        for (const [ws, ids] of this._wsIds)
            ids.forEach(id => ws.disconnect(id));
        this._wsIds.clear();
        this._folded.destroy();
        this._open.destroy();
    }
}
