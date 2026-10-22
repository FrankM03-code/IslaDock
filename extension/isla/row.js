// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

// A row that gives each child exactly its natural width. St.BoxLayout asks
// the icons for their width at another height and gets a different answer,
// so it squeezes them (or the music text). Children are centered vertically,
// except those aligned to the bottom.
export const RowLayout = GObject.registerClass(
class IslaRowLayout extends Clutter.LayoutManager {
    _init(spacing) {
        super._init();
        this.spacing = spacing;
    }

    _children(container) {
        return container.get_children().filter(c => c.visible);
    }

    // Natural size of a child, its width measured at the height it will get.
    _size(child) {
        const [, h] = child.get_preferred_height(-1);
        const [, w] = child.get_preferred_width(h);
        return [w, h];
    }

    vfunc_get_preferred_width(container) {
        const kids = this._children(container);
        const w = kids.reduce((sum, c) => sum + this._size(c)[0], 0) + Math.max(0, kids.length - 1) * this.spacing;
        return [w, w];
    }

    vfunc_get_preferred_height(container) {
        const h = Math.max(0, ...this._children(container).map(c => c.get_preferred_height(-1)[1]));
        return [h, h];
    }

    vfunc_allocate(container, box) {
        let x = box.x1;
        for (const child of this._children(container)) {
            const [w, h] = this._size(child);
            const y = child.y_align === Clutter.ActorAlign.END ? box.y2 - h
                : Math.round(box.y1 + (box.get_height() - h) / 2);
            const b = new Clutter.ActorBox();
            b.set_origin(Math.round(x), y);
            b.set_size(w, h);
            child.allocate(b);
            x += w + this.spacing;
        }
    }
});
