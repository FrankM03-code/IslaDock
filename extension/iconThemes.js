// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Icon-theme helpers shared by the extension and the preferences window
// (only Gio/GLib here: prefs.js runs outside GNOME Shell).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const USER_ICONS = GLib.build_filenamev([GLib.get_home_dir(), '.icons']);
export const USER_DOCK_ICONS = GLib.build_filenamev([USER_ICONS, 'isla-dock']);

export function iconThemeDirs() {
    return [
        USER_ICONS,
        GLib.build_filenamev([GLib.get_user_data_dir(), 'icons']),
        ...GLib.get_system_data_dirs().map(d => GLib.build_filenamev([d, 'icons'])),
    ];
}

function readKeyFile(path) {
    const kf = new GLib.KeyFile();
    try {
        kf.load_from_file(path, GLib.KeyFileFlags.NONE);
        return kf;
    } catch {
        return null;
    }
}

function getString(kf, group, key) {
    try {
        return kf.get_string(group, key);
    } catch {
        return null;
    }
}

// Themes that hold icons (not cursor-only), user folders first: [{id, name, path}].
export function listIconThemes() {
    const seen = new Map();
    for (const base of iconThemeDirs()) {
        let en;
        try {
            en = Gio.File.new_for_path(base).enumerate_children('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            continue;
        }
        let info;
        while ((info = en.next_file(null))) {
            if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                continue;
            const id = info.get_name();
            if (seen.has(id))
                continue;
            const path = GLib.build_filenamev([base, id]);
            const kf = readKeyFile(GLib.build_filenamev([path, 'index.theme']));
            if (!kf || !getString(kf, 'Icon Theme', 'Directories'))
                continue;
            seen.set(id, {id, name: getString(kf, 'Icon Theme', 'Name') || id, path});
        }
        en.close(null);
    }
    return [...seen.values()];
}

export function findIconTheme(id) {
    if (!id)
        return null;
    for (const base of iconThemeDirs()) {
        const path = GLib.build_filenamev([base, id]);
        if (GLib.file_test(GLib.build_filenamev([path, 'index.theme']), GLib.FileTest.EXISTS))
            return path;
    }
    return null;
}

// name -> best file of one theme folder (scalable SVG first, then the biggest size).
// Also returns the folders holding app icons, to watch them for new files.
// Read without blocking: a theme such as Breeze has thousands of files.
export async function indexIconTheme(path, cancellable = null) {
    const index = new Map();
    const appDirs = [];
    const kf = readKeyFile(GLib.build_filenamev([path, 'index.theme']));
    if (!kf)
        return {index, appDirs};
    const dirs = [getString(kf, 'Icon Theme', 'Directories'), getString(kf, 'Icon Theme', 'ScaledDirectories')]
        .filter(Boolean).join(',').split(',').map(d => d.trim()).filter(Boolean);
    for (const dir of new Set(dirs)) {
        const type = getString(kf, dir, 'Type') ?? 'Threshold';
        const size = parseInt(getString(kf, dir, 'Size') ?? '0', 10) || 0;
        const scale = parseInt(getString(kf, dir, 'Scale') ?? '1', 10) || 1;
        const context = getString(kf, dir, 'Context') ?? '';
        const score = type === 'Scalable' ? 100000 : size * scale;
        const full = GLib.build_filenamev([path, dir]);
        let names;
        try {
            names = await listNames(Gio.File.new_for_path(full), cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            continue;
        }
        if (context === 'Applications' || context === 'Places')
            appDirs.push(full);
        for (const file of names) {
            const m = file.match(/^(.*)\.(svg|png)$/i);
            if (!m)
                continue;
            const name = m[1].toLowerCase();
            const s = score + (m[2].toLowerCase() === 'svg' ? 1 : 0);
            const prev = index.get(name);
            if (!prev || prev.score < s)
                index.set(name, {score: s, path: GLib.build_filenamev([full, file])});
        }
    }
    return {index, appDirs};
}

// The file names of a folder, read in batches in the background.
function listNames(dir, cancellable) {
    return new Promise((resolve, reject) => {
        dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable, (d, res) => {
            let en;
            try {
                en = d.enumerate_children_finish(res);
            } catch (e) {
                reject(e);
                return;
            }
            const names = [];
            const next = () => en.next_files_async(200, GLib.PRIORITY_LOW, cancellable, (_e, r) => {
                let infos;
                try {
                    infos = en.next_files_finish(r);
                } catch (e) {
                    en.close_async(GLib.PRIORITY_LOW, null, null);
                    reject(e);
                    return;
                }
                if (!infos.length) {
                    en.close_async(GLib.PRIORITY_LOW, null, null);
                    resolve(names);
                    return;
                }
                infos.forEach(i => names.push(i.get_name()));
                next();
            });
            next();
        });
    });
}
