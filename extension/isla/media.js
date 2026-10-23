// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Live music (A5): follows the MPRIS players on the session bus. Folded, the
// island shows a small wave (moving only while it plays); open, the cover,
// title, artist and previous / play-pause / next buttons. Covers from the web
// (Spotify, browsers) are downloaded once into the cache. With several
// players, a right click on the music lists them to choose which one the
// island follows; with one, the right click stays the timer's.
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {averageColor} from './dots.js';
import {pillSizes, pillStyle, roundButton} from './pill.js';
import {Priority} from './state.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MAX_COVER = 4 * 1024 * 1024;   // bytes of a downloaded cover

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node><interface name="org.mpris.MediaPlayer2.Player">
  <method name="PlayPause"/><method name="Next"/><method name="Previous"/>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="Metadata" type="a{sv}" access="read"/>
</interface></node>`);

const RootProxy = Gio.DBusProxy.makeProxyWrapper(`
<node><interface name="org.mpris.MediaPlayer2">
  <method name="Raise"/>
  <property name="CanRaise" type="b" access="read"/>
  <property name="DesktopEntry" type="s" access="read"/>
  <property name="Identity" type="s" access="read"/>
</interface></node>`);

const BARS = 4;
const BAR_REST = 4 / 14;

export class Media {
    constructor({state, settings}) {
        this._state = state;
        this._settings = settings;
        this._players = new Map();    // bus name -> {player, root, playingSince}
        this._current = null;
        this._buildActors();

        const bus = Gio.DBus.session;
        this._ownerId = bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            // Only the players' names reach us (the bus filters), not every process that comes and goes.
            '/org/freedesktop/DBus', 'org.mpris.MediaPlayer2', Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name, , owner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (owner)
                    this._add(name);
                else
                    this._remove(name);
            });
        this._cancellable = new Gio.Cancellable();
        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', null,
            new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._add(n));
                } catch {}
            });
        this._commandId = state.connect('command', (_s, name, what) => name === 'media' && this.command(what));
        this._skinId = state.connect('skin-changed', () => {
            this._coverShown = false;
            this._update();
        });
        this._compactId = state.connect('compact-changed', (_s, compact) => this._setCompact(compact));
        this._sizeId = this._settings.connect('changed::tamano-base', () => {
            this._applySize();
            state.command('resize');
        });
    }

    // ---------- actors ----------
    _buildActors() {
        // Folded: equalizer bars in the cover's color that jump while it plays.
        this._mini = new St.BoxLayout({style_class: 'isla-musica-mini', y_align: Clutter.ActorAlign.CENTER});
        const wave = new St.BoxLayout({style_class: 'isla-onda', y_align: Clutter.ActorAlign.CENTER});
        this._bars = [];
        for (let i = 0; i < BARS; i++) {
            const bar = new St.Widget({style_class: 'isla-onda-barra', y_align: Clutter.ActorAlign.CENTER});
            bar.set_pivot_point(0.5, 0.5);
            bar.scale_y = BAR_REST;
            wave.add_child(bar);
            this._bars.push(bar);
        }
        this._mini.add_child(wave);
        // Right after it shows up Clutter still sets values at once: wait one idle.
        this._mini.connect('notify::mapped', () => {
            if (this._mapIdle || !this._mini.mapped)
                return;
            this._mapIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._mapIdle = 0;
                this._startMotion();
                return GLib.SOURCE_REMOVE;
            });
        });

        // One row as tall as the icons: cover, "Title · Artist", previous, play, next.
        // Compact (a dock wider than the screen): only the cover and play, the title as the accessible name.
        this._panel = new St.BoxLayout({style_class: 'isla-musica isla-pildora', y_align: Clutter.ActorAlign.CENTER});
        this._coverButton = new St.Button({style_class: 'isla-caratula-boton', can_focus: false, y_align: Clutter.ActorAlign.CENTER});
        this._cover = new St.Bin({style_class: 'isla-caratula'});
        this._coverIcon = new St.Icon({icon_name: 'audio-x-generic-symbolic', fallback_icon_name: 'media-playback-start-symbolic',
            style_class: 'isla-caratula-icono', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._coverButton.set_child(this._cover);
        this._coverButton.connect('clicked', () => this._raise());
        this._title = new St.Label({style_class: 'isla-musica-titulo', y_align: Clutter.ActorAlign.CENTER});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const buttons = new St.BoxLayout({style_class: 'isla-musica-botones', y_align: Clutter.ActorAlign.CENTER});
        const button = (icon, what) => {
            const b = new St.Button({style_class: 'isla-boton-redondo', can_focus: false, y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({icon_name: icon, style_class: 'isla-boton-icono'})});
            b.connect('clicked', () => this.command(what));
            buttons.add_child(b);
            return b;
        };
        this._skips = [button('media-skip-backward-symbolic', 'previous')];
        this._playButton = button('media-playback-start-symbolic', 'playpause');
        this._playButton.add_style_class_name('isla-boton-play');
        this._skips.push(button('media-skip-forward-symbolic', 'next'));
        for (const actor of [this._coverButton, this._title, buttons])
            this._panel.add_child(actor);
        // Right click: which player to follow (only when there is a choice).
        this._panel.reactive = true;
        this._panel.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== 3 || this._choices().length < 2)
                return Clutter.EVENT_PROPAGATE;
            this._openPlayers();
            return Clutter.EVENT_STOP;
        });
        this._setCompact(this._state.compact);
        this._applySize();
    }

    // As tall as the icons ('tamano-base'). The cover keeps its size in _coverBox:
    // its style also carries the picture.
    _applySize() {
        const z = pillSizes(this._settings);
        this._panel.style = pillStyle(z);
        this._coverBox = `width: ${z.px(28)}px; height: ${z.px(28)}px;`;
        this._cover.style = `${this._coverBox}${this._coverImage ?? ''}`;
        this._title.style = `font-size: ${z.font(12)}px; max-width: ${z.px(110)}px;`;
        for (const b of [...this._skips, this._playButton])
            roundButton(b, z);
    }

    _setCompact(compact) {
        this._title.visible = !compact;
        this._skips.forEach(b => (b.visible = !compact));
    }

    // ---------- players ----------
    _add(name) {
        if (this._players.has(name))
            return;
        const entry = {name, player: null, root: null, playingSince: 0};
        this._players.set(name, entry);
        entry.player = new PlayerProxy(Gio.DBus.session, name, MPRIS_PATH, (proxy, error) => {
            if (error || this._players.get(name) !== entry)
                return;
            entry.changedId = proxy.connect('g-properties-changed', () => this._onChanged(entry));
            this._onChanged(entry);
        }, this._cancellable);
        entry.root = new RootProxy(Gio.DBus.session, name, MPRIS_PATH, () => {}, this._cancellable);
    }

    _remove(name) {
        const entry = this._players.get(name);
        if (!entry)
            return;
        if (entry.changedId)
            entry.player.disconnect(entry.changedId);
        this._players.delete(name);
        if (this._current === entry)
            this._current = null;
        if (this._chosen === name)
            this._chosen = null;
        this._update();
    }

    _status(entry) {
        return entry.player?.PlaybackStatus ?? 'Stopped';
    }

    _metadata(entry) {
        try {
            return entry.player?.get_cached_property('Metadata')?.recursiveUnpack() ?? {};
        } catch {
            return {};
        }
    }

    _onChanged(entry) {
        const playing = this._status(entry) === 'Playing';
        if (playing && !entry.playingSince)
            entry.playingSince = GLib.get_monotonic_time();
        else if (!playing)
            entry.playingSince = 0;
        this._update();
    }

    // Players with a song, for the right-click choice.
    _choices() {
        return [...this._players.values()].filter(e => e.player && this._metadata(e)['xesam:title']);
    }

    _openPlayers() {
        if (!this._menu) {
            this._menu = new PopupMenu.PopupMenu(this._panel, 0.5, St.Side.BOTTOM);
            this._menu.actor.add_style_class_name('isla-menu');
            Main.uiGroup.add_child(this._menu.actor);
            this._menu.actor.hide();
            this._menuManager = new PopupMenu.PopupMenuManager(this._panel);
            this._menuManager.addMenu(this._menu);
            this._menu.connect('open-state-changed', (_m, open) => {
                if (open)
                    this._state.hold('musica');
                else
                    this._state.release('musica');
            });
        }
        this._menu.removeAll();
        for (const entry of this._choices()) {
            const meta = this._metadata(entry);
            const who = entry.root?.Identity || entry.name.slice(MPRIS_PREFIX.length);
            const title = String(meta['xesam:title']);
            const item = this._menu.addAction(`${who}: ${title.length > 40 ? `${title.slice(0, 39)}…` : title}`, () => {
                this._chosen = entry.name;
                this._update();
            });
            item.setOrnament(entry === this._current ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
        }
        this._menu.open(BoxPointer.PopupAnimation.FULL);
    }

    // The one chosen with the right click; else the player that most recently
    // started playing; else the one we had; else any with a song.
    _pick() {
        const all = [...this._players.values()].filter(e => e.player);
        const chosen = this._chosen && this._players.get(this._chosen);
        if (chosen?.player && this._metadata(chosen)['xesam:title'])
            return chosen;
        const playing = all.filter(e => e.playingSince).sort((a, b) => b.playingSince - a.playingSince);
        if (playing.length)
            return playing[0];
        if (this._current && this._players.has(this._current.name) && this._metadata(this._current)['xesam:title'])
            return this._current;
        return all.find(e => this._metadata(e)['xesam:title'] && this._status(e) !== 'Stopped') ?? null;
    }

    _update() {
        try {
            this._doUpdate();
        } catch (e) {
            console.error(`isla-dock: música: ${e.message}\n${e.stack}`);
        }
    }

    _doUpdate() {
        const entry = this._pick();
        this._current = entry;
        const meta = entry ? this._metadata(entry) : {};
        const title = meta['xesam:title'];
        if (!entry || !title) {
            this._setWave(false);
            this._state.removeActivity('music');
            if (this._state.musicPlaying) {
                this._state.musicPlaying = false;
                this._state.emit('music-changed', false);
            }
            return;
        }
        const artist = [].concat(meta['xesam:artist'] ?? []).join(', ');
        const playing = this._status(entry) === 'Playing';
        const by = artist || entry.root?.Identity || '';
        this._title.text = by ? `${title} · ${by}` : title;
        this._panel.accessible_name = this._title.text;
        this._playButton.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._setCover(meta['mpris:artUrl']);
        this._setWave(playing);
        this._state.setActivity('music', {priority: Priority.MUSIC, mini: this._mini, panel: this._panel});
        if (this._state.musicPlaying !== playing) {
            this._state.musicPlaying = playing;
            this._state.emit('music-changed', playing);
        }

    }

    _setCover(url = null) {
        if (url === this._coverUrl && this._coverShown)
            return;
        this._coverShown = true;
        this._coverUrl = url;
        // Web covers come from the cache, downloaded the first time.
        if (/^https?:\/\//.test(url ?? '')) {
            const cached = this._cachedCover(url);
            if (!cached) {
                this._download(url);
                url = null;
            } else {
                url = cached;
            }
        }
        const local = url?.startsWith('file://') ? url : null;
        if (local) {
            this._cover.set_child(null);
            this._coverImage = `background-image: url("${local}");`;
            this._cover.style = `${this._coverBox}${this._coverImage}`;
        } else {
            this._coverImage = null;
            this._cover.style = this._coverBox;
            this._cover.set_child(this._coverIcon);
        }
        this._coverColor = local ? this._colorOf(local) : null;
        this._paintBars();
    }

    _coverPath(url) {
        const name = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1);
        return GLib.build_filenamev([GLib.get_user_cache_dir(), 'isla-dock@frankm', 'caratulas', name]);
    }

    _cachedCover(url) {
        const path = this._coverPath(url);
        return GLib.file_test(path, GLib.FileTest.EXISTS) ? GLib.filename_to_uri(path, null) : null;
    }

    // Once per address; when it arrives and that song is still on, it shows.
    _download(url) {
        if (this._downloading === url)
            return;
        this._downloading = url;
        this._soup ??= new Soup.Session({timeout: 15});
        const message = Soup.Message.new('GET', url);
        if (!message)
            return;
        this._soup.send_and_read_async(message, GLib.PRIORITY_LOW, this._cancellable, (session, res) => {
            if (this._downloading === url)
                this._downloading = null;
            try {
                const bytes = session.send_and_read_finish(res);
                const type = message.get_response_headers().get_content_type()?.[0] ?? '';
                if (message.get_status() !== Soup.Status.OK || !type.startsWith('image/') || bytes.get_size() > MAX_COVER)
                    return;
                const path = this._coverPath(url);
                GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
                GLib.file_set_contents(path, bytes.toArray());
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`isla-dock: carátula: ${e.message}`);
                return;
            }
            if (this._coverUrl === url) {
                this._coverShown = false;
                this._setCover(url);
            }
        });
    }

    // The skin's wave color, or else the cover's.
    _paintBars() {
        const skinColor = this._state.skin?.waveColor;
        const color = skinColor ?? (this._coverColor ? `rgb(${this._coverColor.join(', ')})` : null);
        const style = color ? `background-color: ${color};` : null;
        this._bars.forEach(b => (b.style = style));
    }

    // Main color of a local cover: the bars take it.
    _colorOf(uri) {
        try {
            const path = Gio.File.new_for_uri(uri).get_path();
            return averageColor(GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 16, 16, false));
        } catch {
            return null;
        }
    }



    // Playing: the bars jump to random heights one after another.
    // Paused: they rest low.
    _setWave(playing) {
        const animate = playing && St.Settings.get().enable_animations;
        if (animate === this._waving)
            return;
        this._waving = animate;
        if (animate) {
            this._startMotion();
            return;
        }
        this._bars.forEach(bar => {
            bar.remove_transition('scale-y');
            bar.ease({scale_y: BAR_REST, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
    }

    // Clutter does not animate actors that are not on screen (the folded
    // miniature while the island is open): start again when it shows up.
    _startMotion() {
        if (!this._waving || !this._mini.mapped)
            return;
        this._bars.forEach(bar => !bar.get_transition('scale-y') && this._jump(bar));
    }

    _jump(bar) {
        if (!this._waving || !bar.mapped)
            return;
        bar.ease({
            scale_y: 0.25 + Math.random() * 0.75,
            duration: 160 + Math.random() * 240,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onComplete: () => this._waving && this._jump(bar),
        });
    }

    // ---------- commands ----------
    command(what) {
        const player = this._current?.player;
        if (!player)
            return;
        if (what === 'playpause')
            player.PlayPauseRemote();
        else if (what === 'next')
            player.NextRemote();
        else if (what === 'previous')
            player.PreviousRemote();
    }

    _raise() {
        const entry = this._current;
        if (!entry)
            return;
        if (entry.root?.CanRaise) {
            entry.root.RaiseRemote();
            return;
        }
        const desktop = entry.root?.DesktopEntry;
        const app = desktop ? Shell.AppSystem.get_default().lookup_app(`${desktop}.desktop`) : null;
        app?.activate();
    }

    destroy() {
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._ownerId);
        this._state.disconnect(this._commandId);
        this._state.disconnect(this._skinId);
        this._state.disconnect(this._compactId);
        this._settings.disconnect(this._sizeId);
        for (const name of [...this._players.keys()])
            this._remove(name);
        this._state.removeActivity('music');
        this._state.release('musica');
        this._menu?.destroy();
        this._soup?.abort();
        this._waving = false;
        if (this._mapIdle)
            GLib.source_remove(this._mapIdle);
        this._mapIdle = 0;
        this._bars.forEach(bar => bar.remove_all_transitions());
        // The fallback icon goes with the panel only while it is shown.
        const loose = this._cover.child !== this._coverIcon;
        this._mini.destroy();
        this._panel.destroy();
        if (loose)
            this._coverIcon.destroy();
    }
}
