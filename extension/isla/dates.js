// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Day and month names for the clocks, in Spanish (translated with the rest of the
// extension, so they never depend on the system's language data), and the
// shared bits of time: two-digit 24 h time, the day's progress and this week.
import {_, N_} from './i18n.js';

const DAYS = [N_('lunes'), N_('martes'), N_('miércoles'), N_('jueves'), N_('viernes'), N_('sábado'), N_('domingo')];
const DAYS_SHORT = [N_('lun'), N_('mar'), N_('mié'), N_('jue'), N_('vie'), N_('sáb'), N_('dom')];
const MONTHS = [N_('enero'), N_('febrero'), N_('marzo'), N_('abril'), N_('mayo'), N_('junio'), N_('julio'),
    N_('agosto'), N_('septiembre'), N_('octubre'), N_('noviembre'), N_('diciembre')];
const MONTHS_SHORT = [N_('ene'), N_('feb'), N_('mar.'), N_('abr'), N_('may'), N_('jun'), N_('jul'), N_('ago'),
    N_('sep'), N_('oct'), N_('nov'), N_('dic')];
// Monday to Sunday, one letter each: the side clock's and the desktop clock's (X for miércoles).
const INITIALS = N_('L M M J V S D');
const INITIALS_X = N_('L M X J V S D');

// GLib.DateTime: day of the week 1 (Monday) … 7, month 1 … 12.
export const dayName = now => _(DAYS[now.get_day_of_week() - 1]);
export const dayShort = now => _(DAYS_SHORT[now.get_day_of_week() - 1]);
export const monthName = now => _(MONTHS[now.get_month() - 1]);
// 'mar.' only tells marzo from martes for the translators; it shows without the dot.
export const monthShort = now => _(MONTHS_SHORT[now.get_month() - 1]).replace(/\.$/, '');
export const initials = (withX = false) => _(withX ? INITIALS_X : INITIALS).split(' ');
export const capital = s => s ? s[0].toUpperCase() + s.slice(1) : s;

export const two = n => String(n).padStart(2, '0');

// 0 at midnight, 1 at the end of the day (17:47 is 0.74).
export const dayProgress = now => (now.get_hour() * 60 + now.get_minute()) / 1440;

// This week, Monday to Sunday: [{date (GLib.DateTime), today}].
export function week(now) {
    const today = now.get_day_of_week() - 1;
    const monday = now.add_days(-today);
    return Array.from({length: 7}, (_d, i) => ({date: monday.add_days(i), today: i === today, past: i < today}));
}
