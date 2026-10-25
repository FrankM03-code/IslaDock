// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The dock's own Papelera, empty and full, whatever the icon theme: a white bin
// whose lid takes GNOME's accent color (Settings → Appearance). Each color is
// written once as an SVG in IslaDock's cache folder (its name carries the color,
// so a new accent is a new file and never a stale texture). The drawing is
// framed (viewBox) so the bin stands on the same line as the other icons, with the
// same room below as theirs (the running dot must not touch it), and the tilted lid
// of the full bin still fits; the same frame empty and full so it doesn't jump.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {accentRGB} from './accent.js';

const LID = '#FF6B4A';   // the design's lid, replaced by the accent

const EMPTY = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="20 10 200 200">
  <path d="M100 62 v-8 a8 8 0 0 1 8-8 h24 a8 8 0 0 1 8 8 v8" fill="none" stroke="#FF6B4A" stroke-width="9" stroke-linecap="round"/>
  <rect x="58" y="62" width="124" height="20" rx="10" fill="#FF6B4A"/>
  <path d="M68 94 h104 l-8.6 86 a14 14 0 0 1-13.9 12.6 H90.5 a14 14 0 0 1-13.9-12.6 Z" fill="#F2F2EF"/>
  <path d="M68 94 h104 l-1.2 12 H69.2 Z" fill="#000000" fill-opacity="0.08"/>
  <line x1="98" y1="118" x2="100" y2="170" stroke="#C9CBD0" stroke-width="7" stroke-linecap="round"/>
  <line x1="120" y1="118" x2="120" y2="170" stroke="#C9CBD0" stroke-width="7" stroke-linecap="round"/>
  <line x1="142" y1="118" x2="140" y2="170" stroke="#C9CBD0" stroke-width="7" stroke-linecap="round"/>
</svg>`;

const FULL = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="20 10 200 200">
  <circle cx="96" cy="90" r="17" fill="#DADCE0"/>
  <path d="M86 84 l8 6 l-4 8 M100 80 l4 9" fill="none" stroke="#B4B7BE" stroke-width="3" stroke-linecap="round"/>
  <rect x="112" y="68" width="30" height="36" rx="4" fill="#FFFFFF" transform="rotate(14 127 86)"/>
  <line x1="118" y1="78" x2="136" y2="82" stroke="#C9CBD0" stroke-width="3" stroke-linecap="round"/>
  <line x1="117" y1="86" x2="133" y2="90" stroke="#C9CBD0" stroke-width="3" stroke-linecap="round"/>
  <circle cx="148" cy="92" r="12" fill="#CFD2D7"/>
  <g transform="rotate(-16 66 72)">
    <path d="M96 52 v-8 a8 8 0 0 1 8-8 h24 a8 8 0 0 1 8 8 v8" fill="none" stroke="#FF6B4A" stroke-width="9" stroke-linecap="round"/>
    <rect x="54" y="52" width="124" height="20" rx="10" fill="#FF6B4A"/>
  </g>
  <path d="M68 94 h104 l-8.6 86 a14 14 0 0 1-13.9 12.6 H90.5 a14 14 0 0 1-13.9-12.6 Z" fill="#F2F2EF"/>
  <path d="M68 94 h104 l-1.2 12 H69.2 Z" fill="#000000" fill-opacity="0.08"/>
  <line x1="98" y1="118" x2="100" y2="170" stroke="#C9CBD0" stroke-width="7" stroke-linecap="round"/>
  <line x1="120" y1="118" x2="120" y2="170" stroke="#C9CBD0" stroke-width="7" stroke-linecap="round"/>
  <line x1="142" y1="118" x2="140" y2="170" stroke="#C9CBD0" stroke-width="7" stroke-linecap="round"/>
</svg>`;

const hex = rgb => rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

// -> Gio.FileIcon of the bin (full or empty) in the current accent color.
export function trashIcon(full) {
    const color = hex(accentRGB());
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'isla-dock@frankm', 'papelera']);
    const path = GLib.build_filenamev([dir, `papelera-${full ? 'llena' : 'vacia'}-${color}-5.svg`]);
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
        GLib.mkdir_with_parents(dir, 0o755);
        GLib.file_set_contents(path, (full ? FULL : EMPTY).replaceAll(LID, `#${color}`));
    }
    return new Gio.FileIcon({file: Gio.File.new_for_path(path)});
}
