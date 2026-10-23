// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Bandeja, part 3: an app's tray menu (com.canonical.dbusmenu) drawn as a
// GNOME menu, the same kind the dock's right click uses. The layout is read
// fresh each time the menu opens (after AboutToShow), so it is never stale.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const IFACE = 'com.canonical.dbusmenu';

function call(bus, path, method, params) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(bus, path, IFACE, method, params, null, Gio.DBusCallFlags.NONE, 2000, null, (conn, res) => {
            try {
                resolve(conn.call_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// "_Abrir" → "Abrir" (mnemonics), "__" stays a single "_".
const label = text => (text ?? '').replace(/__/g, '\u0000').replace(/_/g, '').replace(/\u0000/g, '_');

// The whole tree: {id, props, children}
export async function readMenu(bus, path) {
    try {
        await call(bus, path, 'AboutToShow', new GLib.Variant('(i)', [0]));
    } catch {
        // Not every app has it.
    }
    const reply = await call(bus, path, 'GetLayout', new GLib.Variant('(iias)', [0, -1, []]));
    const [, layout] = reply.recursiveUnpack();
    const node = ([id, props, children]) => ({id, props, children: (children ?? []).map(node)});
    return node(layout);
}

function sendClick(bus, path, id) {
    call(bus, path, 'Event', new GLib.Variant('(isvu)', [id, 'clicked', new GLib.Variant('i', 0),
        Math.floor(Date.now() / 1000)])).catch(e => console.warn(`isla-dock: bandeja: menú: ${e.message}`));
}

// Fills a PopupMenu (or a submenu) with the tree's children. `close` runs after a click.
export function fillMenu(menu, tree, bus, path) {
    for (const child of tree.children) {
        const p = child.props;
        if (p.visible === false)
            continue;
        if (p.type === 'separator') {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            continue;
        }
        let item;
        if (p['children-display'] === 'submenu' || child.children.length) {
            item = new PopupMenu.PopupSubMenuMenuItem(label(p.label));
            fillMenu(item.menu, child, bus, path);
        } else {
            item = new PopupMenu.PopupMenuItem(label(p.label));
            item.connect('activate', () => sendClick(bus, path, child.id));
            if (p['toggle-type'] === 'checkmark')
                item.setOrnament(p['toggle-state'] === 1 ? (PopupMenu.Ornament.CHECK ?? PopupMenu.Ornament.DOT) : PopupMenu.Ornament.NONE);
            else if (p['toggle-type'] === 'radio')
                item.setOrnament(p['toggle-state'] === 1 ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
        }
        if (p.enabled === false)
            item.setSensitive(false);
        menu.addMenuItem(item);
    }
}
