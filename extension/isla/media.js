// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Live music (A5): follows the MPRIS players on the session bus. Folded, the
// island shows a small wave (moving only while it plays); open, the cover,
// title, artist and previous / play-pause / next buttons.
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {averageColor} from './dots.js';
import {Priority} from './state.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';

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
    constructor({state}) {
        this._state = state;
        this._players = new Map();    // bus name -> {player, root, playingSince}
        this._current = null;
        this._buildActors();

        const bus = Gio.DBus.session;
        this._ownerId = bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _sig, params) => {
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

        this._panel = new St.BoxLayout({style_class: 'isla-musica'});
        this._coverButton = new St.Button({style_class: 'isla-caratula-boton', can_focus: false, y_align: Clutter.ActorAlign.CENTER});
        this._cover = new St.Bin({style_class: 'isla-caratula'});
        this._coverIcon = new St.Icon({icon_name: 'audio-x-generic-symbolic', fallback_icon_name: 'media-playback-start-symbolic',
            style_class: 'isla-caratula-icono', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._coverButton.set_child(this._cover);
        this._coverButton.connect('clicked', () => this._raise());
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'isla-musica-texto'});
        this._title = new St.Label({style_class: 'isla-musica-titulo'});
        this._artist = new St.Label({style_class: 'isla-musica-artista'});
        for (const label of [this._title, this._artist])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._title);
        text.add_child(this._artist);
        const buttons = new St.BoxLayout({style_class: 'isla-musica-botones', y_align: Clutter.ActorAlign.CENTER});
        const button = (icon, what) => {
            const b = new St.Button({style_class: 'isla-boton-redondo', can_focus: false,
                child: new St.Icon({icon_name: icon, style_class: 'isla-boton-icono'})});
            b.connect('clicked', () => this.command(what));
            buttons.add_child(b);
            return b;
        };
        button('media-skip-backward-symbolic', 'previous');
        this._playButton = button('media-playback-start-symbolic', 'playpause');
        this._playButton.add_style_class_name('isla-boton-play');
        button('media-skip-forward-symbolic', 'next');
        for (const actor of [this._coverButton, text, buttons])
            this._panel.add_child(actor);
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

    // The player that most recently started playing; else the one we had; else any with a song.
    _pick() {
        const all = [...this._players.values()].filter(e => e.player);
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
        this._title.text = title;
        this._artist.text = artist || entry.root?.Identity || '';
        this._artist.visible = !!this._artist.text;
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
        // Only local images (http covers are not downloaded).
        const local = url?.startsWith('file://') ? url : null;
        if (local) {
            this._cover.set_child(null);
            this._cover.style = `background-image: url("${local}");`;
        } else {
            this._cover.style = null;
            this._cover.set_child(this._coverIcon);
        }
        this._coverColor = local ? this._colorOf(local) : null;
        this._paintBars();
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
        for (const name of [...this._players.keys()])
            this._remove(name);
        this._state.removeActivity('music');
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
