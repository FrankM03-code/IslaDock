// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Holds GNOME's own notification banners back while IslaDock shows its own
// (avisos flotantes, or the notification center's popups), whatever else
// blocks or unblocks them (the top bar's menus do); what others ask for is
// kept and given back on release().
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export class GnomeBanners {
    hold() {
        const tray = Main.messageTray;
        let desc = null;
        for (let p = Object.getPrototypeOf(tray); p && !desc; p = Object.getPrototypeOf(p))
            desc = Object.getOwnPropertyDescriptor(p, 'bannerBlocked');
        if (!desc?.set)
            return;
        this._setter = desc.set;
        this._othersBlock = !!tray.bannerBlocked;
        Object.defineProperty(tray, 'bannerBlocked', {
            configurable: true,
            get: () => this._othersBlock,
            set: v => {
                this._othersBlock = !!v;
            },
        });
        desc.set.call(tray, true);
    }

    release() {
        if (!this._setter)
            return;
        const tray = Main.messageTray;
        delete tray.bannerBlocked;
        this._setter.call(tray, this._othersBlock);
        this._setter = null;
    }
}

// Same rules as GNOME's banners: none for low urgency, none for an app whose
// banners are off in Settings, critical ones always.
export function wantsBanner(notification) {
    if (notification.urgency === MessageTray.Urgency.LOW)
        return false;
    return notification.source?.policy?.showBanners || notification.urgency === MessageTray.Urgency.CRITICAL;
}
