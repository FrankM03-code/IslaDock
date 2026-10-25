#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Frank Molina
# SPDX-License-Identifier: GPL-2.0-or-later
# Translations without the gettext tools (not installed here):
#   python3 po/traducir.py pot   → po/isladock.pot from every _('…') / N_('…') in extension/
#   python3 po/traducir.py mo    → extension/locale/<lang>/LC_MESSAGES/isladock.mo from po/<lang>.po
#   python3 po/traducir.py check → texts of the .pot missing in each .po
# The .po files are ordinary gettext files (msgid / msgstr), editable with any tool.
import ast
import os
import re
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, 'extension')
PO = os.path.join(ROOT, 'po')
DOMAIN = 'isladock'
CALL = re.compile(r"(?<![\w.$])N?_\(\s*'((?:\\.|[^'\\])*)'\s*\)")
# ngettext('one', 'many', n): kept as "one\0many", the way the .mo stores plurals.
PLURAL = re.compile(r"(?<![\w.$])ngettext\(\s*'((?:\\.|[^'\\])*)'\s*,\s*'((?:\\.|[^'\\])*)'")


def extract():
    found = {}
    for root, _dirs, files in os.walk(EXT):
        for name in sorted(files):
            if not name.endswith('.js') or name == 'i18n.js':
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, ROOT)
            for n, line in enumerate(open(path, encoding='utf-8'), 1):
                for m in CALL.finditer(line):
                    text = ast.literal_eval("'" + m.group(1) + "'")
                    found.setdefault(text, []).append(f'{rel}:{n}')
                for m in PLURAL.finditer(line):
                    one, many = (ast.literal_eval("'" + g + "'") for g in m.groups())
                    found.setdefault(f'{one}\0{many}', []).append(f'{rel}:{n}')
    return found


def quote(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"'


def write_pot():
    found = extract()
    out = ['# IslaDock — created and designed by Frank Molina.', 'msgid ""', 'msgstr ""', '"Project-Id-Version: IslaDock\\n"', '"Content-Type: text/plain; charset=UTF-8\\n"', '']
    for text, places in found.items():
        out.append('#: ' + ' '.join(places[:4]))
        if '\0' in text:
            one, many = text.split('\0')
            out += ['msgid ' + quote(one), 'msgid_plural ' + quote(many), 'msgstr[0] ""', 'msgstr[1] ""', '']
        else:
            out += ['msgid ' + quote(text), 'msgstr ""', '']
    open(os.path.join(PO, f'{DOMAIN}.pot'), 'w', encoding='utf-8').write('\n'.join(out))
    print(f'{len(found)} textos → po/{DOMAIN}.pot')


# {msgid: msgstr}; a plural is {"one\0many": "form0\0form1"} (empty while a form is missing).
def read_po(path):
    entries, ids, strs, where = {}, None, [], None

    def unq(s):
        return ast.literal_eval(s)

    def done():
        if ids is not None:
            entries['\0'.join(ids)] = '\0'.join(strs) if all(strs) else ''
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if line.startswith('msgid '):
            done()
            ids, strs, where = [unq(line[6:])], [], 'id'
        elif line.startswith('msgid_plural '):
            ids.append(unq(line[13:]))
        elif line.startswith('msgstr'):
            strs.append(unq(line.split(' ', 1)[1]))
            where = 'str'
        elif line.startswith('"'):
            if where == 'id':
                ids[-1] += unq(line)
            elif where == 'str':
                strs[-1] += unq(line)
    done()
    return entries


def write_mo(entries, path):
    pairs = sorted((k, v) for k, v in entries.items() if v or k == '')
    ids = [k.encode() for k, _ in pairs]
    strs = [v.encode() for _, v in pairs]
    n = len(pairs)
    start = 7 * 4
    ids_table, strs_table = start, start + n * 8
    data_at = strs_table + n * 8
    offsets, blob = [], b''
    for s in ids:
        offsets.append((len(s), data_at + len(blob)))
        blob += s + b'\0'
    for s in strs:
        offsets.append((len(s), data_at + len(blob)))
        blob += s + b'\0'
    head = struct.pack('<7I', 0x950412de, 0, n, ids_table, strs_table, 0, 0)
    table = b''.join(struct.pack('<2I', length, at) for length, at in offsets)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'wb').write(head + table + blob)


def build_mo():
    for name in sorted(os.listdir(PO)):
        if not name.endswith('.po'):
            continue
        lang = name[:-3]
        entries = read_po(os.path.join(PO, name))
        path = os.path.join(EXT, 'locale', lang, 'LC_MESSAGES', f'{DOMAIN}.mo')
        write_mo(entries, path)
        print(f'{lang}: {sum(1 for k, v in entries.items() if k and v)} textos → {os.path.relpath(path, ROOT)}')


def check():
    wanted = set(extract())
    bad = 0
    for name in sorted(os.listdir(PO)):
        if name.endswith('.po'):
            have = {k for k, v in read_po(os.path.join(PO, name)).items() if v}
            missing = sorted(wanted - have)
            bad += len(missing)
            print(f'{name}: faltan {len(missing)}')
            for m in missing[:20]:
                print('   ', m)
    return bad


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'check'
    if cmd == 'pot':
        write_pot()
    elif cmd == 'mo':
        build_mo()
    else:
        sys.exit(1 if check() else 0)
