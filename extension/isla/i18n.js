// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Translations (gettext domain 'isladock', po/ in the repository). GNOME binds
// the domain to the extension's locale/ folder when it loads the extension
// ('gettext-domain' in metadata.json), in the Shell and in Preferences.
// _() looks a text up when called: tables made at import time mark their
// texts with N_() and translate them where they are shown.
import GLib from 'gi://GLib';

const DOMAIN = 'isladock';

export const _ = text => GLib.dgettext(DOMAIN, text);
export const N_ = text => text;
export const ngettext = (one, many, n) => GLib.dngettext(DOMAIN, one, many, n);

// fmt(_('Quedan {tiempo}'), {tiempo: '35 min'}): named holes, so a translation
// can move them around.
export function fmt(text, values) {
    return text.replace(/\{(\w+)\}/g, (all, name) => (name in values ? String(values[name]) : all));
}

// A day or month name in the user's language ('%a', '%A', '%b', '%B'), without
// the period some languages put after short names.
export function localName(dateTime, code) {
    return dateTime.format(code).replace(/\.$/, '');
}
