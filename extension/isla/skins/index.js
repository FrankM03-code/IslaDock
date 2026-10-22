// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Registry of the island's skins: isla-piel key -> class.
import {AuroraSkin} from './aurora.js';
import {ClasicaSkin} from './clasica.js';
import {VidrioOscuroSkin} from './vidrioOscuro.js';

export const SKINS = {
    clasica: ClasicaSkin,
    'vidrio-oscuro': VidrioOscuroSkin,
    aurora: AuroraSkin,
};

export function createSkin(key, isla) {
    const Skin = SKINS[key] ?? ClasicaSkin;
    return new Skin(isla, SKINS[key] ? key : 'clasica');
}
