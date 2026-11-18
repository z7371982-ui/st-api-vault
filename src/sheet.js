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
let refreshViewport = () => {};
/** Re-reads the viewport now, e.g. right before a sheet opens. */
export function syncViewport() {
    refreshViewport();
}

export function trackViewport() {
    const vv = window.visualViewport;
    const root = document.documentElement.style;
    let lastH = 0;
    const update = () => {
        // Layout viewport height: the screen area the page really gets, without the address bar.
        // The keyboard is handled separately by --avm-kb, so it must not shrink this one as well,
        // otherwise a sheet loses the keyboard height twice.
        // Phone WebViews report 0 or a tiny height for a moment (app switch, keyboard closing, page in the
        // background). A sheet sized from that is invisible while its dark backdrop still covers the page,
        // so such readings fall back to the last good one or the screen height.
        let h = innerHeight || document.documentElement.clientHeight;
        if (!(h >= 200)) h = lastH || Math.max(document.documentElement.clientHeight || 0, screen?.height || 0, 480);
        lastH = h;
        root.setProperty('--avm-vh', `${h / 100}px`);
        // Pinch zoom also shrinks the visual viewport; that is not a keyboard.
        let kb = vv && vv.scale <= 1.01 ? Math.round(h - vv.height - vv.offsetTop) : 0;
        // A keyboard never takes more than about half the screen; a bigger value is a stale reading
        // (visualViewport not resized back yet) and would squash the sheet to nothing.
        if (!(kb > 0) || kb > h * 0.6) kb = 0;
        root.setProperty('--avm-kb', `${kb}px`);
    };
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', () => setTimeout(update, 300));
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    // Coming back to the app: the values read while it was in the background may be stale.
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && update());
    window.addEventListener('pageshow', update);
    refreshViewport = update;
    update();
}

export function normalizeFabSize(value) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(80, Math.max(36, Math.round(value))) : 48;
}

/** A draggable key, or a narrow edge tab. Only a deliberate outward pull folds it. */
export function createFab({ onTap, getPos, setPos, getSize = () => 48 }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avm-root avm-fab';
    btn.innerHTML = '<i class="fa-solid fa-key" aria-hidden="true"></i>';

    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    // Phone WebViews report 0 or a few px for a moment (app switch, keyboard closing). Laid out from that,
    // the key shrank to a 1-2px sliver at the top edge and could not be tapped until the next resize.
    let lastView = null;
    const viewport = () => {
        const w = innerWidth || document.documentElement.clientWidth;
        const h = innerHeight || document.documentElement.clientHeight;
        if (w >= 120 && h >= 200) lastView = { width: w, height: h };
        return lastView || { width: Math.max(320, w || 0), height: Math.max(480, h || 0) };
    };
    const position = () => {
        const p = getPos();
        return { x: Number.isFinite(p?.x) && p.x < 0.5 ? 0 : 1,
            y: Number.isFinite(p?.y) ? clamp(p.y, 0, 1) : 0.62, collapsed: p?.collapsed === true };
    };
    let start = null;
    let moved = false;
    let suppressClick = false;
    let width = 48;
    let height = 48;
    let collapsed = false;
    let side = 1;
    let foldSide = null;
    const present = (folded, edge) => {
        const v = viewport();
        const diameter = Math.min(normalizeFabSize(getSize()), Math.max(1, v.width - 12), Math.max(1, v.height - 12));
        collapsed = folded;
        side = edge;
        width = folded ? Math.min(22, v.width) : diameter;
        height = folded ? Math.min(Math.max(48, diameter), Math.max(1, v.height - 12)) : diameter;
        btn.style.setProperty('--avm-fab-size', `${diameter}px`);
        btn.style.width = `${width}px`;
        btn.style.height = `${height}px`;
        btn.classList.toggle('is-collapsed', folded);
        btn.classList.toggle('is-left', edge === 0);
        btn.setAttribute('aria-label', folded ? '展开悬浮钥匙按钮' : '打开通用钥匙API管理器');
        btn.title = folded ? '点击展开，或向屏幕内拖出' : '通用钥匙API管理器（拖动移动，贴边后向外拖可收起）';
    };
    const place = (left, top) => {
        const v = viewport();
        const px = collapsed ? 0 : Math.min(6, Math.max(0, (v.width - width) / 2));
        const py = Math.min(6, Math.max(0, (v.height - height) / 2));
        btn.style.left = `${clamp(left, px, Math.max(px, v.width - width - px))}px`;
        btn.style.top = `${clamp(top, py, Math.max(py, v.height - height - py))}px`;
    };
    const restore = () => {
        if (start) return;
        const p = position();
        present(p.collapsed, p.x);
        place(p.x ? viewport().width - width - (collapsed ? 0 : 6) : (collapsed ? 0 : 6), p.y * viewport().height);
    };
    btn.addEventListener('pointerdown', e => {
        if (e.button > 0 || start || e.isPrimary === false) return;
        const rect = btn.getBoundingClientRect();
        start = { id: e.pointerId, x: e.clientX, y: e.clientY,
            left: rect.left, top: rect.top, side,
            // A thumb drifts several px during a plain tap; 6px turned many taps into tiny drags that did nothing.
            // 10px is just above Android's own touch slop (8dp).
            slop: e.pointerType === 'mouse' ? 6 : 10 };
        // Freeze the visible location, including a snap animation still in flight.
        btn.classList.add('is-dragging');
        btn.style.left = `${rect.left}px`;
        btn.style.top = `${rect.top}px`;
        moved = false;
        suppressClick = false;
        foldSide = null;
        btn.setPointerCapture?.(e.pointerId);
    });
    btn.addEventListener('pointermove', e => {
        if (!start || e.pointerId !== start.id) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) < start.slop) return;
        moved = true;
        btn.classList.add('is-dragging');
        if (collapsed && (start.side === 0 ? dx > 12 : dx < -12)) {
            present(false, start.side);
            start.left = start.side ? viewport().width - width - 6 : 6;
        }
        const rawLeft = start.left + dx;
        // Use the unclamped position: merely snapping to an edge must not hide the key.
        foldSide = collapsed ? start.side : rawLeft <= -12 ? 0 : rawLeft + width >= viewport().width + 12 ? 1 : null;
        place(collapsed ? (side ? viewport().width - width : 0) : rawLeft, start.top + dy);
        btn.classList.toggle('is-collapse-ready', !collapsed && foldSide !== null);
        if (!collapsed) btn.title = foldSide !== null ? '松开后收起到屏幕边缘' : '拖到边缘后继续向外拖，可收起按钮';
    });
    const end = (e, cancel = false) => {
        if (!start || e.pointerId !== start.id) return;
        const pointerId = start.id;
        start = null;
        btn.classList.remove('is-dragging', 'is-collapse-ready');
        suppressClick = cancel || moved;
        if (!cancel && moved) {
            const left = parseFloat(btn.style.left);
            setPos({ x: foldSide ?? (left + width / 2 < viewport().width / 2 ? 0 : 1),
                y: parseFloat(btn.style.top) / viewport().height, collapsed: foldSide !== null });
        }
        if (btn.hasPointerCapture?.(pointerId)) btn.releasePointerCapture(pointerId);
        restore();
    };
    // Some phone WebViews (zoomed pages, pointer capture quirks, an overlay appearing mid-tap) never deliver
    // the `click` after a touch tap, so the key looked dead. A clean tap is handled on pointerup; the click
    // that may still follow is then ignored.
    let tappedAt = 0;
    const activate = () => {
        const p = position();
        if (p.collapsed) { setPos({ ...p, collapsed: false }); restore(); }
        else onTap();
    };
    btn.addEventListener('pointerup', e => {
        const tap = start && e.pointerId === start.id && !moved && e.pointerType !== 'mouse';
        end(e);
        if (!tap) return;
        tappedAt = Date.now();
        suppressClick = true;
        activate();
    });
    // After a touch, Android sends mousedown / mouseup / click ~300ms later at the same spot. The panel
    // has opened there by then, so that click hit its backdrop (closing it again: a quick flash) or a
    // button inside it. Cancelling touchend stops the browser from sending them at all.
    btn.addEventListener('touchend', e => {
        if (Date.now() - tappedAt < 100 && e.cancelable) e.preventDefault();
    }, { passive: false });
    btn.addEventListener('pointercancel', e => end(e, true));
    btn.addEventListener('lostpointercapture', e => end(e, true));
    btn.addEventListener('click', e => {
        // Keyboard clicks (detail=0) remain usable even if a prior drag produced no click.
        if (suppressClick && e.detail !== 0) { suppressClick = false; return; }
        suppressClick = false;
        // Already handled on pointerup.
        if (e.detail !== 0 && Date.now() - tappedAt < 800) return;
        activate();
    });
    window.addEventListener('resize', restore);
    // Back from the background: lay it out again from the real screen size.
    document.addEventListener?.('visibilitychange', () => document.visibilityState === 'visible' && setTimeout(restore, 50));
    window.addEventListener?.('pageshow', restore);
    globalThis.visualViewport?.addEventListener?.('resize', restore);

    document.body.append(btn);
    restore();
    return { button: btn, refresh: restore };
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
