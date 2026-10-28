// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Where the music and the timer show while the top island is on: in the dock,
// up top or in both ('musica-lugar', 'temporizador-lugar'). With the top
// island off they always stay in the dock.
export const PLACE_KEYS = ['isla-superior', 'musica-lugar', 'temporizador-lugar'];

export function inDock(settings, key) {
    return !settings.get_boolean('isla-superior') || settings.get_string(key) !== 'arriba';
}

export function onTop(settings, key) {
    return settings.get_boolean('isla-superior') && settings.get_string(key) !== 'dock';
}

// The top island shows the notifications ('isla-superior-avisos'): the floating cards and the
// notification center's popup over the dock step aside (the center still keeps and counts them).

export function notchNotices(settings) {
    return settings.get_boolean('isla-superior') && settings.get_boolean('isla-superior-avisos');
}
