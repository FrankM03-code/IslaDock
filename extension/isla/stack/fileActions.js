// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What can be done with a file of the stack. Nothing is ever deleted for good,
// except by emptying the trash: that and moving to the trash ask first.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {_, fmt, localName} from '../i18n.js';

export function launch(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        Main.notifyError(_('No se pudo abrir'), e.message);
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
        title: fmt(_('¿Mover «{nombre}» a la papelera?'), {nombre: entry.display}),
        description: _('Podrás sacarlo de la papelera si te arrepientes.'),
    }));
    dialog.addButton({label: _('Cancelar'), action: () => dialog.close(), key: Clutter.KEY_Escape});
    dialog.addButton({
        label: _('Mover a la papelera'),
        action: () => {
            dialog.close();
            entry.file.trash_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
                try {
                    file.trash_finish(res);
                } catch (e) {
                    Main.notifyError(_('No se pudo mover a la papelera'), e.message);
                }
            });
        },
    });
    dialog.open();
    return dialog;
}

export function confirmEmptyTrash() {
    const dialog = new ModalDialog.ModalDialog();
    dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
        title: _('¿Vaciar la papelera?'),
        description: _('Todo lo que está en la papelera se borrará para siempre.'),
    }));
    dialog.addButton({label: _('Cancelar'), action: () => dialog.close(), key: Clutter.KEY_Escape});
    dialog.addButton({
        label: _('Vaciar'),
        action: () => {
            dialog.close();
            try {
                Gio.Subprocess.new(['gio', 'trash', '--empty'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                Main.notifyError(_('No se pudo vaciar la papelera'), e.message);
            }
        },
    });
    dialog.open();
    return dialog;
}

// "ahora", "2 min", "1 h", "ayer", "lun", "12 oct".

export function relativeTime(seconds) {
    if (!seconds)
        return '';
    const now = GLib.DateTime.new_now_local();
    const then = GLib.DateTime.new_from_unix_local(seconds);
    const diff = now.to_unix() - seconds;
    if (diff < 60)
        return _('ahora');
    if (diff < 3600)
        return `${Math.floor(diff / 60)} min`;
    const today = GLib.DateTime.new_local(now.get_year(), now.get_month(), now.get_day_of_month(), 0, 0, 0).to_unix();
    if (seconds >= today)
        return `${Math.floor(diff / 3600)} h`;
    if (seconds >= today - 86400)
        return _('ayer');
    if (seconds >= today - 6 * 86400)
        return localName(then, '%a');
    return `${then.get_day_of_month()} ${localName(then, '%b')}`;
}
