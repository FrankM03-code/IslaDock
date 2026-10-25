#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Frank Molina
# SPDX-License-Identifier: GPL-2.0-or-later
# Installs IslaDock for the current user from this folder.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
UUID="isla-dock@frankm"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r extension/. "$DEST/"
glib-compile-schemas "$DEST/schemas/"
echo "IslaDock instalada en $DEST"
echo "Reinicia GNOME (X11: Alt+F2, r, Enter · Wayland: cierra sesión) y actívala con:"
echo "  gnome-extensions enable $UUID"
