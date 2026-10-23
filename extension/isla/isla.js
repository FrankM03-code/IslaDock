// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The island: a small capsule on the bottom edge that grows into the whole dock
// when the pointer comes near. It draws whatever the current mode needs (folded
// dots and the main activity, the open dock, a notice...) and animates its size
// between them. Modules talk to it only through the IslaState.
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AppsRow} from './apps.js';
import {RowLayout} from './row.js';
import {BlurLayer} from './blur.js';
import {Dots} from './dots.js';
import {Mode, Priority} from './state.js';
import {createSkin} from './skins/index.js';
import {ms, setSpeed} from './timing.js';
import {chromeParams} from './chrome.js';

const BOTTOM = 14;            // gap to the bottom edge
const EDGE = 4;               // reactive strip on the screen edge
const RADIUS = 22;            // St shrinks it to half the height when needed
const OPEN_TIME = 380;
const CLOSE_TIME = 250;
const FADE_TIME = 120;
const LEAVE_DELAY = 400;
const EDGE_GRACE = 1500;      // open after touching the edge without reaching the island
const NOTICE_TIME = 3500;
const NOTICE_LEAVE = 1200;    // a notice that was pointed at closes this long after leaving
const LEVEL_TIME = 1000;
const ICON_STAGGER = 25;
const ROOM = 520;             // height of the invisible strip that holds the island
const HIDE_TIME = 250;
const NUDGE_TIME = 2500;      // a hidden island stays out this long after a notification
const NUDGE_SHIFT = 5;        // px of the shake, each side
const NUDGE_STEP = 70;
const OVERLAP_DELAY = 100;
const SKIN_FADE = 150;
const PANEL_ORDER = ['recording', 'timer', 'music'];
const CARD_GAP = 12;          // between the island and the glass card of some skins
const CARD_FADE = 200;
const CARD_FADE_OUT = 140;    // gone before the island finishes folding (CLOSE_TIME)

// The monitor strip: the island at its natural size, centered, standing BOTTOM px above the edge.
// With a glass card (some skins put the activity panels there) both are centered as a group.
const StripLayout = GObject.registerClass(
class IslaStripLayout extends Clutter.LayoutManager {
    _init(isla) {
        super._init();
        this._isla = isla;
    }

    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    // The capsule (and the card) first; skin layers that go around them (a halo, a lens) follow them.
    vfunc_allocate(container, box) {
        const capsule = this._isla._capsule;
        const card = this._isla._card;
        const size = actor => {
            const [, w] = actor.get_preferred_width(-1);
            const [, h] = actor.get_preferred_height(w);
            return [w, h];
        };
        const [cw, ch] = size(capsule);
        const withCard = card?.visible;
        let [kw, kh] = withCard ? size(card) : [0, 0];
        kh = Math.max(kh, ch);
        const gap = withCard ? Math.round(CARD_GAP * St.ThemeContext.get_for_stage(global.stage).scale_factor) : 0;
        // Centered; a group wider than the screen starts at its left edge. The card's room grows and
        // shrinks with its fade, so the group recenters smoothly (no jump when it goes).
        const share = withCard ? card.opacity / 255 : 0;
        const left = Math.round(Math.max(box.x1, box.x1 + (box.get_width() - cw - (gap + kw) * share) / 2));
        const boxes = {};
        const place = (actor, x, w, h) => {
            const b = new Clutter.ActorBox();
            b.set_origin(x, box.y2 - h);
            b.set_size(w, h);
            actor.allocate(b);
            return actor.get_allocation_box();
        };
        boxes.capsule = place(capsule, left, cw, ch);
        if (card)
            boxes.card = withCard ? place(card, left + cw + gap, kw, kh) : boxes.capsule;
        for (const child of container.get_children().filter(c => c._around !== undefined)) {
            const m = child._around;
            const target = boxes[child._target ?? 'capsule'] ?? boxes.capsule;
            const b = new Clutter.ActorBox();
            b.set_origin(target.x1 - m, target.y1 - m);
            b.set_size(target.get_width() + 2 * m, target.get_height() + 2 * m);
            child.allocate(b);
        }
    }
});

// The pages, each at its own size in the middle of the capsule. This box clips
// while the size animates, so backgrounds and shadows outside it never do.
const ContentLayout = GObject.registerClass(
class IslaContentLayout extends Clutter.LayoutManager {
    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    vfunc_allocate(container, box) {
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            const [, w] = child.get_preferred_width(-1);
            const [, h] = child.get_preferred_height(w);
            const b = new Clutter.ActorBox();
            b.set_origin(Math.round(box.x1 + (box.get_width() - w) / 2), Math.round(box.y1 + (box.get_height() - h) / 2));
            b.set_size(w, h);
            child.allocate(b);
        }
    }
});

// The capsule: as big as its current page. Backgrounds fill it, pages sit in
// the middle at their own size (the old one fades out while the size animates),
// the volume line runs along the bottom.
const CapsuleLayout = GObject.registerClass(
class IslaCapsuleLayout extends Clutter.LayoutManager {
    _init(isla) {
        super._init();
        this._isla = isla;
    }

    _size() {
        const page = this._isla._page;
        if (!page)
            return [0, 0];
        const [, w] = page.get_preferred_width(-1);
        const [, h] = page.get_preferred_height(w);
        return [w, h];
    }

    vfunc_get_preferred_width() {
        const [w] = this._size();
        return [w, w];
    }

    vfunc_get_preferred_height() {
        const [, h] = this._size();
        return [h, h];
    }

    vfunc_allocate(container, box) {
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            if (child._allocateIn) {
                child._allocateIn(box);
            } else if (child === this._isla._level) {
                this._isla._allocateLine(box, this._isla._level, this._isla._levelFill, this._isla._levelValue);
            } else if (child === this._isla._progress) {
                this._isla._allocateLine(box, this._isla._progress, this._isla._progressFill, this._isla._progressValue ?? 0);
            } else {
                child.allocate(box);
            }
        }
        this._isla._skin?.onResize(box);
    }
});

export class Isla {
    constructor({settings, resolver, state}) {
        this._settings = settings;
        this._state = state;
        this._signals = [];
        this._timeouts = new Map();
        this._windowSignals = new Map();
        this._levelValue = 0;

        setSpeed(settings.get_double('velocidad'));
        this._buildActors(resolver);
        this._setSkin(false);
        this._connectSignals();
        this._updateApps();
        this._updateActivities();
        this._render(false);
        this._hideGnomeDash();
    }

    // GNOME's own dock in the overview and the app grid: away while IslaDock
    // runs. Height 0 too, or the overview keeps an empty band for it.
    _hideGnomeDash() {
        const dash = Main.overview.dash;
        if (!dash)
            return;
        this._gnomeDash = dash;
        dash.hide();
        dash.set_height(0);
    }

    _restoreGnomeDash() {
        const dash = this._gnomeDash;
        if (!dash)
            return;
        dash.set_height(-1);
        dash.show();
        this._gnomeDash = null;
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

    get _monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    get _sf() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    // Design sizes are for 32 px icons.
    get _f() {
        return this._settings.get_int('tamano-base') / 32;
    }

    get capsule() {
        return this._capsule;
    }

    get card() {
        return this._card;
    }

    get hovered() {
        return this._capsule.hover || (this._card.visible && this._card.hover);
    }

    // ---------- actors ----------
    _buildActors(resolver) {
        this._strip = new St.Widget({name: 'IslaDockStrip', layout_manager: new StripLayout(this), reactive: false});
        // When the shell shuts down it destroys the stage first: nothing may touch it after that.
        this._strip.connect('destroy', () => this._dropSources(true));
        this._capsule = new St.Widget({
            style_class: 'isla-capsule',
            reactive: true,
            track_hover: true,
            layout_manager: new CapsuleLayout(this),
        });
        this._blur = new BlurLayer(Main.layoutManager.primaryIndex);
        this._bg = new St.Widget({style_class: 'isla-bg'});
        this._capsule.add_child(this._blur);
        this._capsule.add_child(this._bg);
        this._content = new St.Widget({layout_manager: new ContentLayout()});
        this._capsule.add_child(this._content);

        // Folded: dots | main activity · more
        this._dots = new Dots(this._state);
        this._miniSep = new St.Widget({style_class: 'isla-vsep', y_align: Clutter.ActorAlign.CENTER});
        this._miniBin = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this._more = new St.Widget({style_class: 'isla-more', y_align: Clutter.ActorAlign.CENTER});
        // Status items (battery, privacy…) at the right end, after their own separator.
        this._statusSep = new St.Widget({style_class: 'isla-vsep', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._statusFolded = new St.BoxLayout({style_class: 'isla-estado', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._folded = this._page_(new St.BoxLayout({style_class: 'isla-page-colapsada'}));
        for (const actor of [this._dots.actor, this._miniSep, this._miniBin, this._more, this._statusSep, this._statusFolded])
            this._folded.add_child(actor);

        // Do not disturb: a small grey dot.
        this._quiet = this._page_(new St.Widget({style_class: 'isla-page-dnd'}));

        // Open: apps | activity panels
        this._apps = new AppsRow({settings: this._settings, resolver, state: this._state});
        this._panelSep = new St.Widget({style_class: 'isla-vsep isla-vsep-alta', y_align: Clutter.ActorAlign.CENTER});
        // Side by side, never stacked: the open dock keeps the height of one row of icons.
        this._panels = new St.BoxLayout({style_class: 'isla-panels', y_align: Clutter.ActorAlign.CENTER});
        this._openLayout = new RowLayout(0);
        this._open = this._page_(new St.Widget({style_class: 'isla-page-expandida', layout_manager: this._openLayout}));
        // Status items, then Energía last, to the right of the panels.
        this._statusOpen = new St.BoxLayout({style_class: 'isla-estado isla-estado-abierto', y_align: Clutter.ActorAlign.CENTER,
            visible: false});
        // Some (the tray, when asked) go at the start instead.
        this._statusStart = new St.BoxLayout({style_class: 'isla-estado isla-estado-abierto', y_align: Clutter.ActorAlign.CENTER,
            visible: false});
        for (const actor of [this._statusStart, this._apps.actor, this._panelSep, this._panels, this._statusOpen, this._apps.tail])
            this._open.add_child(actor);

        // Notice: whatever the notices module hands over, clickable.
        this._noticeButton = new St.Button({style_class: 'isla-page-aviso', can_focus: false, x_expand: true});
        this._noticeButton.connect('clicked', () => this._activateNotice());
        this._notice = this._page_(this._noticeButton);

        // Search page: a module puts its content here.
        this._search = this._page_(new St.Bin({style_class: 'isla-page-busqueda'}));

        // Task progress (folded) and volume level: thin lines along the bottom.
        this._progressValue = null;
        this._progress = new St.Widget({style_class: 'isla-level isla-progress', visible: false});
        this._progressFill = new St.Widget({style_class: 'isla-level-fill isla-progress-fill'});
        this._progress.add_child(this._progressFill);
        this._capsule.add_child(this._progress);
        this._level = new St.Widget({style_class: 'isla-level', opacity: 0, visible: false});
        this._levelFill = new St.Widget({style_class: 'isla-level-fill'});
        this._level.add_child(this._levelFill);
        this._capsule.add_child(this._level);

        // Glass card next to the island (skins with panelCard): the panels move there.
        this._card = new St.BoxLayout({style_class: 'isla-tarjeta', reactive: true, track_hover: true,
            visible: false, opacity: 0});

        this._strip.add_child(this._capsule);
        this._strip.add_child(this._card);
        this._card.hide();   // adding it shows it
        Main.layoutManager.addChrome(this._strip, chromeParams({affectsInputRegion: false, affectsStruts: false, trackFullscreen: true}));
        Main.layoutManager.trackChrome(this._capsule, chromeParams({affectsInputRegion: true}));
        // Not trackFullscreen (inherited from the strip otherwise): that would show it by itself.
        Main.layoutManager.trackChrome(this._card, chromeParams({affectsInputRegion: true, trackFullscreen: false}));

        this._edge = new St.Widget({reactive: true});
        this._edge.connect('enter-event', () => {
            if (this._state.mode === Mode.COLLAPSED) {
                this._state.setMode(Mode.EXPANDED);
                this._later('edge', EDGE_GRACE, () => this._maybeFold());
            }
        });
        Main.layoutManager.addChrome(this._edge, chromeParams({affectsInputRegion: true, affectsStruts: false, trackFullscreen: true}));

        this._page = null;
    }

    _page_(actor) {
        actor.visible = false;
        this._content.add_child(actor);
        return actor;
    }

    // ---------- skins ----------
    addSkinLayer(actor, where) {
        if (where === 'around') {
            this._strip.insert_child_below(actor, this._capsule);
            // A halo follows the island (or the card) when it hides.
            const source = actor._target === 'card' ? this._card : this._capsule;
            const binding = source.bind_property('translation-y', actor, 'translation-y', GObject.BindingFlags.SYNC_CREATE);
            actor.connect('destroy', () => binding.unbind());
            return;
        }
        // behind: under the blur · over: under the content · front: over the content.
        const anchor = {behind: this._blur, over: this._content, front: this._progress}[where];
        this._capsule.insert_child_below(actor, anchor);
    }

    get skin() {
        return this._skin;
    }

    // Live change: fade out, swap, fade in.
    _setSkin(animate) {
        const key = this._settings.get_string('isla-piel');
        if (this._skin?.key === key)
            return;
        const swap = () => {
            this._skin?.disable();
            this._skin = createSkin(key, this);
            this._state.skin = this._skin;
            this._skin.enable();
            this._applySettings();
            this._state.emit('skin-changed');
            this._skin.onStateChanged(this._state.mode);
            this._skin.onActivityChanged(this._state.mainActivity);
            this._resize(false);
        };
        if (!animate || !this._skin) {
            swap();
            return;
        }
        this._strip.remove_transition('opacity');
        this._strip.ease({opacity: 0, duration: ms(SKIN_FADE), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                swap();
                this._strip.ease({opacity: 255, duration: ms(SKIN_FADE), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }});
    }

    _place() {
        const mon = this._monitor;
        const sf = this._sf;
        const h = Math.round(ROOM * sf);
        this._strip.set_position(mon.x, mon.y + mon.height - h);
        this._strip.set_size(mon.width, h);
        this._strip.style = `padding-bottom: ${BOTTOM}px;`;
        const e = Math.round(EDGE * sf);
        this._edge.set_position(mon.x, mon.y + mon.height - e);
        this._edge.set_size(mon.width, e);
    }

    // ---------- settings ----------
    _applySettings() {
        const skin = this._skin;
        if (!skin)
            return;
        const dark = this._settings.get_boolean('isla-oscura');
        const f = this._f;
        const [pv, ph] = skin.openPadding;
        this._apps.setDark(skin.darkTooltip, skin.styleClass);
        this._apps.setSkin(skin);
        this._dots.setScale(1);
        const pb = skin.openPadding[2] ?? pv;
        this._open.style = `padding: ${Math.round(pv * f)}px ${Math.round(ph * f)}px ${Math.round(pb * f)}px;`;
        this._openLayout.spacing = Math.round(10 * this._sf);
        this._openLayout.layout_changed();
        const blur = this._settings.get_boolean('desenfoque') ? skin.blur : null;
        const blurOk = !!blur && this._blur.configure(true, RADIUS, 'all', this._sf, blur);
        if (!blurOk)
            this._blur.configure(false);
        this._blurOk = blurOk;
        this._capsule.style_class = ['isla-capsule', skin.styleClass, dark ? 'oscura' : '', this._state.dnd ? 'dnd' : '',
            ...skin.extraClasses ?? []].filter(Boolean).join(' ');
        this._card.style_class = ['isla-tarjeta', skin.styleClass, ...skin.extraClasses ?? []].filter(Boolean).join(' ');
        this._placePanels();
        this._windowBehind = null;
        this._updateBlurBehind();
        this._place();
        this._updateBreathing(true);
    }

    // The blur is a copy of the wallpaper: over a window it would show the
    // wallpaper's colors along the edges. Then the island turns solid instead.
    _updateBlurBehind() {
        const behind = this._windowsOverlap();
        if (behind === this._windowBehind)
            return;
        this._windowBehind = behind;
        this._skin?.onWindowBehind(behind);
        const blurred = !!this._blurOk && !behind;
        this._blur.visible = blurred;
        this._capsule.remove_style_class_name(blurred ? 'sin-desenfoque' : 'con-desenfoque');
        this._capsule.add_style_class_name(blurred ? 'con-desenfoque' : 'sin-desenfoque');
    }

    _connectSignals() {
        this._on(this._settings, 'changed::isla-piel', () => this._setSkin(true));
        this._on(this._settings, 'changed::velocidad', () => setSpeed(this._settings.get_double('velocidad')));
        for (const key of ['isla-oscura', 'desenfoque', 'tamano-base'])
            this._on(this._settings, `changed::${key}`, () => {
                this._applySettings();
                this._resize();
            });
        this._on(this._settings, 'changed::isla-respiracion', () => this._updateBreathing());
        this._on(this._settings, 'changed::isla-transparencia', () => this._updateBreathing(true));
        this._on(this._settings, 'changed::ocultar', () => this._updateAutohide());
        // The blurred wallpaper copy must not slide with the island.
        this._on(this._capsule, 'notify::translation-y', () => (this._blur.slide = this._capsule.translation_y));
        this._on(St.Settings.get(), 'notify::enable-animations', () => this._updateBreathing());
        this._on(Main.layoutManager, 'monitors-changed', () => {
            this._place();
            this._resize(false);
        });

        this._on(this._capsule, 'notify::hover', () => this._onHover());
        this._on(this._card, 'notify::hover', () => this._onHover());
        this._on(this._card, 'notify::opacity', () => this._strip.queue_relayout());
        this._on(this._capsule, 'notify::translation-y', () => (this._card.translation_y = this._capsule.translation_y));
        this._on(this._capsule, 'motion-event', (_a, event) => {
            if (this._state.mode === Mode.EXPANDED)
                this._apps.magnifyAt(event.get_coords()[0]);
            return Clutter.EVENT_PROPAGATE;
        });
        this._on(this._apps, 'changed', () => this._updateApps());
        this._on(this._apps, 'item-hover', (_a, item, hover) => this._state.emit('item-hover', item, hover));
        this._on(this._apps, 'busy-changed', () => {
            if (!this._apps.busy && !this.hovered)
                this._later('leave', ms(LEAVE_DELAY), () => this._maybeFold());
        });

        this._on(this._state, 'mode-changed', () => this._render(true));
        this._on(this._state, 'activities-changed', () => this._updateActivities());
        this._on(this._state, 'status-changed', () => this._updateStatus());
        this._on(this._state, 'dnd-changed', () => {
            this._applySettings();
            this._skin?.onStateChanged(this._state.mode);
            this._render(true);
        });
        this._on(this._state, 'command', (_s, name, ...args) => {
            if (name === 'volume-level')
                this._showLevel(args[0]);
            else if (name === 'notice')
                this._showNotice(args[0]);
            else if (name === 'pulse')
                this._pulse(args[0] ?? 3);
            else if (name === 'nudge')
                this._nudge();
            else if (name === 'fold')
                this._maybeFold(true);
            else if (name === 'maybe-fold' && !this.hovered)
                this._later('leave', ms(LEAVE_DELAY), () => this._maybeFold());
            else if (name === 'search-content')
                this._search.set_child(args[0]);
            else if (name === 'resize')
                this._resize();
            else if (name === 'hide-tooltip')
                this._apps.hideTooltip();
            else if (name === 'progress')
                this._setProgress(args[0]);
            else if (name === 'badge')
                this._apps.setBadge(args[0], args[1]);
            else if (name === 'downloads-state')
                this._apps.setDownloadsState(args[0]);
            else if (name === 'stack-open')
                this._openStack();
            else if (name === 'clipboard-open')
                this._openOver('clipboard', () => this._apps.clipboardItem, 'clipboard-toggle');
            else if (name === 'clipboard-bounce')
                this._apps.bounceClipboard();

        });

        // Away in the overview, except over the app grid: there the island stays
        // so the Portal (or an app) is a way out besides Esc.
        this._on(Main.overview, 'showing', () => {
            this._apps.hideTooltip();
            this._leavingOverview = false;
            // The app grid button is set right after 'showing'.
            this._later('overview', 0, () => this._updateOverview());
        });
        this._on(Main.overview, 'hiding', () => {
            this._leavingOverview = true;
            this._updateOverview();
        });
        this._on(Main.overview, 'hidden', () => {
            this._leavingOverview = false;
            this._updateOverview();
        });
        if (Main.overview.dash?.showAppsButton)
            this._on(Main.overview.dash.showAppsButton, 'notify::checked', () => this._updateOverview());
        if (Main.overview.visible && !this._inAppGrid()) {
            this._strip.opacity = 0;
            this._strip.hide();
        }
        this._updateAutohide();
    }

    _inAppGrid() {
        return Main.overview.visible && !this._leavingOverview && !!Main.overview.dash?.showAppsButton?.checked;
    }

    _updateOverview() {
        const show = !Main.overview.visible || this._leavingOverview || this._inAppGrid();
        if (show) {
            this._strip.show();
            this._strip.ease({opacity: 255, duration: 150});
        } else {
            this._apps.hideTooltip();
            this._strip.ease({opacity: 0, duration: 150, onComplete: () => this._strip.hide()});
        }
        // Over the app grid the hidden GNOME dash keeps a band for the island, so
        // the page dots and the last row stay clear of it.
        if (this._gnomeDash)
            this._gnomeDash.set_height(this._inAppGrid() ? Math.round(this._capsule.height + BOTTOM * this._sf) : 0);
        this._checkHide();
    }

    // ---------- hiding ----------
    // nunca: always there · inteligente: away while a window touches it ·
    // siempre: away until the pointer reaches the bottom edge. Notices, an
    // open island and a finished timer always show; a notification brings it
    // out for a moment (see _nudge).
    _updateAutohide() {
        // Windows are watched always: hiding and the blur both depend on them.
        this._watchWindows();
        this._checkHide();
    }

    _shouldHide() {
        const mode = this._settings.get_string('ocultar');
        if (mode === 'nunca' || this._state.mode !== Mode.COLLAPSED || this.hovered || this._inAppGrid() || this._peeking)
            return false;
        if (this._state.activities.some(a => a.priority <= Priority.TIMER_DONE))
            return false;
        return mode === 'siempre' || this._windowsOverlap();
    }

    _checkHide() {
        this._updateBlurBehind();
        const hide = this._shouldHide();
        if (hide === !!this._hidden)
            return;
        this._hidden = hide;
        const dist = hide ? this._capsule.height + BOTTOM * this._sf + 6 : 0;
        this._capsule.ease({translation_y: dist, duration: ms(HIDE_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _windowsOverlap() {
        if (!this._capsule.mapped && !this._capsule.get_stage())
            return false;
        let [cx, cy] = this._capsule.get_transformed_position();
        let [cw, ch] = this._capsule.get_transformed_size();
        // The glass card counts as part of the island.
        if (this._card.visible) {
            const [kx] = this._card.get_transformed_position();
            const [kw] = this._card.get_transformed_size();
            cw = Math.max(cx + cw, kx + kw) - Math.min(cx, kx);
            cx = Math.min(cx, kx);
        }
        const top = cy - this._capsule.translation_y;
        const bottom = top + ch + BOTTOM * this._sf;
        const ws = global.workspace_manager.get_active_workspace();
        const monitor = Main.layoutManager.primaryIndex;
        const types = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY];
        return global.get_window_actors().some(actor => {
            const w = actor.meta_window;
            if (!w || w.minimized || !w.showing_on_its_workspace() || w.get_monitor() !== monitor ||
                !w.located_on_workspace(ws) || !types.includes(w.get_window_type()))
                return false;
            const f = w.get_frame_rect();
            return f.x < cx + cw && f.x + f.width > cx && f.y < bottom && f.y + f.height > top;
        });
    }

    _queueOverlapCheck() {
        if (!this._timeouts.has('overlap'))
            this._later('overlap', OVERLAP_DELAY, () => this._checkHide());
    }

    _watchWindow(w) {
        if (this._windowSignals.has(w))
            return;
        const ids = [
            w.connect('position-changed', () => this._queueOverlapCheck()),
            w.connect('size-changed', () => this._queueOverlapCheck()),
            w.connect('unmanaged', () => {
                ids.forEach(id => w.disconnect(id));
                this._windowSignals.delete(w);
                this._queueOverlapCheck();
            }),
        ];
        this._windowSignals.set(w, ids);
    }

    _watchWindows() {
        if (this._windowWatch)
            return;
        global.get_window_actors().forEach(a => a.meta_window && this._watchWindow(a.meta_window));
        this._windowWatch = [
            [global.display, global.display.connect('window-created', (_d, w) => {
                this._watchWindow(w);
                this._queueOverlapCheck();
            })],
            [global.display, global.display.connect('restacked', () => this._queueOverlapCheck())],
            [global.display, global.display.connect('notify::focus-window', () => this._queueOverlapCheck())],
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => this._queueOverlapCheck())],
        ];
    }

    _unwatchWindows() {
        this._windowWatch?.forEach(([obj, id]) => obj.disconnect(id));
        this._windowWatch = null;
        for (const [w, ids] of this._windowSignals ?? [])
            ids.forEach(id => w.disconnect(id));
        this._windowSignals?.clear();
        this._cancel('overlap');
    }

    // ---------- hover ----------
    _onHover() {
        const mode = this._state.mode;
        if (this.hovered) {
            this._cancel('leave');
            this._cancel('edge');
            if (mode === Mode.NOTICE)
                this._cancel('notice');
            else if (mode === Mode.COLLAPSED)
                this._state.setMode(Mode.EXPANDED);
            return;
        }
        this._apps.resetZoom();
        this._apps.hideTooltip();
        this._later('hide-check', ms(LEAVE_DELAY), () => this._checkHide());
        if (mode === Mode.NOTICE)
            this._later('notice', NOTICE_LEAVE, () => this._endNotice());
        else if (mode === Mode.EXPANDED)
            this._later('leave', ms(LEAVE_DELAY), () => this._maybeFold());
    }

    // Folds unless something still needs the open island.
    _maybeFold(force = false) {
        if (this._state.mode !== Mode.EXPANDED)
            return;
        if (!force && (this.hovered || this._apps.busy || this._state.keepOpen))
            return;
        this._state.setMode(Mode.COLLAPSED);
    }

    // ---------- content ----------
    _updateApps() {
        const running = this._apps.running.map(({app}) => ({id: app.get_id(), gicon: this._apps.iconOf(app), app}));
        this._state.runningApps = running;
        this._state.emit('apps-changed', running);
        // The separator next to the music depends on there being dots.
        this._updateFoldedParts();
        if (this._state.mode === Mode.COLLAPSED)
            this._resize();
        else if (this._state.mode === Mode.EXPANDED)
            this._resize(false);   // more or fewer icons: the panels may need to go compact
    }

    _updateActivities() {
        const all = this._state.activities;
        const main = all.find(a => a.mini) ?? null;
        // The miniature of the most important activity.
        if (this._miniBin.child !== (main?.mini ?? null)) {
            this._miniBin.set_child(null);
            if (main?.mini) {
                main.mini.get_parent()?.remove_child(main.mini);
                this._miniBin.set_child(main.mini);
            }
        }
        // Every panel in a fixed order: recording, timer, music, the rest by importance.
        for (const child of this._panels.get_children())
            this._panels.remove_child(child);
        const rank = a => {
            const k = PANEL_ORDER.indexOf(a.id);
            return k < 0 ? PANEL_ORDER.length : k;
        };
        for (const {panel} of [...all].sort((a, b) => rank(a) - rank(b))) {
            if (!panel)
                continue;
            panel.get_parent()?.remove_child(panel);
            this._panels.add_child(panel);
        }
        this._updateFoldedParts();
        const hasPanels = this._panels.get_n_children() > 0;
        this._panelSep.visible = hasPanels && !this._usesCard;
        this._panels.visible = hasPanels;
        this._updateCard();
        this._updateBreathing();
        if (this._state.mode === Mode.COLLAPSED || this._state.mode === Mode.EXPANDED)
            this._resize();
        this._checkHide();
        this._skin?.onActivityChanged(this._state.mainActivity);
    }

    // The status items move into their two boxes in order; their owners keep them.
    _updateStatus() {
        const all = this._state.statuses;
        const boxes = [[this._statusFolded, 'folded', null], [this._statusOpen, 'open', 'end'], [this._statusStart, 'open', 'start']];
        for (const [box, part, side] of boxes) {
            for (const child of box.get_children())
                box.remove_child(child);
            for (const item of all) {
                if (side && item.side !== side)
                    continue;
                const actor = item[part];
                if (!actor)
                    continue;
                actor.get_parent()?.remove_child(actor);
                box.add_child(actor);
            }
        }
        this._updateFoldedParts();
        if (this._state.mode === Mode.COLLAPSED || this._state.mode === Mode.EXPANDED)
            this._resize();
    }

    _updateFoldedParts() {
        const hasMini = !!this._miniBin.child;
        this._miniBin.visible = hasMini;
        this._dots.setResting(!hasMini);
        this._miniSep.visible = hasMini && this._dots.count > 0;
        this._more.visible = hasMini && this._state.activities.filter(a => a.mini).length > 1;
        const hasStatus = this._statusFolded.get_children().some(c => c.visible);
        this._statusFolded.visible = hasStatus;
        this._statusSep.visible = hasStatus && (hasMini || this._dots.count > 0);
        this._statusOpen.visible = this._statusOpen.get_children().some(c => c.visible);
        this._statusStart.visible = this._statusStart.get_children().some(c => c.visible);
    }

    // ---------- modes ----------
    _pageFor(mode) {
        switch (mode) {
        case Mode.EXPANDED:
            return this._open;
        case Mode.NOTICE:
            return this._notice;
        case Mode.SEARCH:
            return this._search;
        default:
            return this._state.dnd ? this._quiet : this._folded;
        }
    }

    _render(animate) {
        const mode = this._state.mode;
        this._capsule.set_style_pseudo_class(mode);
        this._updateFoldedParts();
        const page = this._pageFor(mode);
        if (mode !== Mode.EXPANDED) {
            this._apps.resetZoom();
            this._apps.hideTooltip();
        }
        this._showPage(page, animate);
        this._updateProgressLine();
        if (mode === Mode.EXPANDED && animate)
            this._iconsIn();
        if (mode === Mode.COLLAPSED && !this.hovered)
            this._cancel('leave');
        this._updateBreathing();
        this._updateCard();
        this._checkHide();
        this._skin?.onStateChanged(mode);
    }

    // ---------- glass card (skins with panelCard) ----------
    get _usesCard() {
        return !!this._skin?.panelCard;
    }

    // The panels go to the card or stay in the open island, after its separator.
    _placePanels() {
        const parent = this._usesCard ? this._card : this._open;
        if (this._panels.get_parent() !== parent) {
            this._panels.get_parent()?.remove_child(this._panels);
            if (parent === this._open)
                parent.insert_child_below(this._panels, this._apps.tail);   // Energía stays last
            else
                parent.add_child(this._panels);
        }
        this._panelSep.visible = this._panels.get_n_children() > 0 && !this._usesCard;
        this._updateCard();
    }

    // Shown with the open island when there is something to show; fades in and out.
    _updateCard() {
        const card = this._card;
        const show = this._usesCard && this._state.mode === Mode.EXPANDED && this._panels.get_n_children() > 0;
        if (show === !!card._shown)
            return;
        card._shown = show;
        card.remove_transition('opacity');
        if (show) {
            card.show();
            card.ease({opacity: 255, duration: ms(CARD_FADE), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            card.ease({opacity: 0, duration: ms(CARD_FADE_OUT), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => !card._shown && card.hide()});
        }
        this._strip.queue_relayout();
    }

    // Cross-fades to another page while the capsule animates to its size.
    _showPage(page, animate) {
        const old = this._page;
        if (page === old) {
            this._resize(animate);
            return;
        }
        const [w0, h0] = this._capsule.get_size();
        this._page = page;
        page.remove_all_transitions();
        page.show();
        if (old) {
            old.remove_all_transitions();
            if (animate) {
                old.ease({opacity: 0, duration: ms(FADE_TIME), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => this._page !== old && old.hide()});
            } else {
                old.hide();
            }
        }
        page.opacity = animate && old ? 0 : 255;
        if (animate && old)
            page.ease({opacity: 255, duration: ms(FADE_TIME * 2), delay: ms(FADE_TIME / 2), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        if (animate && old && w0 > 0)
            this._resize(true, [w0, h0]);
        else
            this._capsule.queue_relayout();
    }

    // Animates the capsule from its current size to the natural size of its page.
    _resize(animate = true, from = null) {
        const capsule = this._capsule;
        if (!this._page)
            return;
        const [w0, h0] = from ?? capsule.get_size();
        capsule.remove_transition('width');
        capsule.remove_transition('height');
        capsule.set_size(-1, -1);
        this._fitPanels();
        const [, w1] = capsule.get_preferred_width(-1);
        const [, h1] = capsule.get_preferred_height(w1);
        if (!animate || !w0 || (Math.abs(w1 - w0) < 1 && Math.abs(h1 - h0) < 1))
            return;
        const grows = w1 * h1 >= w0 * h0;
        capsule.set_size(w0, h0);
        this._content.clip_to_allocation = true;
        capsule.ease({
            width: w1, height: h1,
            duration: ms(grows ? OPEN_TIME : CLOSE_TIME),
            mode: grows ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                capsule.set_size(-1, -1);
                this._content.clip_to_allocation = false;
                this._queueOverlapCheck();
            },
        });
    }

    // Compact mode: when the open dock (and its card) would be wider than the
    // monitor, the panels keep only their essentials (state 'compact-changed').
    _fitPanels() {
        if (this._state.mode !== Mode.EXPANDED || !this._panels.get_n_children())
            return;
        // The content box in between is never measured, so a panel that hides its
        // text does not reach the capsule's cached width by itself: ask again each time.
        const width = () => {
            this._capsule.queue_relayout();
            this._card.queue_relayout();
            const [, w] = this._capsule.get_preferred_width(-1);
            if (!this._usesCard)
                return w;
            const [, k] = this._card.get_preferred_width(-1);
            return w + k + CARD_GAP * this._sf;
        };
        this._state.setCompact(false);
        this._state.setCompact(width() > this._monitor.width - 16 * this._sf);
        this._capsule.queue_relayout();
        this._card.queue_relayout();
    }

    // The icons appear growing from 0.6 (efecto-iconos): one after the other
    // ('uno-a-uno'), all together ('todos') or from the middle out to both
    // sides, rising a little ('centro').
    _iconsIn() {
        const effect = this._settings.get_string('efecto-iconos');
        const items = [...this._apps.actor.get_children(), ...this._apps.tail.get_children()];
        const middle = (items.length - 1) / 2;
        const rise = effect === 'centro' ? Math.round(10 * this._sf) : 0;
        items.forEach((item, k) => {
            item.set_pivot_point(0.5, 0.5);
            for (const property of ['scale-x', 'scale-y', 'opacity', 'translation-y'])
                item.remove_transition(property);
            item.set({scale_x: 0.6, scale_y: 0.6, opacity: 0, translation_y: rise});
            const step = {todos: 0, centro: Math.abs(k - middle) * ICON_STAGGER * 1.4}[effect] ?? k * ICON_STAGGER;
            item.ease({scale_x: 1, scale_y: 1, opacity: 255, translation_y: 0, duration: ms(260), delay: ms(60 + step),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
    }

    // ---------- breathing (A2) ----------
    // The background's own opacity: 'isla-transparencia' (0 = solid) lets more of
    // what is behind show through, for every skin.
    get _bgOpacity() {
        return Math.round(255 * (1 - this._settings.get_double('isla-transparencia')));
    }

    _updateBreathing(force = false) {
        const on = this._settings.get_boolean('isla-respiracion') && St.Settings.get().enable_animations &&
            this._state.mode === Mode.COLLAPSED && !this._state.dnd && this._state.activities.length === 0;
        if (on === !!this._breathing && !force)
            return;
        this._breathing = on;
        this._bg.remove_transition('opacity');
        const base = this._bgOpacity;
        this._bg.opacity = base;
        if (on) {
            this._bg.ease({opacity: Math.round(base * 0.85), duration: 2000, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                autoReverse: true, repeatCount: -1});
        }
    }

    // ---------- the island beats (timer done) ----------
    _pulse(times) {
        this._capsule.set_pivot_point(0.5, 0.5);
        this._capsule.remove_transition('scale-x');
        this._capsule.remove_transition('scale-y');
        this._capsule.ease({scale_x: 1.06, scale_y: 1.06, duration: ms(180), mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            autoReverse: true, repeatCount: times * 2 - 1});
    }

    // ---------- a notification arrived: a soft shake ----------
    // A hidden island peeks out, shakes and goes back; a visible one just shakes.
    _nudge() {
        if (!this._peeking) {
            this._peeking = true;
            // Like the cards: over a maximized window drawn straight to the screen.
            global.compositor.disable_unredirect();
            this._checkHide();
        }
        const wasHidden = this._capsule.translation_y > 0;
        this._later('nudge-shake', wasHidden ? ms(HIDE_TIME) : 0, () => this._shake());
        this._later('nudge', NUDGE_TIME, () => this._endNudge());
    }

    _shake() {
        const c = this._capsule;
        const d = NUDGE_SHIFT * this._sf;
        const steps = [d, -d, d * 0.6, -d * 0.6, d * 0.3, 0];
        c.remove_transition('translation-x');
        const step = i => {
            if (i >= steps.length)
                return;
            c.ease({translation_x: steps[i], duration: ms(NUDGE_STEP), mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                onStopped: done => done && step(i + 1)});
        };
        step(0);
    }

    _endNudge() {
        if (!this._peeking)
            return;
        this._peeking = false;
        global.compositor.enable_unredirect();
        this._checkHide();
    }

    // ---------- volume level ----------
    _showLevel(value) {
        this._levelValue = Math.max(0, Math.min(1, value));
        this._level.remove_all_transitions();
        this._level.show();
        this._level.opacity = 255;
        this._capsule.queue_relayout();
        this._later('level', LEVEL_TIME, () => this._level.ease({opacity: 0, duration: 200,
            onComplete: () => this._level.hide()}));
    }

    _allocateLine(box, line, fill, value) {
        const sf = this._sf;
        const h = Math.max(1, Math.round(2 * sf));
        const r = Math.min(RADIUS * sf, box.get_height() / 2);
        const b = new Clutter.ActorBox();
        b.set_origin(box.x1 + r, box.y2 - h - Math.round(3 * sf));
        b.set_size(Math.max(0, box.get_width() - 2 * r), h);
        line.allocate(b);
        const f = new Clutter.ActorBox();
        f.set_origin(0, 0);
        f.set_size(Math.round(b.get_width() * value), h);
        fill.allocate(f);
    }

    // ---------- task progress (C1) ----------
    _setProgress(value) {
        this._progressValue = value;
        this._updateProgressLine();
    }

    _updateProgressLine() {
        const shown = this._progressValue !== null && this._state.mode === Mode.COLLAPSED && !this._state.dnd;
        this._progress.visible = shown;
        // Room for the line to be seen even with a single dot.
        const style = this._progressValue !== null ? `min-width: ${Math.round(56 * this._f)}px;` : null;
        if (this._folded.style !== style) {
            this._folded.style = style;
            if (this._state.mode === Mode.COLLAPSED)
                this._resize();
        }
        this._capsule.queue_relayout();
    }

    // ---------- Downloads stack ----------
    // From a "Descarga lista" notice: open the island, then the stack over its button.
    _openStack() {
        this._openOver('stack', () => this._apps.downloadsItem, 'stack-toggle');
    }

    // Opens the island (from a shortcut) and then a popup over one of its buttons.
    _openOver(name, item, command) {
        if (this._state.mode !== Mode.EXPANDED && !this._state.setMode(Mode.EXPANDED))
            return;
        this._state.hold(`${name}-opening`);
        this._later(name, ms(OPEN_TIME) + 60, () => {
            this._state.release(`${name}-opening`);
            const anchor = item();
            this._state.command(command, anchor?.mapped ? anchor : this._capsule);
        });
    }

    // ---------- notices (A6) ----------
    // notice: {actor, activate()}; the island owns the actor from now on.
    _showNotice(notice) {
        const mode = this._state.mode;
        if (mode === Mode.EXPANDED || mode === Mode.SEARCH) {
            notice.actor.destroy();
            return;
        }
        this._noticeButton.child?.destroy();
        this._noticeButton.set_child(notice.actor);
        this._state.notice = notice;
        if (mode === Mode.NOTICE)
            this._resize();
        else
            this._state.setMode(Mode.NOTICE);
        if (!this.hovered)
            this._later('notice', NOTICE_TIME, () => this._endNotice());
    }

    _activateNotice() {
        const notice = this._state.notice;
        this._endNotice();
        notice?.activate();
    }

    _endNotice() {
        this._cancel('notice');
        if (this._state.mode !== Mode.NOTICE)
            return;
        this._state.notice = null;
        this._state.setMode(this.hovered ? Mode.EXPANDED : Mode.COLLAPSED);
        this._later('notice-clear', OPEN_TIME, () => {
            if (this._state.mode !== Mode.NOTICE)
                this._noticeButton.child?.destroy();
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
        this._endNudge();
        this._restoreGnomeDash();
        this._unwatchWindows();
        this._dropSources();
        this._skin?.disable();
        this._skin = null;
        this._blur.configure(false);
        // Activity and status actors belong to their modules.
        this._miniBin.set_child(null);
        for (const box of [this._statusFolded, this._statusOpen, this._statusStart]) {
            for (const child of box.get_children())
                box.remove_child(child);
        }
        this._search.set_child(null);
        for (const child of this._panels.get_children())
            this._panels.remove_child(child);
        this._dots.destroy();
        this._apps.destroy();
        Main.layoutManager.untrackChrome(this._card);
        Main.layoutManager.untrackChrome(this._capsule);
        Main.layoutManager.removeChrome(this._strip);
        Main.layoutManager.removeChrome(this._edge);
        this._strip.destroy();
        this._edge.destroy();
    }
}
