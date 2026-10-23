// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The row of app icons shown when the island is open: favorites, other open
// apps, Downloads and Trash. Clicks, right-click menu, drag to reorder,
// magnification and the name tooltip. A left click on Downloads asks the
// stack module (isla/stack) to open the Downloads stack.
//
// Signals: 'changed' (running apps or items changed), 'busy-changed' (a menu or a
// drag started/ended: the island must not fold meanwhile).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {DockItem, DockSeparator} from '../dockItem.js';
import {RowLayout} from './row.js';
import {dockMonitor} from './monitor.js';
import {downloadsDir} from './stack/downloadsModel.js';

// Magnification by distance to the hovered icon, as a factor of the base size.
const ZOOM = [1.45, 1.22, 1.08];
const TOOLTIP_GAP = 10;

export class AppsRow extends Signals.EventEmitter {
    constructor({settings, resolver, state}) {
        super();
        this._settings = settings;
        this._state = state;
        this._resolver = resolver;
        this._appSystem = Shell.AppSystem.get_default();
        this._items = new Map();      // key -> DockItem | DockSeparator
        this._appItems = [];
        this._runningOrder = [];
        this._hovered = -1;
        this._signals = [];
        this._timeouts = new Map();
        this._downloads = {busy: false, fresh: false, progress: null};
        this._trashFull = false;
        this._badges = new Map();     // app id -> count

        this._layout = new RowLayout(0);
        this.actor = new St.Widget({style_class: 'isla-apps', layout_manager: this._layout, y_align: Clutter.ActorAlign.END});
        this.actor._delegate = this;   // drop target for reordering
        this.actor.connect('destroy', () => this._dropSources(true));
        // Energía and its line go in a row of their own: the island puts it last, after the panels.
        this._tailLayout = new RowLayout(0);
        this.tail = new St.Widget({style_class: 'isla-apps-cola', layout_manager: this._tailLayout, y_align: Clutter.ActorAlign.END,
            visible: false});
        this._tooltip = new St.Label({style_class: 'isla-tooltip', visible: false, opacity: 0});
        Main.layoutManager.uiGroup.add_child(this._tooltip);
        this._menuManager = new PopupMenu.PopupMenuManager(this.actor);

        this.configure();
        this._rebuild();
        this._on(AppFavorites.getAppFavorites(), 'changed', () => this._rebuild());
        this._on(this._appSystem, 'app-state-changed', () => this._later('apps', 50, () => this._rebuild()));
        this._on(this._appSystem, 'installed-changed', () => this._refreshIcons());
        // One mark per open window under each icon, another look for the app in front.
        const tracker = Shell.WindowTracker.get_default();
        this._on(tracker, 'tracked-windows-changed', () => this._later('windows', 50, () => this._refreshState()));
        this._on(tracker, 'notify::focus-app', () => this._refreshState());
        this._on(this._resolver, 'changed', () => this._refreshIcons());
        for (const key of ['mostrar-descargas', 'mostrar-papelera', 'mostrar-aplicaciones', 'mostrar-portapapeles', 'mostrar-energia'])
            this._on(this._settings, `changed::${key}`, () => this._rebuild());
        for (const key of ['tamano-base', 'magnificacion', 'desaturar-en-reposo'])
            this._on(this._settings, `changed::${key}`, () => this.configure());
        for (const key of ['portal-giro', 'isla-oscura'])
            this._on(this._settings, `changed::${key}`, () => this._updatePortal());
        // The Portal stays lit while the app grid is open.
        this._on(Main.overview, 'shown', () => this._updatePortal());
        this._on(Main.overview, 'hidden', () => this._updatePortal());
        if (Main.overview.dash?.showAppsButton)
            this._on(Main.overview.dash.showAppsButton, 'notify::checked', () => this._updatePortal());
        this._watchTrash();
    }

    // ---------- helpers ----------
    _on(obj, signal, fn) {
        this._signals.push([obj, obj.connect(signal, fn)]);
    }

    _later(name, ms, fn) {
        this._cancel(name);
        this._timeouts.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(name);
            fn();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _cancel(name) {
        const id = this._timeouts.get(name);
        if (id)
            GLib.source_remove(id);
        this._timeouts.delete(name);
    }

    _launch(uri) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notifyError('No se pudo abrir', e.message);
        }
    }

    get items() {
        return this._appItems;
    }

    // Open apps in dock order: [{app, item}].
    get running() {
        return this._appItems.filter(i => i.kind === 'app' && i.running).map(item => ({app: item.app, item}));
    }

    get busy() {
        return !!this._dragging || this._appItems.some(i => i._dockMenu?.isOpen);
    }

    // ---------- sizes ----------
    // The skin decides the spacing and whether icons stay in full color.
    setSkin(skin) {
        this._skin = skin;
        this.configure();
        this._updatePortal();
    }

    // Contrast with the skin, spinning, and lit while the app grid is open.
    _updatePortal() {
        const portal = this._items?.get('apps')?.portal;
        if (!portal)
            return;
        portal.setGraphite(this._skin?.portalGraphite ?? false);
        portal.spin = this._settings.get_boolean('portal-giro');
        const showApps = Main.overview.dash?.showAppsButton;
        portal.setOpen(Main.overview.visible && !!showApps?.checked);
    }

    configure() {
        const skin = this._skin;
        const base = this._settings.get_int('tamano-base');
        const magnify = this._settings.get_boolean('magnificacion');
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._p = {
            base,
            max: magnify ? Math.round(base * ZOOM[0]) : base,
            magnify,
            scale: sf,
            calm: this._settings.get_boolean('desaturar-en-reposo') && !skin?.forcesColorIcons,
        };
        const spacing = (skin?.itemSpacing ?? 6) / 32;
        this._layout.spacing = this._tailLayout.spacing = Math.round(base * spacing * sf);
        this._layout.layout_changed();
        this._tailLayout.layout_changed();
        for (const actor of this._items.values())
            actor.configure(this._p);
        this._hovered = -1;
    }

    // ---------- items ----------
    _appIcon(app) {
        const own = app.get_app_info()?.get_icon();
        const names = own instanceof Gio.ThemedIcon ? own.get_names() : [];
        const id = app.get_id().replace(/\.desktop$/, '');
        return this._resolver.lookup(id, app.get_icon(), names);
    }

    iconOf(app) {
        return this._appIcon(app);
    }

    _downloadsDir() {
        return downloadsDir(this._settings);
    }

    get clipboardItem() {
        return this._items?.get('clipboard') ?? null;
    }

    // Something was copied: the clipboard button hops.
    bounceClipboard() {
        const item = this.clipboardItem;
        if (!item?.mapped)
            return;
        const sf = this._p.scale;
        item.remove_transition('translation-y');
        item.ease({translation_y: -6 * sf, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => item.ease({translation_y: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_BOUNCE})});
    }

    get downloadsItem() {
        return this._items?.get('downloads') ?? null;
    }

    _entries() {
        const favorites = AppFavorites.getAppFavorites().getFavorites();
        const favIds = new Set(favorites.map(a => a.get_id()));
        const running = this._appSystem.get_running().filter(a => !favIds.has(a.get_id()));
        const runningIds = new Set(running.map(a => a.get_id()));
        this._runningOrder = this._runningOrder.filter(id => runningIds.has(id));
        for (const app of running) {
            if (!this._runningOrder.includes(app.get_id()))
                this._runningOrder.push(app.get_id());
        }
        const byId = new Map(running.map(a => [a.get_id(), a]));

        const entries = favorites.map(app => ({kind: 'app', key: app.get_id(), app}));
        const others = this._runningOrder.map(id => ({kind: 'app', key: id, app: byId.get(id)}));
        if (entries.length && others.length)
            entries.push({kind: 'separator', key: 'sep-1'});
        entries.push(...others);
        const extras = [];
        if (this._settings.get_boolean('mostrar-descargas'))
            extras.push({kind: 'downloads', key: 'downloads'});
        if (this._settings.get_boolean('mostrar-papelera'))
            extras.push({kind: 'trash', key: 'trash'});
        if (this._settings.get_boolean('mostrar-aplicaciones'))
            extras.push({kind: 'apps', key: 'apps'});
        if (entries.length && extras.length)
            entries.push({kind: 'separator', key: 'sep-2'});
        entries.push(...extras);
        // Portapapeles and Energía: last, after their own thin line.
        const tail = [];
        if (this._settings.get_boolean('mostrar-portapapeles'))
            tail.push({kind: 'clipboard', key: 'clipboard'});
        if (this._settings.get_boolean('mostrar-energia'))
            tail.push({kind: 'power', key: 'power'});
        if (entries.length && tail.length)
            entries.push({kind: 'separator', key: 'sep-3'});
        entries.push(...tail);
        return entries;
    }

    _createItem(entry) {
        if (entry.kind === 'separator')
            return new DockSeparator();
        const label = {app: entry.app?.get_name(), downloads: 'Descargas', trash: 'Papelera', apps: 'Aplicaciones',
            clipboard: 'Portapapeles', power: 'Energía'}[entry.kind];
        const item = new DockItem({kind: entry.kind, key: entry.key, app: entry.app ?? null, label});
        item.connect('activate', (_i, button) => this._onActivate(item, button));
        item.connect('hover-changed', (_i, hover) => this._onItemHover(item, hover));
        if (entry.kind === 'app')
            item.connect('scroll-event', (_i, event) => this._onItemScroll(item, event));
        item.connect('drag-started', () => {
            this._dragging = item;
            this.resetZoom();
            this._hideTooltip();
            this.emit('busy-changed');
        });
        item.connect('drag-ended', () => {
            this._dragging = null;
            // Back to the real order (a drop already changed the favorites).
            this._later('apps', 50, () => this._rebuild());
            this.emit('busy-changed');
        });
        return item;
    }

    _rebuild() {
        if (!this._items)
            return;
        const entries = this._entries();
        const keys = new Set(entries.map(e => e.key));
        for (const [key, actor] of this._items) {
            if (keys.has(key))
                continue;
            if (this._tooltipItem === actor)
                this._hideTooltip();
            actor.destroy();
            this._items.delete(key);
        }
        const inTail = entry => entry.kind === 'power' || entry.kind === 'clipboard' || entry.key === 'sep-3';
        const rows = [[this.actor, entries.filter(e => !inTail(e))], [this.tail, entries.filter(inTail)]];
        for (const [row, list] of rows) list.forEach((entry, i) => {
            let actor = this._items.get(entry.key);
            if (actor && entry.kind === 'app' && actor.app !== entry.app) {
                actor.destroy();
                actor = null;
            }
            if (!actor) {
                actor = this._createItem(entry);
                actor.configure(this._p);
                this._items.set(entry.key, actor);
                row.insert_child_at_index(actor, i);
            } else if (actor.get_parent() !== row) {
                actor.get_parent().remove_child(actor);
                row.insert_child_at_index(actor, i);
            } else if (row.get_child_at_index(i) !== actor) {
                row.set_child_at_index(actor, i);
            }
        });
        this.tail.visible = this.tail.get_n_children() > 0;
        this._appItems = [...this.actor.get_children(), ...this.tail.get_children()].filter(a => a.kind !== 'separator');
        for (const item of this._appItems)
            item.setBadge?.(item.app ? this._badges.get(item.app.get_id()) ?? null : null);
        this._hovered = -1;
        this._refreshIcons();
        this._refreshState();
        this._updatePortal();
        this.emit('changed');
    }

    _refreshIcons() {
        for (const item of this._appItems) {
            if (item.kind === 'app')
                item.setGIcon(this._appIcon(item.app));
            else if (item.kind === 'downloads')
                item.setGIcon(this._resolver.lookup('descargas', new Gio.ThemedIcon({name: 'folder-download'}), ['folder-download']));
            else if (item.kind === 'trash')
                item.setGIcon(this._trashIcon());
            else if (item.kind === 'apps')
                item.setGIcon(this._resolver.lookup('aplicaciones', new Gio.ThemedIcon({name: 'view-app-grid-symbolic'}),
                    ['view-app-grid', 'view-app-grid-symbolic', 'applications-all']));
        }
    }

    _trashIcon() {
        const name = this._trashFull ? 'user-trash-full' : 'user-trash';
        return this._resolver.lookup(this._trashFull ? 'papelera-llena' : 'papelera', new Gio.ThemedIcon({name}), [name]);
    }

    _refreshState() {
        for (const item of this._appItems) {
            if (item.kind === 'app') {
                const app = item.app;
                const windows = app.state === Shell.AppState.STOPPED ? 0
                    : Math.max(1, app.get_windows().filter(w => !w.skip_taskbar).length);
                item.setRunning(windows, Shell.WindowTracker.get_default().focus_app === app);
            }
            else if (item.kind === 'downloads')
                this._showDownloads(item);
        }
    }

    // A counter published by the app (unread messages, files left...).
    setBadge(appId, count) {
        if (count)
            this._badges.set(appId, count);
        else
            this._badges.delete(appId);
        this._appItems.find(i => i.app?.get_id() === appId)?.setBadge(count ?? null);
    }

    // ---------- clicks ----------
    // The app that opens folders (Archivos, or the one chosen for them).
    _isFolderApp(item) {
        if (item.kind !== 'app' || !item.app || !this._settings.get_boolean('carpetas-archivos'))
            return false;
        const id = Gio.AppInfo.get_default_for_type('inode/directory', false)?.get_id() ?? 'org.gnome.Nautilus.desktop';
        return item.app.get_id() === id;
    }

    _onActivate(item, button) {
        // All installed apps, with GNOME's own search on top.
        if (item.kind === 'apps') {
            if (Main.overview.visible)
                Main.overview.hide();
            else
                Main.overview.showApps();
            return;
        }
        // Portapapeles: its history panel.
        if (item.kind === 'clipboard') {
            this._hideTooltip();
            this._state.command('clipboard-toggle', item);
            return;
        }
        // Energía: the panel with a click, suspend with a right click or a long press.
        if (item.kind === 'power') {
            this._hideTooltip();
            this._state.command(button === 3 ? 'power-suspend' : 'power-toggle', item);
            return;
        }
        if (button === 3) {
            this._openMenu(item);
            return;
        }
        // Downloads: the stack with a left click, the folder with the middle one.
        if (item.kind === 'downloads' && button === 1) {
            this._hideTooltip();
            this._state.command('stack-toggle', item);
            return;
        }
        // Archivos: the home folders with a left click, the app itself with the middle one.
        if (button === 1 && this._isFolderApp(item)) {
            this._hideTooltip();
            this._state.command('folders-toggle', item);
            return;
        }
        Main.overview.hide();
        if (button === 2 && this._isFolderApp(item)) {
            item.app.activate();
            return;
        }
        if (item.kind === 'downloads') {
            this._launch(GLib.filename_to_uri(this._downloadsDir(), null));
            return;
        }
        if (item.kind === 'trash') {
            this._launch('trash:///');
            return;
        }
        const app = item.app;
        if (button === 2) {
            if (app.can_open_new_window()) {
                app.open_new_window(-1);
                item.bounce();
            }
            return;
        }
        if (app.state === Shell.AppState.STOPPED) {
            item.bounce();
            app.activate();
            return;
        }
        const tracker = Shell.WindowTracker.get_default();
        const ws = global.workspace_manager.get_active_workspace();
        const windows = app.get_windows().filter(w => !w.skip_taskbar && w.located_on_workspace(ws));
        if (tracker.focus_app === app && windows.length && windows.some(w => !w.minimized)) {
            // The app in front: 'clic-enfocada' says what a click does (with one window, it minimizes).
            const action = this._settings.get_string('clic-enfocada');
            if (action === 'rotar' && windows.length > 1)
                this._cycleWindows(app, 1);
            else if (action === 'miniaturas' && windows.length > 1)
                this._state.command('previews-show', item);
            else
                windows.forEach(w => w.minimize());
            return;
        }
        app.activate();
    }

    // The app's windows on this workspace, one after the other.
    _cycleWindows(app, step) {
        const ws = global.workspace_manager.get_active_workspace();
        const windows = app.get_windows().filter(w => !w.skip_taskbar && w.located_on_workspace(ws))
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
        if (!windows.length)
            return;
        const at = windows.indexOf(global.display.focus_window);
        const next = windows[((at < 0 ? -step : at) + step + windows.length) % windows.length];
        Main.activateWindow(next);
    }

    // The wheel over an open app ('rueda-ventanas'): its windows in turn. Anywhere
    // else (or with this off) the wheel stays the island's: the volume.
    _onItemScroll(item, event) {
        if (!this._settings.get_boolean('rueda-ventanas') || !item.app || item.running < 1)
            return Clutter.EVENT_PROPAGATE;
        const dir = event.get_scroll_direction();
        let step = 0;
        if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
            step = -1;
        else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
            step = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
            // A touchpad sends many small steps: one window per gesture.
            const now = event.get_time();
            if (Math.abs(d) < 0.5 || now - (this._lastScroll ?? 0) < 250)
                return Clutter.EVENT_STOP;
            this._lastScroll = now;
            step = d > 0 ? 1 : -1;
        }
        if (step) {
            Main.overview.hide();
            this._cycleWindows(item.app, step);
        }
        return Clutter.EVENT_STOP;
    }

    // ---------- right-click menu ----------
    _openMenu(item) {
        let menu = item._dockMenu;
        if (!menu) {
            menu = new PopupMenu.PopupMenu(item, 0.5, St.Side.BOTTOM);
            menu.actor.add_style_class_name('isla-menu');
            Main.uiGroup.add_child(menu.actor);
            menu.actor.hide();
            this._menuManager.addMenu(menu);
            menu.connect('open-state-changed', (_m, open) => {
                item.menuOpen = open;
                if (open)
                    this._hideTooltip();
                this.emit('busy-changed');
            });
            item._dockMenu = menu;
            item.connect('destroy', () => menu.destroy());
        }
        menu.removeAll();
        this._fillMenu(menu, item);
        menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _fillMenu(menu, item) {
        if (item.kind === 'downloads') {
            menu.addAction('Abrir carpeta', () => this._launch(GLib.filename_to_uri(this._downloadsDir(), null)));
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            for (const [value, label] of [['cascade', 'Vista: cascada'], ['grid', 'Vista: cuadrícula'], ['list', 'Vista: lista']]) {
                const option = menu.addAction(label, () => this._settings.set_string('stack-view', value));
                option.setOrnament(this._settings.get_string('stack-view') === value
                    ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
            }
            return;
        }
        if (item.kind === 'trash') {
            menu.addAction('Abrir la papelera', () => this._launch('trash:///'));
            if (this._trashFull)
                menu.addAction('Vaciar la papelera…', () => this._confirmEmptyTrash());
            return;
        }
        const app = item.app;
        const windows = app.get_windows().filter(w => !w.skip_taskbar);
        for (const w of windows) {
            const title = w.get_title() || app.get_name();
            menu.addAction(title.length > 60 ? `${title.slice(0, 57)}…` : title, () => Main.activateWindow(w));
        }
        if (windows.length)
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (app.can_open_new_window())
            menu.addAction('Nueva ventana', () => app.open_new_window(-1));
        const info = app.get_app_info();
        // The app's own actions ("new-window" is already covered above).
        const own = (info?.list_actions() ?? []).filter(a => !(app.can_open_new_window() && /^new[-_]?window$/i.test(a)));
        for (const action of own)
            menu.addAction(info.get_action_name(action), () => app.launch_action(action, global.get_current_time(), -1));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const favorites = AppFavorites.getAppFavorites();
        const id = app.get_id();
        if (favorites.isFavorite(id))
            menu.addAction('Quitar del dock', () => favorites.removeFavorite(id));
        else if (info)
            menu.addAction('Fijar en el dock', () => favorites.addFavorite(id));
        if (app.state !== Shell.AppState.STOPPED)
            menu.addAction('Cerrar todas las ventanas', () => app.request_quit());
    }

    _confirmEmptyTrash() {
        const dialog = new ModalDialog.ModalDialog();
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: '¿Vaciar la papelera?',
            description: 'Todo lo que está en la papelera se borrará para siempre.',
        }));
        dialog.addButton({label: 'Cancelar', action: () => dialog.close(), key: Clutter.KEY_Escape});
        dialog.addButton({
            label: 'Vaciar',
            action: () => {
                dialog.close();
                try {
                    Gio.Subprocess.new(['gio', 'trash', '--empty'], Gio.SubprocessFlags.NONE);
                } catch (e) {
                    Main.notifyError('No se pudo vaciar la papelera', e.message);
                }
            },
        });
        dialog.open();
    }

    // ---------- drag to reorder ----------
    // Dropping before the first separator pins the app at that place, after it unpins it.
    handleDragOver(source, _actor, x, _y, _time) {
        if (!(source instanceof DockItem) || source.kind !== 'app' || !this._items || !this._appItems.includes(source))
            return DND.DragMotionResult.CONTINUE;
        const children = this.actor.get_children();
        const end = children.findIndex(a => a.kind === 'downloads' || a.kind === 'trash' || a.kind === 'apps' || a.kind === 'power' || a.kind === 'clipboard' ||
            a.key === 'sep-2' || a.key === 'sep-3');
        const limit = end < 0 ? children.length : end;
        let index = 0;
        for (let i = 0; i < limit; i++) {
            const child = children[i];
            if (child !== source && x > child.x + child.width / 2)
                index++;
        }
        if (children.indexOf(source) !== index)
            this.actor.set_child_at_index(source, index);
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source, _actor, _x, _y, _time) {
        if (!(source instanceof DockItem) || source.kind !== 'app' || !this._items)
            return false;
        const children = this.actor.get_children();
        const sep = children.findIndex(a => a.key === 'sep-1');
        const at = children.indexOf(source);
        const favorites = AppFavorites.getAppFavorites();
        const id = source.app.get_id();
        const wasFavorite = favorites.isFavorite(id);
        const pinned = sep >= 0 ? at < sep : wasFavorite;
        if (pinned) {
            const pos = children.slice(0, at).filter(a => a.kind === 'app').length;
            if (wasFavorite)
                favorites.moveFavoriteToPos(id, pos);
            else if (source.app.get_app_info())
                favorites.addFavoriteAtPos(id, pos);
        } else if (wasFavorite) {
            favorites.removeFavorite(id);
        }
        return true;
    }

    // ---------- magnification and tooltip ----------
    magnifyAt(x) {
        const items = this._appItems;
        if (!this._p.magnify || !items.length || this._dragging)
            return;
        const spacing = this._layout.spacing;
        const within = (item, margin) => {
            const [ix] = item.get_transformed_position();
            const [iw] = item.get_transformed_size();
            return x >= ix - margin && x <= ix + iw + margin;
        };
        let index = this._hovered;
        // Keep the current icon while the pointer is still on it, so the reflow doesn't flicker.
        if (index < 0 || !items[index] || !within(items[index], 4 * this._p.scale))
            index = items.findIndex(item => within(item, spacing / 2));
        if (index === this._hovered)
            return;
        this._hovered = index;
        this._applyZoom();
    }

    resetZoom() {
        if (this._hovered === -1)
            return;
        this._hovered = -1;
        this._applyZoom();
    }

    _applyZoom() {
        const {base} = this._p;
        this._appItems.forEach((item, i) => {
            const d = this._hovered < 0 ? Infinity : Math.abs(i - this._hovered);
            // The Portal keeps its size so it stays centered in the island.
            const zoom = item.kind === 'apps' || item.kind === 'power' || item.kind === 'clipboard' ? 1 : d < ZOOM.length ? ZOOM[d] : 1;
            item.setSize(Math.round(base * zoom));
        });
        if (this._tooltipItem)
            this._later('tooltip', 140, () => this._placeTooltip());
    }

    setDark(dark, skinClass = '') {
        this._tooltip.style_class = `isla-tooltip ${skinClass}${dark ? ' oscura' : ''}`;
    }

    _onItemHover(item, hover) {
        if (hover && !item._dockMenu?.isOpen) {
            this._tooltipItem = item;
            this._tooltip.text = item.title;
            this._tooltip.show();
            this._placeTooltip();
            this._tooltip.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else if (!hover && this._tooltipItem === item) {
            this._hideTooltip();
        }
        this.emit('item-hover', item, hover);
    }

    _placeTooltip() {
        const item = this._tooltipItem;
        if (!item || !this._tooltip.visible)
            return;
        const sf = this._p.scale;
        const [ix, iy] = item.get_transformed_position();
        const [iw] = item.get_transformed_size();
        const size = item.zoom || this._p.base;
        const iconTop = iy + (this._p.base - size) * sf;
        const [tw, th] = this._tooltip.get_size();
        const mon = dockMonitor();
        const x = Math.min(Math.max(ix + iw / 2 - tw / 2, mon.x + 4), mon.x + mon.width - tw - 4);
        this._tooltip.set_position(Math.round(x), Math.round(iconTop - TOOLTIP_GAP * sf - th));
    }

    hideTooltip() {
        this._hideTooltip();
    }

    _hideTooltip() {
        this._tooltipItem = null;
        this._cancel('tooltip');
        this._tooltip.remove_all_transitions();
        this._tooltip.opacity = 0;
        this._tooltip.hide();
    }

    // ---------- Downloads state and Trash state ----------
    // From the stack module: {busy, fresh (new since the stack was opened), progress (0..1 or null)}.
    setDownloadsState(downloads) {
        this._downloads = downloads;
        const item = this._items?.get('downloads');
        if (item)
            this._showDownloads(item);
    }

    _showDownloads(item) {
        const {busy, fresh, progress, transfer} = this._downloads;
        // The ring shows a real percentage; without one, the strip under the icon.
        item.setProgress(busy && progress === null);
        item.setRing(progress);
        item.setDot(fresh);
        item.title = busy ? `Descargas · ${transfer ?? 'descargando…'}` : 'Descargas';
        // The tooltip that is showing follows the download.
        if (this._tooltipItem === item && this._tooltip.visible && this._tooltip.text !== item.title) {
            this._tooltip.text = item.title;
            this._placeTooltip();
        }
    }

    _watchTrash() {
        this._trash = Gio.File.new_for_uri('trash:///');
        try {
            this._trashMonitor = this._trash.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._trashMonitor.connect('changed', () => this._later('trash', 300, () => this._checkTrash()));
        } catch {
            this._trashMonitor = null;
        }
        this._checkTrash();
    }

    _checkTrash() {
        this._trash.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null, (file, res) => {
            let full = false;
            try {
                full = file.query_info_finish(res).get_attribute_uint32('trash::item-count') > 0;
            } catch {
                return;
            }
            if (!this._items || full === this._trashFull)
                return;
            this._trashFull = full;
            this._items.get('trash')?.setGIcon(this._trashIcon());
        });
    }

    // dying: the stage is being torn down, its actors are already gone (only the others are disconnected).
    _dropSources(dying = false) {
        this._signals.forEach(([obj, id]) => !(dying && obj instanceof Clutter.Actor) && obj.disconnect(id));
        this._signals = [];
        for (const id of this._timeouts.values())
            GLib.source_remove(id);
        this._timeouts.clear();
    }

    destroy() {
        this._dropSources();
        this._trashMonitor?.cancel();
        this._tooltip.destroy();
        this.actor.destroy();
        this.tail.destroy();
        this._items = null;
        this._appItems = [];
        this.disconnectAll();
    }
}
