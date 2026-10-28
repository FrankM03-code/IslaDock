// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The file side of the quick search: matching names without case or accents,
// readable folder names and dates, the colored type badges, and what the
// preview needs (thumbnails, PDF pages, the first lines of a text, a folder's
// contents). Everything that touches the disk is asynchronous.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {_, fmt, ngettext} from './i18n.js';
import {monthShort} from './dates.js';

Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

export const INFO = 'standard::type,standard::size,standard::content-type,standard::icon,time::modified,access::can-read';

// ---------- names ----------
// "Rút" and "RUT" both become "rut".
export const fold = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const stem = name => name.replace(/\.[^.]+$/, '');

// 0 exact name (without extension), 1 starts with it, 2 contains it, -1 no match.
export function rank(name, query) {
    const n = fold(name), q = fold(query);
    if (fold(stem(name)) === q || n === q)
        return 0;
    if (n.startsWith(q))
        return 1;
    return n.includes(q) ? 2 : -1;
}

// Pango markup of name with every match of query in bold and the accent color.
export function highlight(name, query, color) {
    const q = fold(query);
    const chars = [...name];
    let flat = '';
    const owner = [];
    chars.forEach((c, k) => {
        const f = fold(c);
        for (let u = 0; u < f.length; u++)
            owner.push(k);
        flat += f;
    });
    const marked = new Array(chars.length).fill(false);
    for (let at = q ? flat.indexOf(q) : -1; at >= 0; at = flat.indexOf(q, at + q.length)) {
        for (let u = at; u < at + q.length; u++)
            marked[owner[u]] = true;
    }
    let out = '';
    for (let k = 0; k < chars.length;) {
        let end = k;
        while (end < chars.length && marked[end] === marked[k])
            end++;
        const piece = GLib.markup_escape_text(chars.slice(k, end).join(''), -1);
        out += marked[k] ? `<span foreground="${color}" weight="bold">${piece}</span>` : piece;
        k = end;
    }
    // ClutterText's own color wins over a span that starts the text: a word joiner first.
    return marked[0] ? `\u2060${out}` : out;
}

// ---------- folders ----------
const SPECIAL = [
    [GLib.UserDirectory.DIRECTORY_DOCUMENTS, () => _('Documentos')],
    [GLib.UserDirectory.DIRECTORY_DOWNLOAD, () => _('Descargas')],
    [GLib.UserDirectory.DIRECTORY_DESKTOP, () => _('Escritorio')],
    [GLib.UserDirectory.DIRECTORY_PICTURES, () => _('Imágenes')],
    [GLib.UserDirectory.DIRECTORY_MUSIC, () => _('Música')],
    [GLib.UserDirectory.DIRECTORY_VIDEOS, () => _('Vídeos')],
];

// The name of a folder as a person says it: "Documentos", "Carpeta personal", "rut_tramites".
export function folderLabel(path) {
    if (!path)
        return '';
    if (path === GLib.get_home_dir())
        return _('Carpeta personal');
    for (const [dir, label] of SPECIAL) {
        if (GLib.get_user_special_dir(dir) === path)
            return label();
    }
    return GLib.path_get_basename(path);
}

// ~/Documentos/rut.pdf
export const shortPath = path => {
    const home = GLib.get_home_dir();
    return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

// ---------- dates ----------
const dayStart = dt => GLib.DateTime.new_local(dt.get_year(), dt.get_month(), dt.get_day_of_month(), 0, 0, 0);

// Whole days between the day of `then` and today (0 today, 1 yesterday).
function daysAgo(then, now) {
    return Math.round(dayStart(now).difference(dayStart(then)) / GLib.TIME_SPAN_DAY);
}

// "hace unos minutos", "hoy", "ayer", "hace 5 días", "hace 2 meses".
export function relativeDate(unix) {
    if (!unix)
        return '';
    const now = GLib.DateTime.new_now_local();
    const then = GLib.DateTime.new_from_unix_local(unix);
    const days = daysAgo(then, now);
    if (days <= 0)
        return now.to_unix() - unix < 3600 ? _('hace unos minutos') : _('hoy');
    if (days === 1)
        return _('ayer');
    if (days < 30)
        return fmt(ngettext('hace {n} día', 'hace {n} días', days), {n: days});
    const months = Math.floor(days / 30.4);
    if (months < 12)
        return fmt(ngettext('hace {n} mes', 'hace {n} meses', months), {n: months});
    const years = Math.floor(days / 365);
    return fmt(ngettext('hace {n} año', 'hace {n} años', years), {n: years});
}

let _interface = null;
function clockTime(dt) {
    _interface ??= new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    if (_interface.get_string('clock-format') === '24h')
        return dt.format('%H:%M');
    const h = dt.get_hour();
    return `${h % 12 || 12}:${dt.format('%M')} ${h < 12 ? _('a. m.') : _('p. m.')}`;
}

// "ayer, 4:12 p. m." or "12 oct 2026, 9:30 a. m.".
export function absoluteDate(unix) {
    if (!unix)
        return '';
    const now = GLib.DateTime.new_now_local();
    const then = GLib.DateTime.new_from_unix_local(unix);
    const days = daysAgo(then, now);
    const day = days === 0 ? _('hoy') : days === 1 ? _('ayer')
        : `${then.get_day_of_month()} ${monthShort(then)} ${then.get_year()}`;
    return `${day}, ${clockTime(then)}`;
}

// ---------- type badges ----------
const BADGES = [
    [/^pdf$/, '#d93a3a'],
    [/^(docx?|odt|rtf)$/, '#2f6fd6'],
    [/^(xlsx?|ods|csv)$/, '#1f9d55'],
];

// {text, color} for the little colored page of a file: "PDF" in red, etc.
export function badge(name) {
    const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
    const color = BADGES.find(([re]) => re.test(ext))?.[1] ?? '#7c8794';
    return {text: ext.slice(0, 4).toUpperCase() || '?', color};
}

export const isImage = type => !!type && Gio.content_type_is_a(type, 'image/*') && !type.includes('svg');
export const isPdf = type => type === 'application/pdf';
export const isText = type => !!type && Gio.content_type_is_a(type, 'text/plain');

// ---------- where to look ----------
// Recent files from GTK's history (~/.local/share/recently-used.xbel), newest
// first. Read without blocking the Shell: done(files) is called when ready.
export function recentFiles(cancellable, done) {
    const file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']));
    file.load_contents_async(cancellable, (f, res) => {
        let bytes;
        try {
            [, bytes] = f.load_contents_finish(res);
        } catch {
            return;
        }
        done(parseRecent(new TextDecoder().decode(bytes)));
    });
}

function parseRecent(xml) {
    try {
        const files = [];
        for (const m of xml.matchAll(/<bookmark\s[^>]*href="([^"]+)"[^>]*modified="([^"]+)"/g)) {
            const uri = m[1].replace(/&amp;/g, '&');
            if (!uri.startsWith('file://'))
                continue;
            files.push({uri, modified: m[2]});
        }
        files.sort((a, b) => b.modified.localeCompare(a.modified));
        return files.map(f => Gio.File.new_for_uri(f.uri).get_path()).filter(Boolean);
    } catch {
        return [];
    }
}

// Every place the history knows: its entries and the folders that hold them.
export function candidates(paths) {
    const home = GLib.get_home_dir();
    const all = new Set(paths);
    for (const path of paths) {
        const dir = GLib.path_get_dirname(path);
        if (dir !== home && dir !== '/' && dir.startsWith(`${home}/`))
            all.add(dir);
    }
    return [...all];
}

// The desktop's file index (localsearch, formerly Tracker): paths whose name holds query,
// newest first. [] when the index or its library is missing.
let index = null;
async function indexConnection() {
    if (index !== null)
        return index;
    index = false;
    let Sparql = null;
    for (const name of ['gi://Tsparql', 'gi://Tracker?version=3.0']) {
        try {
            Sparql = (await import(name)).default;
            break;
        } catch {}
    }
    for (const bus of ['org.freedesktop.LocalSearch3', 'org.freedesktop.Tracker3.Miner.Files']) {
        try {
            index = await new Promise((resolve, reject) => Sparql.SparqlConnection.bus_new_async(bus, null, null, null,
                (_o, res) => {
                    try {
                        resolve(Sparql.SparqlConnection.bus_new_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }));
            break;
        } catch {}
    }
    return index;
}

const INDEX_QUERY = `SELECT ?url WHERE { GRAPH tracker:FileSystem { ?f a nfo:FileDataObject ; nfo:fileName ?name ;
    nie:url ?url . FILTER(CONTAINS(LCASE(?name), ~q)) } } ORDER BY DESC(nfo:fileLastModified(?f)) LIMIT ~max`;

export async function indexedFiles(query, max, cancellable) {
    const connection = await indexConnection();
    if (!connection || cancellable?.is_cancelled())
        return [];
    try {
        const statement = connection.query_statement(INDEX_QUERY, cancellable);
        statement.bind_string('q', query.toLowerCase());
        statement.bind_int('max', max);
        const cursor = await new Promise((resolve, reject) => statement.execute_async(cancellable, (_o, res) => {
            try {
                resolve(statement.execute_finish(res));
            } catch (e) {
                reject(e);
            }
        }));
        const paths = [];
        while (await new Promise(resolve => cursor.next_async(cancellable, (_o, res) => {
            try {
                resolve(cursor.next_finish(res));
            } catch {
                resolve(false);
            }
        }))) {
            const path = Gio.File.new_for_uri(cursor.get_string(0)[0]).get_path();
            if (path)
                paths.push(path);
        }
        cursor.close();
        return paths;
    } catch {
        return [];
    }
}

// ---------- file info ----------
// {path, uri, name, dir, type, size, mtime, folder, readable} or null when it is gone.
export async function fileInfo(path, cancellable) {
    const file = Gio.File.new_for_path(path);
    let info;
    try {
        info = await file.query_info_async(INFO, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    } catch {
        return null;
    }
    return {
        path, uri: file.get_uri(), name: file.get_basename(), dir: file.get_parent()?.get_path() ?? '',
        type: info.get_content_type(), gicon: info.get_icon(), size: info.get_size(),
        mtime: info.get_modification_date_time()?.to_unix() ?? 0,
        folder: info.get_file_type() === Gio.FileType.DIRECTORY,
        readable: info.get_attribute_boolean('access::can-read'),
    };
}

// The visible children of a folder: [{name, gicon}], at most `max`.
export async function folderChildren(path, max, cancellable) {
    const children = [];
    try {
        const en = await Gio.File.new_for_path(path).enumerate_children_async('standard::name,standard::icon,standard::is-hidden',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable);
        for (;;) {
            const infos = await en.next_files_async(200, GLib.PRIORITY_LOW, cancellable);
            if (!infos.length)
                break;
            for (const info of infos) {
                if (!info.get_is_hidden())
                    children.push({name: info.get_name(), gicon: info.get_icon()});
            }
            if (children.length >= max)
                break;
        }
        en.close_async(GLib.PRIORITY_LOW, null, null);
    } catch {
        return null;
    }
    return children.slice(0, max);
}

// The first `lines` lines of a text file.
export async function textHead(path, lines, cancellable) {
    try {
        const stream = await Gio.File.new_for_path(path).read_async(GLib.PRIORITY_LOW, cancellable);
        const bytes = await stream.read_bytes_async(4096, GLib.PRIORITY_LOW, cancellable);
        stream.close_async(GLib.PRIORITY_LOW, null, null);
        return new TextDecoder().decode(bytes.toArray()).split('\n').slice(0, lines).map(l => l.replace(/\t/g, '    ')).join('\n');
    } catch {
        return null;
    }
}

async function run(argv, cancellable) {
    try {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [out] = await proc.communicate_utf8_async(null, cancellable);
        return proc.get_successful() ? out : null;
    } catch {
        return null;
    }
}

// Number of pages of a PDF (pdfinfo, from poppler-utils), or null.
export async function pdfPages(path, cancellable) {
    const out = await run(['pdfinfo', path], cancellable);
    const n = out && /^Pages:\s+(\d+)/m.exec(out);
    return n ? Number(n[1]) : null;
}

// ---------- thumbnails ----------
const MAX_THUMBS = 50;

// Paths of PNG thumbnails: the freedesktop cache first (~/.cache/thumbnails),
// then a page 1 rendered with pdftoppm into a small cache of our own (in
// $XDG_RUNTIME_DIR, at most 50, removed when the search goes away).
export class Thumbnails {
    constructor() {
        this._own = new Map();
        this._dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'isla-dock-miniaturas']);
        this._serial = 0;
    }

    async get(item, cancellable) {
        const key = `${item.uri}@${item.mtime}`;
        if (this._own.has(key)) {
            const path = this._own.get(key);
            this._own.delete(key);
            this._own.set(key, path);
            return path;
        }
        const md5 = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, item.uri, -1);
        for (const size of ['x-large', 'large', 'normal']) {
            const path = GLib.build_filenamev([GLib.get_user_cache_dir(), 'thumbnails', size, `${md5}.png`]);
            if (await exists(path, cancellable))
                return path;
        }
        if (!item.readable)
            return null;
        if (isImage(item.type))
            return item.path;
        if (!isPdf(item.type))
            return null;
        GLib.mkdir_with_parents(this._dir, 0o700);
        const prefix = GLib.build_filenamev([this._dir, `m${++this._serial}`]);
        const ok = await run(['pdftoppm', '-png', '-f', '1', '-l', '1', '-singlefile', '-scale-to', '340', item.path, prefix],
            cancellable);
        if (ok === null)
            return null;
        const path = `${prefix}.png`;
        this._own.set(key, path);
        while (this._own.size > MAX_THUMBS) {
            const [oldest, old] = this._own.entries().next().value;
            this._own.delete(oldest);
            GLib.unlink(old);
        }
        return path;
    }

    destroy() {
        for (const path of this._own.values())
            GLib.unlink(path);
        this._own.clear();
    }
}

async function exists(path, cancellable) {
    try {
        await Gio.File.new_for_path(path).query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, cancellable);
        return true;
    } catch {
        return false;
    }
}
