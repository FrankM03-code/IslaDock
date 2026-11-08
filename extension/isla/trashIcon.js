// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The dock's own Papelera, whatever the icon theme: a small bin in a ring, the ring partly blue
// when full, and a red disc with a white bin while a dock icon is held over it (let go = off the
// dock). On a dark island the line is light. The drawings are in icons/papelera.
import Gio from 'gi://Gio';

// look: 'vacia' | 'llena' | 'soltar'
export function trashIcon(look, dark = false) {
    const extensionDir = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
    const file = extensionDir.get_child('icons').get_child('papelera').get_child(`papelera-${look}${dark ? '-oscura' : ''}.svg`);
    return new Gio.FileIcon({file});
}
