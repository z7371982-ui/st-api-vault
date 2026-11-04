// Phone layout helpers. On narrow screens the panel and the quick picker become bottom sheets:
// they sit above the on-screen keyboard and can be dragged down to close.

export const isCompact = () => matchMedia('(max-width: 768px)').matches;
// No hover and a finger for a pointer: there is no keyboard shortcut to advertise.
export const isTouch = () => matchMedia('(hover: none) and (pointer: coarse)').matches;

/** Keeps the CSS variable --avm-kb at the on-screen keyboard height, so bottom sheets stay above it. */
export function trackKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
        const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
        document.documentElement.style.setProperty('--avm-kb', `${kb}px`);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
}

/**
 * A round floating button that can be dragged anywhere and snaps to the nearest side edge.
 * A short tap (moved less than 6px) calls `onTap`. Position is kept as fractions of the viewport.
 * @param {{onTap:Function, getPos:() => ({x:number, y:number}|null), setPos:(pos:{x:number, y:number}) => void}} opts
 */
export function createFab({ onTap, getPos, setPos }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avm-root avm-fab';
    btn.setAttribute('aria-label', '打开 API 管理器');
    btn.title = 'API 管理器（可拖动）';
    btn.innerHTML = '<i class="fa-solid fa-key"></i>';

    const size = () => btn.offsetWidth || 48;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const place = (left, top) => {
        btn.style.left = `${clamp(left, 6, innerWidth - size() - 6)}px`;
        btn.style.top = `${clamp(top, 6, innerHeight - size() - 6)}px`;
    };
    const restore = () => {
        const p = getPos() || { x: 1, y: 0.62 };
        place(p.x >= 0.5 ? innerWidth - size() - 6 : 6, p.y * innerHeight);
    };

    let start = null;
    let moved = false;
    btn.addEventListener('pointerdown', e => {
        if (e.button > 0) return;
        const r = btn.getBoundingClientRect();
        start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
        moved = false;
        btn.setPointerCapture?.(e.pointerId);
    });
    btn.addEventListener('pointermove', e => {
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) < 6) return;
        moved = true;
        btn.classList.add('is-dragging');
        place(start.left + dx, start.top + dy);
    });
    const end = () => {
        if (!start) return;
        start = null;
        btn.classList.remove('is-dragging');
        if (!moved) return;
        const r = btn.getBoundingClientRect();
        const pos = { x: r.left + r.width / 2 < innerWidth / 2 ? 0 : 1, y: r.top / innerHeight };
        setPos(pos);
        restore();
    };
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', end);
    // A drag ends in a click too; only a real tap opens the panel.
    btn.addEventListener('click', () => {
        if (!moved) onTap();
        moved = false;
    });
    window.addEventListener('resize', restore);

    document.body.append(btn);
    restore();
    return btn;
}

/** Dragging `handle` down moves `sheet` with the finger; past 80px it closes, otherwise it snaps back. */
export function swipeToClose(handle, sheet, onClose) {
    let startY = 0;
    let dy = 0;
    let dragging = false;

    handle.addEventListener('pointerdown', e => {
        if (!isCompact() || e.button > 0) return;
        if (e.target.closest('button, input, select, textarea, a, label')) return;
        dragging = true;
        startY = e.clientY;
        dy = 0;
        sheet.style.transition = 'none';
        handle.setPointerCapture?.(e.pointerId);
    });
    handle.addEventListener('pointermove', e => {
        if (!dragging) return;
        dy = Math.max(0, e.clientY - startY);
        sheet.style.transform = dy ? `translateY(${dy}px)` : '';
    });
    const end = () => {
        if (!dragging) return;
        dragging = false;
        sheet.style.transition = '';
        // Close before clearing the inline transform, so the closing animation starts from where the finger let go.
        if (dy > 80) onClose();
        sheet.style.transform = '';
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
}
