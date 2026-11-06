// Phone layout helpers. On narrow screens the panel and the quick picker become bottom sheets:
// they sit above the on-screen keyboard and can be dragged down to close.

export const isCompact = () => matchMedia('(max-width: 768px)').matches;
// No hover and a finger for a pointer: there is no keyboard shortcut to advertise.
export const isTouch = () => matchMedia('(hover: none) and (pointer: coarse)').matches;

/**
 * Keeps two CSS variables in step with what is actually on screen:
 *   --avm-vh  1% of the visible height. Used instead of dvh, which older Android browsers and WebViews
 *             (common for Termux users) drop, and instead of vh, which on phones includes the area under
 *             the address bar and so cuts the bottom of a sheet off.
 *   --avm-kb  on-screen keyboard height, so bottom sheets stay above it.
 */
export function trackViewport() {
    const vv = window.visualViewport;
    const root = document.documentElement.style;
    const update = () => {
        // Layout viewport height: the screen area the page really gets, without the address bar.
        // The keyboard is handled separately by --avm-kb, so it must not shrink this one as well,
        // otherwise a sheet loses the keyboard height twice.
        const h = innerHeight || document.documentElement.clientHeight;
        root.setProperty('--avm-vh', `${h / 100}px`);
        // Pinch zoom also shrinks the visual viewport; that is not a keyboard.
        let kb = vv && vv.scale <= 1.01 ? Math.round(h - vv.height - vv.offsetTop) : 0;
        if (kb < 0 || kb > h * 0.75) kb = 0;
        root.setProperty('--avm-kb', `${kb}px`);
    };
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', () => setTimeout(update, 300));
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
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
    btn.setAttribute('aria-label', '打开通用钥匙API管理器');
    btn.title = '通用钥匙API管理器（可拖动）';
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
