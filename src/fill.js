// Focus-driven filling. The credential field the user last clicked into is the target,
// so no plugin has to integrate with the vault: focus its URL or key box, pick a profile, done.
import { store } from './store.js';
import {
    KIND, classifyElement, findPartner, findModelField, fingerprint, scopeTitle, fieldLabel, setFieldValue, defaultVisible,
    eventTarget, deepActiveElement, shadowRootOf, closestComposed,
} from './detect.js';
import { resolveKey, syncToST } from './sync.js';
// Phones get a bottom sheet instead of a dropdown, and no refocusing that would pop the keyboard back up.
import { isCompact, isTouch, swipeToClose } from './sheet.js';
import { esc, maskKey, hostOf, colorFor, initials, searchProfiles, sortProfiles, findProfileByKey, guessName } from './vault.js';

const TITLE = 'API 管理器';
// ST's own key inputs offer saved secret ids (UUIDs) in a datalist; those are not keys.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ST's own reverse proxy URL / password inputs. They mirror the selected proxy preset.
const ST_PROXY_FIELDS = new Set(['openai_reverse_proxy', 'openai_proxy_access_key']);
export const KIND_LABEL = { [KIND.KEY]: '密钥', [KIND.URL]: '地址' };
const other = kind => (kind === KIND.KEY ? KIND.URL : KIND.KEY);

let target = null; // { el, kind }
let pill = null;
let pillShown = false;
let pop = null;
let popIndex = 0;
let filling = false;
let frame = 0;
let backdrop = null;
// Time of the last press on the pill. On touch screens the tap can blur the field before `click`
// arrives, and the pill must survive that blur.
let pressAt = 0;
let rescueTimer = 0;
let rescued = false;
let openPanel = () => {};
const listeners = new Set();
const prompted = new Set();

export function onTargetChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emit() {
    const t = currentTarget();
    for (const fn of listeners) fn(t);
}

/** The field the vault would fill right now, or null once it went away (drawer closed, popup gone). */
export function currentTarget() {
    if (!target?.el.isConnected || !defaultVisible(target.el)) return null;
    const { el, kind } = target;
    return { el, kind, scope: scopeTitle(el), label: fieldLabel(el), binding: store.binding(fingerprint(el)) };
}

export function canFill(p, kind) {
    return kind === KIND.URL ? !!p.url : !!(p.key || p.stRef);
}

function readPair(el, kind) {
    const partner = findPartner(el, other(kind));
    const val = f => String(f?.value || '').trim();
    return kind === KIND.KEY ? { key: val(el), url: val(partner), partner } : { url: val(el), key: val(partner), partner };
}

// Animated inline: the page stylesheet does not reach fields inside another extension's shadow root.
function flash(el) {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeQuoteColor').trim() || 'rgb(139, 156, 255)';
    el.animate?.(
        [{ boxShadow: `0 0 0 3px ${accent}` }, { boxShadow: '0 0 0 3px transparent' }],
        { duration: 1000, easing: 'ease-out' },
    );
}

function bindingEntry(el, kind, profileId) {
    return [fingerprint(el), { profileId, kind, scope: scopeTitle(el), label: fieldLabel(el) }];
}

/**
 * Fills `el` and its partner field (URL <-> key) from a profile and remembers the binding.
 * @param {object} [opts]
 * @param {boolean} [opts.quiet] no toasts (used for auto-fill)
 * @param {boolean} [opts.keepFilled] leave fields that already have a value alone
 */
export async function fillProfile(profile, el = target?.el, { quiet = false, keepFilled = false } = {}) {
    if (!el?.isConnected) {
        if (!quiet) toastr.warning('先点一下插件里的 API 地址或密钥输入框', TITLE);
        return false;
    }
    // Writing ST's reverse proxy fields directly leaves the preset dropdown on one relay while the URL and
    // password belong to another, and ST later reloads the preset over them. Switch the preset instead.
    // Never done silently (auto-fill): ST's connection only changes on an explicit pick.
    if (ST_PROXY_FIELDS.has(el.id)) {
        if (quiet) return false;
        try {
            const what = await syncToST(profile);
            toastr.success(`酒馆现在使用${esc(what)}`, TITLE, { timeOut: 1800 });
            emit();
            return true;
        } catch (err) {
            toastr.error(esc(err.message || String(err)), TITLE);
            return false;
        }
    }
    const kind = classifyElement(el) || target?.kind;
    if (!kind) return false;
    const key = await resolveKey(profile);
    const p = store.get(profile.id) || profile;
    const values = { [KIND.URL]: p.url, [KIND.KEY]: key };
    if (!values[kind]) {
        if (!quiet) {
            toastr.warning(kind === KIND.KEY
                ? '这个配置只有酒馆里的掩码，读不到密钥原文。可在 config.yaml 打开 allowKeysExposure，或在配置里补上密钥。'
                : '这个配置没有填写地址', TITLE);
        }
        return false;
    }

    const fields = [[el, kind]];
    const partner = findPartner(el, other(kind));
    if (partner && values[other(kind)]) fields.push([partner, other(kind)]);
    const todo = keepFilled ? fields.filter(([f]) => !f.value.trim()) : fields;
    // A free-text model box in the same block gets the profile's model, if it has one.
    const modelEl = p.model ? findModelField(el) : null;
    const fillModel = modelEl && (!keepFilled || !modelEl.value.trim()) && modelEl.value.trim() !== p.model;

    filling = true;
    try {
        for (const [f, k] of todo) {
            setFieldValue(f, values[k]);
            flash(f);
        }
        if (fillModel) {
            setFieldValue(modelEl, p.model);
            flash(modelEl);
        }
    } finally {
        filling = false;
    }

    store.bindMany(fields.map(([f, k]) => bindingEntry(f, k, p.id)));
    store.touch(p.id);
    if (!quiet) {
        const parts = todo.length > 1 ? '地址和密钥' : KIND_LABEL[todo[0]?.[1] ?? kind];
        const what = fillModel ? `${parts}、模型` : parts;
        toastr.success(`已填入「${esc(p.name)}」的${what}`, TITLE, { timeOut: 1800 });
    }
    emit();
    return true;
}

/** Saves whatever is currently typed into the target field (and its partner) as a profile. */
export function captureFrom(el = target?.el) {
    if (!el?.isConnected) return null;
    const kind = classifyElement(el) || target?.kind;
    const { url, key, partner } = readPair(el, kind);
    if (!key && !url) {
        toastr.warning('输入框还是空的', TITLE);
        return null;
    }
    const dup = key && findProfileByKey(store.profiles, key);
    if (dup) {
        toastr.info(`「${esc(dup.name)}」已经存过了`, TITLE);
        return dup;
    }
    const scope = scopeTitle(el);
    const p = store.upsert({ name: guessName(url, scope), url, key, tags: scope ? [scope] : [] });
    const entries = [bindingEntry(el, kind, p.id)];
    if (partner) entries.push(bindingEntry(partner, other(kind), p.id));
    store.bindMany(entries);
    toastr.success(`已保存为「${esc(p.name)}」并绑定这个输入框`, TITLE);
    emit();
    return p;
}

/** Scrolls the target into view and flashes it, for "which field is that?" moments. */
export function focusTarget() {
    const t = currentTarget();
    if (!t) return;
    t.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    t.el.focus({ preventScroll: true });
    flash(t.el);
}

// ---------- positioning ----------

/**
 * The floating plugin window `el` sits in: its nearest position:fixed ancestor. Null when there is none,
 * or when that window would clip our fixed nodes (it is their containing block and hides overflow).
 */
function floatingWindowOf(el) {
    // Walks up through shadow boundaries too: a Vue / Lit plugin's window usually lives in a shadow root.
    const up = n => n.parentElement || shadowRootOf(n)?.host || null;
    for (let n = up(el); n && n !== document.body && n !== document.documentElement; n = up(n)) {
        const cs = getComputedStyle(n);
        if (cs.position !== 'fixed') continue;
        return containsFixed(n) && cs.overflow !== 'visible' ? null : n;
    }
    return null;
}

/** Whether `n` is the containing block of position:fixed descendants (transform, filter, contain, ...). */
function containsFixed(n) {
    const cs = getComputedStyle(n);
    return cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none'
        || (cs.backdropFilter && cs.backdropFilter !== 'none') || (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none')
        || /transform|filter|perspective/.test(cs.willChange) || /paint|layout|strict|content/.test(cs.contain);
}

/**
 * Where the pill and picker are mounted for `el`.
 *   - Inside a modal <dialog> everything outside it is inert, so they go into the dialog.
 *   - Floating plugin windows close themselves on clicks outside them. Mounted inside the window,
 *     a tap on the key button or the picker counts as inside, so the window stays open.
 *     This works for windows inside a shadow root too; our stylesheet is linked in there (see mount).
 */
function hostFor(el) {
    return closestComposed(el, 'dialog[open]') || floatingWindowOf(el) || document.body;
}

function targetHost() {
    if (!target?.el) return document.body;
    if (!target.host?.isConnected) target.host = hostFor(target.el);
    return target.host;
}

// Page styles do not reach into a shadow root, so our stylesheet is linked into each one we mount in.
const STYLE_URL = new URL('../style.css', import.meta.url).href;
const styledRoots = new WeakSet();
function ensureStyles(host) {
    const root = shadowRootOf(host);
    if (!root || styledRoots.has(root)) return;
    styledRoots.add(root);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = STYLE_URL;
    link.className = 'avm-root';
    root.append(link);
}

/**
 * @param {{sheet?: boolean}} [opts] The phone bottom sheet and its backdrop are laid out by CSS against the
 *   screen; inside a transformed window they would be laid out against the window instead, so they stay on body.
 */
function mount(node, { sheet = false } = {}) {
    let host = targetHost();
    if (sheet && host !== document.body && host.tagName !== 'DIALOG' && containsFixed(host)) host = document.body;
    ensureStyles(host);
    if (node.parentNode !== host) host.append(node);
}

let originProbe = null;

/**
 * Where (0, 0) of a fixed element inside `host` really lands. A transformed ancestor (some popups
 * animate with transform) moves it. Measured with a separate invisible probe, so the node itself is
 * never touched: resetting its `animation` to measure it restarted the entry animation on every
 * re-placement, which showed up as the button flashing several times.
 */
function fixedOrigin(host) {
    if (!originProbe) {
        originProbe = document.createElement('div');
        originProbe.className = 'avm-root';
        originProbe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;animation:none;transition:none';
    }
    host.append(originProbe);
    const r = originProbe.getBoundingClientRect();
    originProbe.remove();
    return r;
}

function placeFixed(node, left, top) {
    const o = fixedOrigin(node.parentNode || document.body);
    const x = `${Math.round(left - o.left)}px`;
    const y = `${Math.round(top - o.top)}px`;
    if (node.style.left !== x) node.style.left = x;
    if (node.style.top !== y) node.style.top = y;
}

function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
        frame = 0;
        if (pillShown) updatePill();
        if (pop?.isConnected) placePop();
    });
}

// ---------- inline pill ----------

function ensurePill() {
    if (pill) return pill;
    pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'avm-root avm-pill';
    pill.title = isTouch() ? 'API 管理器' : 'API 管理器 · Alt+K';
    pill.setAttribute('aria-label', '从 API 管理器选择');
    // Keep focus in the field so the target does not change.
    pill.addEventListener('mousedown', e => e.preventDefault());
    pill.addEventListener('pointerdown', () => {
        pressAt = Date.now();
        rescued = false;
        // Some windows still close on the press (they listen before us). The pill goes with them and
        // `click` never arrives, so check shortly after: no field left means open the manager instead.
        clearTimeout(rescueTimer);
        rescueTimer = setTimeout(() => {
            if (currentTarget()) return;
            rescued = true;
            hidePill();
            openPanel();
        }, 350);
    });
    pill.addEventListener('click', () => {
        clearTimeout(rescueTimer);
        if (rescued) return;
        // Same case as above, when the window closed between press and release.
        if (!currentTarget()) {
            hidePill();
            openPanel();
            return;
        }
        togglePop();
    });
    return pill;
}

/**
 * Field the pill and picker sit next to. A pick fills the URL and key together, so for a pair
 * the button lives on the URL field (the top of the group), whichever of the two was clicked.
 */
function anchorEl() {
    const a = target?.anchor;
    return a?.isConnected && defaultVisible(a) ? a : target?.el;
}

function updatePill() {
    const t = currentTarget();
    if (!t || !store.options.pill) {
        pill?.remove();
        return;
    }
    const rect = anchorEl().getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight || rect.width < 40) {
        // Hide in place rather than remove: while a plugin popup animates in, the field is briefly
        // tiny or off screen, and removing + re-adding replayed the entry animation (visible flashing).
        if (pill) pill.style.visibility = 'hidden';
        return;
    }
    const node = ensurePill();
    const fresh = !node.isConnected;
    if (node.style.visibility) node.style.visibility = '';
    const bound = t.binding && store.get(t.binding.profileId);
    node.classList.toggle('is-bound', !!bound);
    node.classList.toggle('is-open', !!pop?.isConnected);
    // Only rewrite when it changed; re-placing runs several times while a popup settles.
    const html = `<i class="fa-solid fa-key"></i>${bound ? `<span>${esc(bound.name)}</span>` : ''}`;
    if (node.innerHTML !== html) node.innerHTML = html;
    mount(node);
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const inside = rect.width >= w + 120;
    const left = inside ? rect.right - w - 6 : rect.right + 6;
    // Center on the field; for a tall textarea, on its first line instead of the middle.
    const anchor = anchorEl();
    const band = anchor.tagName === 'TEXTAREA' ? Math.min(rect.height, 44) : rect.height;
    const top = rect.top + (band - h) / 2;
    placeFixed(node, left, top);
    // Entry animation only when the button actually appears, never on a re-placement.
    if (fresh && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        node.animate?.([{ opacity: 0, transform: 'scale(0.85)' }, { opacity: 1, transform: 'none' }], { duration: 140, easing: 'ease-out' });
    }
}

let settleTimers = [];

function showPill() {
    pillShown = true;
    updatePill();
    // Plugin popups often animate in (scale / slide). Re-place a few times while that settles,
    // instead of waiting for the next scroll or resize to correct the position.
    settleTimers.forEach(clearTimeout);
    settleTimers = [80, 200, 400].map(ms => setTimeout(() => pillShown && updatePill(), ms));
}

function hidePill() {
    pillShown = false;
    pill?.remove();
}

// ---------- quick picker ----------

function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'avm-root avm-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', '选择 API 配置');
    pop.innerHTML = `
        <div class="avm-pop-head">
            <div class="avm-grabber" aria-hidden="true"></div>
            <div class="avm-pop-titlebar">
                <div class="avm-pop-title"></div>
                <button type="button" class="avm-icon-btn avm-sheet-only" data-act="close" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <label class="avm-search">
                <i class="fa-solid fa-magnifying-glass"></i>
                <input type="text" placeholder="搜索名称、地址、标签" autocomplete="off" spellcheck="false" aria-label="搜索配置">
            </label>
        </div>
        <div class="avm-pop-list" role="listbox"></div>
        <div class="avm-pop-foot">
            <button type="button" data-act="capture"><i class="fa-solid fa-floppy-disk"></i>保存当前填写</button>
            <button type="button" data-act="panel"><i class="fa-solid fa-table-cells-large"></i>打开管理器</button>
        </div>`;
    const input = pop.querySelector('input');
    input.addEventListener('input', () => {
        popIndex = 0;
        renderPopList();
    });
    input.addEventListener('keydown', onPopKey);
    pop.addEventListener('mousedown', e => {
        if (e.target !== input) e.preventDefault();
    });
    pop.addEventListener('click', e => {
        const row = e.target.closest('.avm-row');
        if (row && !row.classList.contains('is-disabled')) return pick(row.dataset.id);
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'capture') {
            const el = target?.el;
            closePop(true);
            captureFrom(el);
        } else if (act === 'close') {
            closePop(true);
        } else if (act === 'panel') {
            closePop(false);
            openPanel();
        }
    });
    swipeToClose(pop.querySelector('.avm-pop-head'), pop, () => closePop(false));
    return pop;
}

function popRows() {
    const t = currentTarget();
    const q = pop.querySelector('input').value;
    const boundId = t?.binding?.profileId;
    const list = sortProfiles(searchProfiles(store.profiles, q))
        .sort((a, b) => (b.id === boundId) - (a.id === boundId));
    const usable = list.filter(p => canFill(p, t.kind));
    const unusable = list.filter(p => !canFill(p, t.kind));
    return { t, usable, unusable, boundId };
}

function renderPopList() {
    const t = currentTarget();
    if (!t || !pop) return closePop(false);
    const { usable, unusable, boundId } = popRows();
    pop.querySelector('.avm-pop-title').innerHTML =
        `<span class="avm-chip">${KIND_LABEL[t.kind]}</span><span class="avm-pop-scope">${esc(t.scope || t.label || '当前输入框')}</span>`;

    const row = (p, i, disabled) => {
        const sub = `${hostOf(p.url) || '无地址'} · ${maskKey(p.key) || p.keyHint || '无密钥'}`;
        return `<div class="avm-row${disabled ? ' is-disabled' : ''}${i === popIndex && !disabled ? ' is-active' : ''}" data-id="${esc(p.id)}" role="option" aria-selected="${i === popIndex && !disabled}">
            <span class="avm-avatar" style="--c:${colorFor(p.name)}">${esc(initials(p.name))}</span>
            <span class="avm-row-text"><span class="avm-row-name">${esc(p.name)}</span><span class="avm-row-sub">${esc(sub)}</span></span>
            ${p.id === boundId ? '<span class="avm-badge is-accent">已绑定</span>' : ''}
        </div>`;
    };

    const listEl = pop.querySelector('.avm-pop-list');
    if (!store.profiles.length) {
        listEl.innerHTML = '<div class="avm-pop-empty">还没有配置。在这里填好后点「保存当前填写」，或去管理器新建 / 导入。</div>';
    } else if (!usable.length && !unusable.length) {
        listEl.innerHTML = '<div class="avm-pop-empty">没有匹配的配置</div>';
    } else {
        listEl.innerHTML = usable.map((p, i) => row(p, i, false)).join('') + unusable.map(p => row(p, -1, true)).join('');
    }
    listEl.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
}

function placePop() {
    const t = currentTarget();
    if (!t) return closePop(false);
    // The bottom sheet is placed by CSS.
    if (pop.classList.contains('is-sheet')) return;
    const rect = anchorEl().getBoundingClientRect();
    const width = Math.min(340, innerWidth - 16);
    pop.style.width = `${width}px`;
    const left = Math.max(8, Math.min(rect.left, innerWidth - width - 8));
    const h = pop.offsetHeight;
    const below = innerHeight - rect.bottom - 8 >= h || rect.top < innerHeight / 2;
    const top = below ? Math.min(rect.bottom + 6, innerHeight - h - 8) : Math.max(8, rect.top - h - 6);
    placeFixed(pop, left, top);
}

function openPop() {
    const t = currentTarget();
    if (!t) return;
    ensurePop();
    const sheet = isCompact();
    pop.classList.toggle('is-sheet', sheet);
    pop.removeAttribute('style');
    if (sheet) {
        if (!backdrop) {
            backdrop = Object.assign(document.createElement('div'), { className: 'avm-root avm-backdrop' });
            // Close on click, not on pointerdown, so the tap does not land on the page underneath.
            backdrop.addEventListener('click', () => closePop(false));
        }
        mount(backdrop, { sheet });
    }
    mount(pop, { sheet });
    popIndex = 0;
    const input = pop.querySelector('input');
    input.value = '';
    renderPopList();
    placePop();
    if (sheet) {
        // Drop the keyboard so the whole list is visible; the field stays the fill target.
        // Searching is one tap away in the sheet.
        t.el.blur();
    } else {
        input.focus({ preventScroll: true });
    }
    updatePill();
}

function closePop(refocus = false) {
    if (!pop?.isConnected) return;
    pop.remove();
    backdrop?.remove();
    pill?.classList.remove('is-open');
    if (refocus && !isCompact() && target?.el.isConnected) target.el.focus({ preventScroll: true });
}

function togglePop() {
    if (pop?.isConnected) closePop(true);
    else openPop();
}

async function pick(id) {
    const p = store.get(id);
    const el = target?.el;
    closePop(false);
    if (p && el) {
        await fillProfile(p, el);
        if (!isCompact()) el.focus({ preventScroll: true });
    }
}

function onPopKey(e) {
    const { usable } = popRows();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!usable.length) return;
        popIndex = (popIndex + (e.key === 'ArrowDown' ? 1 : -1) + usable.length) % usable.length;
        renderPopList();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (usable[popIndex]) pick(usable[popIndex].id);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePop(true);
    }
}

// ---------- page listeners ----------

// Shadow roots need their own listeners:
//   - `change` is not composed, so it never leaves the shadow root.
//   - focus moving between two inputs of the same shadow root retargets to host -> host, and the browser
//     does not deliver that to `document` at all. Without these, the key button only showed up once focus
//     came from outside the plugin's window.
// Roots are picked up on the first pointerdown / focus inside them, which do reach `document`.
const watchedRoots = new WeakSet();
function watchShadowRoot(el) {
    for (let root = shadowRootOf(el); root; root = shadowRootOf(root.host)) {
        if (watchedRoots.has(root)) continue;
        watchedRoots.add(root);
        root.addEventListener('change', onChange, true);
        root.addEventListener('focusin', onFocusIn, true);
        root.addEventListener('focusout', onFocusOut, true);
    }
}

// The same event can reach both a shadow root listener and the document listener; handle it once.
const seenEvents = new WeakSet();
const firstTime = e => !seenEvents.has(e) && !!seenEvents.add(e);

function onFocusIn(e) {
    if (!firstTime(e)) return;
    // Inside a shadow root e.target is only the host; the real input is first in the composed path.
    const el = eventTarget(e);
    if (!(el instanceof Element) || el.closest('.avm-root')) return;
    watchShadowRoot(el);
    const kind = classifyElement(el);
    if (!kind) {
        hidePill();
        closePop(false);
        return;
    }
    if (target?.el !== el) closePop(false);
    const urlField = kind === KIND.KEY ? findPartner(el, KIND.URL) : null;
    target = { el, kind, anchor: urlField || el };
    showPill();
    emit();
    maybeAutoFill(el).catch(err => console.warn('[API Vault] auto-fill failed', err));
}

function onFocusOut(e) {
    if (e && !firstTime(e)) return;
    setTimeout(() => {
        const a = deepActiveElement();
        if (a === target?.el || a?.closest?.('.avm-root')) return;
        if (Date.now() - pressAt < 800 || pop?.isConnected) return;
        hidePill();
    }, 0);
}

async function maybeAutoFill(el) {
    if (!store.options.autoFillBound || el.value.trim()) return;
    const b = store.binding(fingerprint(el));
    const p = b && store.get(b.profileId);
    if (p) await fillProfile(p, el, { quiet: true, keepFilled: true });
}

/** Offers to save a key the user typed or pasted by hand somewhere. */
function onChange(e) {
    if (!firstTime(e) || filling || !store.options.capture) return;
    const el = eventTarget(e);
    if (!(el instanceof Element) || el.closest('.avm-root')) return;
    const kind = classifyElement(el);
    if (!kind) return;
    const { key, url } = readPair(el, kind);
    if (key.length < 8 || UUID.test(key) || /\s/.test(key) || prompted.has(key) || findProfileByKey(store.profiles, key)) return;
    prompted.add(key);
    const where = url ? `（${esc(hostOf(url) || url)}）` : '';
    toastr.info(`发现新的密钥${where}，点这里存进管理器`, TITLE, {
        timeOut: 7000,
        extendedTimeOut: 3000,
        onclick: () => captureFrom(el),
    });
}

function onPointerDown(e) {
    const t = eventTarget(e);
    // Start watching a plugin's shadow root before its input even gets focus.
    if (t instanceof Element) watchShadowRoot(t);
    if (!pop?.isConnected) return;
    if (t.closest?.('.avm-pop, .avm-pill, .avm-backdrop') || t === target?.el) return;
    closePop(false);
}

function onKeyDown(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.code !== 'KeyK') return;
    e.preventDefault();
    const inField = currentTarget() && (deepActiveElement() === target.el || pop?.isConnected);
    if (inField) togglePop();
    else openPanel();
}

export function initFill(opts = {}) {
    openPanel = opts.openPanel || openPanel;
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    // Phones: the on-screen keyboard moves the visual viewport without a window resize.
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    store.onChange(() => {
        if (pillShown) updatePill();
        if (pop?.isConnected) renderPopList();
    });
}
