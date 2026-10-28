// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The dock's own Papelera, whatever the icon theme (Frank's "anillo" drawings,
// ~/Descargas/papelera-anillo, 2026-10-26): a small bin in a ring, the ring partly blue
// when full, and a red disc with a white bin while a dock icon is held over it (let go = off the dock). On a dark
// island the line is light. Each one is written once as an SVG in IslaDock's cache
// folder (the name carries the look, so a change is a new file, never a stale texture).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const LINE = '#3B3F55';
const LINE_DARK = '#E6E8F0';

const DRAWINGS = {
    vacia: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5" fill="none" stroke="${LINE}" stroke-width="1.6"/><path d="M9.2 10.4l.5 5.4a1 1 0 0 0 1 .9h2.6a1 1 0 0 0 1-.9l.5-5.4" fill="none" stroke="${LINE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.4 8.6h7.2" stroke="${LINE}" stroke-width="1.5" stroke-linecap="round"/><path d="M10.8 8.6v-.9h2.4v.9" fill="none" stroke="${LINE}" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
    llena: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5" fill="none" stroke="${LINE}" stroke-opacity=".25" stroke-width="1.6"/><circle cx="12" cy="12" r="9.5" fill="none" stroke="#2F6FE0" stroke-width="2" stroke-linecap="round" stroke-dasharray="41.8 59.7" transform="rotate(-90 12 12)"/><path d="M9.2 10.4l.5 5.4a1 1 0 0 0 1 .9h2.6a1 1 0 0 0 1-.9l.5-5.4" fill="none" stroke="${LINE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.4 8.6h7.2" stroke="${LINE}" stroke-width="1.5" stroke-linecap="round"/><path d="M10.8 8.6v-.9h2.4v.9" fill="none" stroke="${LINE}" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
    soltar: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.3" fill="#D92D20"/><path d="M8.4 8.6h7.2" stroke="#FFFFFF" stroke-width="1.5" stroke-linecap="round" transform="translate(0 -1.2)"/><path d="M9.2 10.4l.5 5.4a1 1 0 0 0 1 .9h2.6a1 1 0 0 0 1-.9l.5-5.4" fill="none" stroke="#FFFFFF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

// look: 'vacia' | 'llena' | 'soltar' -> Gio.FileIcon of that bin.
export function trashIcon(look, dark = false) {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'isla-dock@frankm', 'papelera']);
    const path = GLib.build_filenamev([dir, `papelera-${look}${dark ? '-oscura' : ''}-7.svg`]);
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
        GLib.mkdir_with_parents(dir, 0o755);
        GLib.file_set_contents(path, dark ? DRAWINGS[look].replaceAll(LINE, LINE_DARK) : DRAWINGS[look]);
    }
    return new Gio.FileIcon({file: Gio.File.new_for_path(path)});
}
