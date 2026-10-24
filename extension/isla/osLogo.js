// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The logo of the system IslaDock runs on, as a white silhouette for the resting
// island. /etc/os-release names the system (ID, ID_LIKE) and often its logo (LOGO);
// the logo is looked up in the icon theme and in /usr/share/pixmaps, and its
// colored parts become white while white or almost white parts drop out (so a
// logo on a colored disk keeps its drawing as a cut-out). The silhouette is saved
// once in IslaDock's cache folder; null if the system has no logo to find.
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

const SIZE = 64;

function osRelease() {
    for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
        try {
            const [, bytes] = GLib.file_get_contents(path);
            const fields = {};
            for (const line of new TextDecoder().decode(bytes).split('\n')) {
                const m = line.match(/^([A-Z_]+)=(.*)$/);
                if (m)
                    fields[m[1]] = m[2].replace(/^["']|["']$/g, '');
            }
            return fields;
        } catch {}
    }
    return {};
}

// The image file of the system's logo, or null.
function logoFile() {
    const os = osRelease();
    const ids = [os.ID, ...(os.ID_LIKE ?? '').split(/\s+/)].filter(Boolean);
    const names = [];
    if (os.LOGO)
        names.push(`${os.LOGO}-symbolic`, os.LOGO);
    for (const id of ids)
        names.push(`${id}-logo-symbolic`, `${id}-logo-icon`, `${id}-logo`, `distributor-logo-${id}`, `start-here-${id}`);
    names.push('distributor-logo-symbolic', 'distributor-logo');
    const theme = new St.IconTheme();
    for (const name of names) {
        const file = theme.lookup_icon(name, SIZE, 0)?.get_filename();
        if (file)
            return file;
    }
    for (const name of names) {
        for (const ext of ['svg', 'png']) {
            const file = `/usr/share/pixmaps/${name}.${ext}`;
            if (GLib.file_test(file, GLib.FileTest.EXISTS))
                return file;
        }
    }
    return null;
}

// Colored -> white, white -> clear: the logo as a white silhouette.
function whiten(pixbuf) {
    const src = pixbuf.add_alpha(false, 0, 0, 0);
    const w = src.get_width(), h = src.get_height(), stride = src.get_rowstride();
    const px = src.get_pixels();
    const out = new Uint8Array(px.length);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * stride + x * 4;
            const max = Math.max(px[i], px[i + 1], px[i + 2]), min = Math.min(px[i], px[i + 1], px[i + 2]);
            // How white the pixel is: bright and without color.
            const white = Math.min(1, Math.max(0, (min - 190) / 50)) * (1 - Math.min(1, (max - min) / 40));
            out[i] = out[i + 1] = out[i + 2] = 255;
            out[i + 3] = Math.round(px[i + 3] * (1 - white));
        }
    }
    return GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(out), GdkPixbuf.Colorspace.RGB, true, 8, w, h, stride);
}

let _logo;   // Gio.FileIcon, or null once known there is none

export function osLogo() {
    if (_logo !== undefined)
        return _logo;
    _logo = null;
    try {
        const file = logoFile();
        if (file) {
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'isla-dock@frankm']);
            GLib.mkdir_with_parents(dir, 0o755);
            const out = GLib.build_filenamev([dir, 'logo-sistema.png']);
            whiten(GdkPixbuf.Pixbuf.new_from_file_at_scale(file, SIZE, SIZE, true)).savev(out, 'png', [], []);
            _logo = new Gio.FileIcon({file: Gio.File.new_for_path(out)});
        }
    } catch (e) {
        console.warn(`IslaDock: no se pudo preparar el logo del sistema: ${e}`);
    }
    return _logo;
}

// Forget it (IslaDock switched off).
export function forgetOsLogo() {
    _logo = undefined;
}
