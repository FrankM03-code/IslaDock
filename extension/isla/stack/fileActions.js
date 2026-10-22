// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What can be done with a file of the stack. Nothing is ever deleted for good:
// the only destructive action is moving to the trash, after asking.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

export function launch(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        Main.notifyError('No se pudo abrir', e.message);
    }
}

export function openFolder(path) {
    launch(GLib.filename_to_uri(path, null));
}

// The file selected in the file manager; the plain folder if that fails.
export function showInFolder(entry) {
    Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1',
        'ShowItems', new GLib.Variant('(ass)', [[entry.uri], '']), null, Gio.DBusCallFlags.NONE, 3000, null, (bus, res) => {
            try {
                bus.call_finish(res);
            } catch {
                const parent = entry.file.get_parent();
                if (parent)
                    launch(parent.get_uri());
            }
        });
}

export function copyPath(entry) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, entry.path ?? entry.uri);
}

export function confirmTrash(entry) {
    const dialog = new ModalDialog.ModalDialog();
    dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
        title: `¿Mover «${entry.display}» a la papelera?`,
        description: 'Podrás sacarlo de la papelera si te arrepientes.',
    }));
    dialog.addButton({label: 'Cancelar', action: () => dialog.close(), key: Clutter.KEY_Escape});
    dialog.addButton({
        label: 'Mover a la papelera',
        action: () => {
            dialog.close();
            entry.file.trash_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
                try {
                    file.trash_finish(res);
                } catch (e) {
                    Main.notifyError('No se pudo mover a la papelera', e.message);
                }
            });
        },
    });
    dialog.open();
    return dialog;
}

// "ahora", "2 min", "1 h", "ayer", "lun", "12 oct".
const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function relativeTime(seconds) {
    if (!seconds)
        return '';
    const now = GLib.DateTime.new_now_local();
    const then = GLib.DateTime.new_from_unix_local(seconds);
    const diff = now.to_unix() - seconds;
    if (diff < 60)
        return 'ahora';
    if (diff < 3600)
        return `${Math.floor(diff / 60)} min`;
    const today = GLib.DateTime.new_local(now.get_year(), now.get_month(), now.get_day_of_month(), 0, 0, 0).to_unix();
    if (seconds >= today)
        return `${Math.floor(diff / 3600)} h`;
    if (seconds >= today - 86400)
        return 'ayer';
    if (seconds >= today - 6 * 86400)
        return DAYS[then.get_day_of_week() % 7];
    return `${then.get_day_of_month()} ${MONTHS[then.get_month() - 1]}`;
}
