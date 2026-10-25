// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Privacidad: with the top bar hidden, GNOME's warnings that an app is using
// the microphone, the camera, the location or the screen (shared or remote)
// would be gone. They show here instead, in a capsule shaped like the
// recording one, in GNOME's privacy orange: one icon per resource in use.
// Folded it only shows; in the open dock a click spells out what is in use
// and, when it can be known, by which app (the microphone's apps).
// GNOME's own indicators are followed (they keep working with the bar hidden);
// they are not made again. There is no switch to turn this off.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {_, N_, fmt} from './i18n.js';

const ORDER = 0;
const RETRY = 1000;         // GNOME's quick settings are made a moment after startup
const RETRIES = 15;
// Apps that look like they record because they show the input level (GNOME skips them too).
const SKIPPED = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];

// [id, icon, name, where GNOME keeps its indicator]
const KINDS = [
    ['pantalla', 'screen-shared-symbolic', N_('Pantalla compartida'), qs => [
        qs?._remoteAccess?._indicator, Main.panel.statusArea.screenSharing]],
    ['camara', 'camera-web-symbolic', N_('Cámara'), qs => [qs?._camera?._indicator]],
    ['microfono', 'audio-input-microphone-symbolic', N_('Micrófono'), qs => [qs?._volumeInput?._indicator]],
    ['ubicacion', 'find-location-symbolic', N_('Ubicación'), qs => [qs?._location?._indicator]],
];

export class PrivacyStatus {
    constructor({state}) {
        this._state = state;
        this._watched = [];
        this._inUse = new Set();
        this._details = false;
        this._folded = new St.BoxLayout({style_class: 'isla-privacidad', y_align: Clutter.ActorAlign.CENTER});
        this._open = new St.Button({style_class: 'isla-privacidad isla-privacidad-abierta', can_focus: true, reactive: true,
            track_hover: true, y_align: Clutter.ActorAlign.CENTER});
        const openBox = new St.BoxLayout({style_class: 'isla-privacidad-caja'});
        this._openIcons = new St.BoxLayout({style_class: 'isla-privacidad-iconos', y_align: Clutter.ActorAlign.CENTER});
        this._text = new St.Label({style_class: 'isla-privacidad-texto', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._text.clutter_text.ellipsize = 0;
        openBox.add_child(this._openIcons);
        openBox.add_child(this._text);
        this._open.set_child(openBox);
        this._open.connect('clicked', () => {
            this._details = !this._details;
            this._sync();
        });
        // Folding the island puts the words away.
        this._modeId = state.connect('mode-changed', () => {
            if (this._details) {
                this._details = false;
                this._sync();
            }
        });
        this._mixer = Volume.getMixerControl();
        this._mixerIds = ['stream-added', 'stream-removed'].map(s => this._mixer.connect(s, () => this._sync()));
        this._tries = 0;
        this._follow();
    }

    // Follows GNOME's indicators; until its quick settings exist, tries again.
    _follow() {
        const qs = Main.panel?.statusArea?.quickSettings;
        const ready = !!qs?._camera;
        for (const [id, , , where] of KINDS) {
            for (const actor of where(qs)) {
                if (!actor || this._watched.some(([a]) => a === actor))
                    continue;
                // GNOME destroys its indicators on shutdown, maybe before IslaDock: forget them then.
                // Both handlers go away in destroy(): GNOME's indicators outlive IslaDock, and a handler
                // left on them would keep this whole module alive after every off/on (lock screen).
                const gone = actor.connect('destroy', () => {
                    this._watched = this._watched.filter(([a]) => a !== actor);
                });
                this._watched.push([actor, actor.connect('notify::visible', () => this._sync()), id, gone]);
            }
        }
        this._sync();
        if (!ready && this._tries++ < RETRIES) {
            this._retry = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETRY, () => {
                this._retry = 0;
                this._follow();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _micApps() {
        const names = new Set();
        for (const output of this._mixer.get_source_outputs?.() ?? []) {
            const id = output.get_application_id();
            if (SKIPPED.includes(id))
                continue;
            const app = id ? Shell.AppSystem.get_default().lookup_app(`${id}.desktop`) : null;
            const name = app?.get_name() ?? output.get_name();
            if (name)
                names.add(name);
        }
        return [...names];
    }

    _sync() {
        this._inUse = new Set(this._watched.filter(([actor]) => actor.visible).map(([, , id]) => id));
        const kinds = KINDS.filter(([id]) => this._inUse.has(id));
        if (!kinds.length) {
            this._details = false;
            this._state.removeStatus('privacy');
            this._publish([], '');
            return;
        }
        for (const box of [this._folded, this._openIcons]) {
            box.destroy_all_children();
            for (const [, icon] of kinds)
                box.add_child(new St.Icon({style_class: 'isla-privacidad-icono', icon_name: icon, y_align: Clutter.ActorAlign.CENTER}));
        }
        const words = kinds.map(([id, , name]) => {
            if (id !== 'microfono')
                return _(name);
            const apps = this._micApps();
            return apps.length ? `${_(name)}: ${apps.join(', ')}` : _(name);
        });
        const summary = fmt(_('En uso: {lista}'), {lista: words.join(' · ')});
        this._text.text = words.join(' · ');
        this._text.visible = this._details;
        this._open.accessible_name = summary;
        this._folded.accessible_name = summary;
        this._state.setStatus('privacy', {order: ORDER, folded: this._folded, open: this._open});
        this._publish(kinds.map(([, icon]) => icon), summary);
        this._state.command('resize');
    }

    // For the window bar (windowBar.js), which shows the same orange pill.
    _publish(icons, summary) {
        if (icons.join() === (this._state.privacyIcons ?? []).join() && summary === this._state.privacySummary)
            return;
        this._state.privacyIcons = icons;
        this._state.privacySummary = summary;
        this._state.command('privacy-changed');
    }

    destroy() {
        if (this._retry)
            GLib.source_remove(this._retry);
        this._retry = 0;
        this._state.removeStatus('privacy');
        this._publish([], '');
        this._state.disconnect(this._modeId);
        this._watched.forEach(([actor, id, , gone]) => {
            actor.disconnect(id);
            actor.disconnect(gone);
        });
        this._watched = [];
        this._mixerIds.forEach(id => this._mixer.disconnect(id));
        this._folded.destroy();
        this._open.destroy();
    }
}
