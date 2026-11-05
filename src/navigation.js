// Record only user-operated, safe UI navigation. No field values enter these recipes.
import { closestComposed, defaultVisible, shadowRootOf } from './detect.js';

const CONTROL = 'button, [role="button"], [role="tab"], [tabindex="0"], .menu_button, .list-group-item, summary, .drawer-toggle, .inline-drawer-toggle, .inline-drawer-header, a';
const BAD = /(?:delete|remove|save|submit|send|reset|clear|disconnect|logout|close|cancel|withdraw|purchase|confirm|apply|connect|test|generate|import|export|download|upload|revoke|复制|删除|移除|保存|提交|发送|重置|清空|断开|退出|关闭|取消|购买|确认|应用|连接|测试|生成|导入|导出|下载|上传|撤销)/i;
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const label = el => clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.querySelector('[title]')?.getAttribute('title')).slice(0, 100);
const up = el => el?.parentElement || shadowRootOf(el)?.host;
let recent = [], initialized = false, replaying = false;
const observed = new WeakSet();

function safe(el) {
    if (!el?.matches(CONTROL) || el.disabled || closestComposed(el, '.avm-root')) return false;
    if (el.matches('input, textarea, select, [contenteditable]')) return false;
    if (el.querySelector('input, textarea, select, [contenteditable]')) return false;
    if (el.matches('button') && el.type === 'submit' && el.form) return false;
    if (BAD.test(`${el.id} ${el.getAttribute('name') || ''} ${label(el)}`)) return false;
    if (/(?:\b(?:sk|ak|pk|gsk)-[\w-]{6,}|https?:\/\/)/i.test(label(el))) return false;
    if (el.matches('a')) {
        const href = el.getAttribute('href');
        if (href && href !== '#' && !href.startsWith('#')) return false;
        if (el.target || el.hasAttribute('download')) return false;
    }
    return true;
}

// Every selector is unique in its own root. Shadow hosts use the same rule recursively.
function address(el) {
    if (!el?.isConnected) return null;
    const root = el.getRootNode();
    let selector = '';
    const unique = s => { try { return root.querySelectorAll(s).length === 1; } catch { return false; } };
    if (el.id && !/\d{5,}|[0-9a-f]{12,}/i.test(el.id)) {
        const s = `#${CSS.escape(el.id)}`;
        if (unique(s)) selector = s;
    }
    for (const attr of ['data-testid', 'data-action', 'aria-controls', 'aria-label', 'title', 'name']) {
        if (selector) break;
        const value = el.getAttribute(attr);
        if (!value || value.length > 100 || /(?:sk-|https?:\/\/)/i.test(value)) continue;
        const s = `${el.localName}[${attr}="${CSS.escape(value)}"]`;
        if (unique(s)) selector = s;
    }
    if (!selector) {
        const classes = [...el.classList].filter(c => !/active|selected|open|closed|hidden|focus|hover|\d{4,}/i.test(c)).slice(0, 3);
        const s = el.localName + classes.map(c => `.${CSS.escape(c)}`).join('');
        if (unique(s)) selector = s;
        if (!selector) {
            for (let n = el.parentElement; n; n = n.parentElement) {
                if (!n.id || /\d{5,}|[0-9a-f]{12,}/i.test(n.id)) continue;
                const scoped = `#${CSS.escape(n.id)} ${s}`;
                if (unique(scoped)) { selector = scoped; break; }
            }
        }
        if (!selector && safe(el) && label(el)) {
            const text = label(el);
            if ([...root.querySelectorAll(s)].filter(node => label(node) === text).length === 1) selector = { selector: s, text };
        }
    }
    if (!selector) return null;
    if (root.host) {
        const host = address(root.host);
        return host ? [...host, selector] : null;
    }
    return [selector];
}

function resolve(path) {
    if (!Array.isArray(path) || !path.length || path.length > 8) return null;
    let root = document, el;
    try {
        for (let i = 0; i < path.length; i++) {
            const part = path[i], css = typeof part === 'string' ? part : part?.selector;
            let hits = root && typeof css === 'string' ? [...root.querySelectorAll(css)] : [];
            if (typeof part !== 'string') hits = hits.filter(node => typeof part?.text === 'string' && label(node) === part.text);
            if (hits?.length !== 1) return null;
            el = hits[0];
            root = el.shadowRoot;
        }
    } catch { return null; }
    return el;
}

const contains = (ancestor, el) => {
    for (let n = el; n; n = up(n)) if (n === ancestor) return true;
    return false;
};

function effect(record, node) {
    if (record.effects.length >= 12 || !(node instanceof Element) || closestComposed(node, '.avm-root')) return;
    // An added shadow child may have no address, but its stable host does.
    let target = node;
    while (target && !address(target) && target !== document.body) target = up(target);
    if (!target || target === document.body || target === document.documentElement) return;
    if (!record.effects.some(item => item.node === target)) record.effects.push({ node: target, path: address(target) });
}

function observe(root) {
    if (observed.has(root)) return;
    observed.add(root);
    for (const node of root.querySelectorAll('*')) if (node.shadowRoot) observe(node.shadowRoot);
    new MutationObserver(mutations => {
        if (replaying) return;
        const record = recent.at(-1);
        if (!record || Date.now() - record.at > 2500) return;
        for (const mutation of mutations) {
            if (mutation.type === 'childList') for (const node of mutation.addedNodes) {
                if (node instanceof Element) {
                    if (node.shadowRoot) observe(node.shadowRoot);
                    for (const child of node.querySelectorAll('*')) if (child.shadowRoot) observe(child.shadowRoot);
                }
                effect(record, node);
            }
            else if (defaultVisible(mutation.target)) effect(record, mutation.target);
        }
    }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'open', 'style', 'class', 'aria-selected', 'aria-expanded'] });
}

export function initNavigation() {
    if (initialized) return;
    initialized = true;
    observe(document);
    document.addEventListener('click', event => {
        const path = event.composedPath();
        for (const el of path) if (el instanceof Element && el.shadowRoot) observe(el.shadowRoot);
        if (replaying || !event.isTrusted || path.some(el => el instanceof Element && el.matches('.avm-root'))) return;
        const control = path.find(el => el instanceof Element && el.matches(CONTROL));
        if (!safe(control)) return;
        const pathToControl = address(control);
        if (!pathToControl) return;
        recent = recent.filter(item => Date.now() - item.at < 120000).slice(-7);
        const record = { at: Date.now(), node: control, control: pathToControl, label: label(control), effects: [] };
        const controlled = control.getAttribute('aria-controls');
        if (controlled) for (const id of controlled.split(/\s+/)) {
            const el = control.getRootNode().getElementById(id);
            if (el) effect(record, el);
        }
        recent.push(record);
    }, true);
}

export function captureNavigation(el, previous = null) {
    let destination = el;
    const route = [];
    // Work backwards through causal DOM regions: field <- channel <- settings <- launcher.
    for (let i = recent.length - 1; i >= 0; i--) {
        const record = recent[i];
        const selectedTab = record.node.matches('[role="tab"][aria-selected="true"]');
        const tabScope = selectedTab && (closestComposed(record.node, 'dialog, [role="dialog"], .popup, .inline-drawer') || shadowRootOf(record.node)?.host);
        const relevantTab = tabScope && contains(tabScope, destination);
        if (Date.now() - record.at > 120000 || (!relevantTab && !record.effects.some(item => contains(item.node, destination)))) continue;
        route.unshift({ control: record.control, label: record.label,
            effects: record.effects.filter(item => item.path).map(item => item.path) });
        destination = record.node;
    }
    // A click inside an already-open plugin is only a suffix; retain the proven launcher.
    if (previous?.version === 1 && route.length) {
        const first = previous.steps.findIndex(step => JSON.stringify(step.control) === JSON.stringify(route[0].control));
        if (first >= 0) route.unshift(...previous.steps.slice(0, first));
        else return previous;
    }
    return route.length ? { version: 1, steps: route.slice(-8) } : previous;
}

function openAncestors(el) {
    const ancestors = [];
    for (let n = up(el); n; n = up(n)) ancestors.unshift(n);
    for (const n of ancestors) {
        if (n.matches('details') && !n.open) n.open = true;
        if (n.matches('.inline-drawer-content') && !defaultVisible(n)) {
            const toggle = n.parentElement?.querySelector(':scope > .inline-drawer-toggle, :scope > .inline-drawer-header');
            if (safe(toggle)) toggle.click();
        }
        if (!defaultVisible(n) && n.id) {
            const selectors = `[role="tab"][aria-controls="${CSS.escape(n.id)}"]`;
            const tabs = n.getRootNode().querySelectorAll(selectors);
            if (tabs.length === 1 && safe(tabs[0]) && tabs[0].getAttribute('aria-selected') !== 'true') tabs[0].click();
        }
    }
}

async function waitFor(check, milliseconds) {
    const until = Date.now() + milliseconds;
    do {
        const result = check();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 40));
    } while (Date.now() < until);
    return null;
}

/** Finder must reject ambiguous identities and mismatched credentials/channel context. */
export async function navigateToBinding(binding, finder, structuralFinder = finder) {
    if (replaying) return null;
    replaying = true;
    try {
        const mounted = structuralFinder();
        if (mounted) openAncestors(mounted);
        let found = finder();
        if (found) { openAncestors(found); if (defaultVisible(found)) return found; }
        const steps = binding.navigation?.version === 1 ? binding.navigation.steps : [];
        if (!Array.isArray(steps) || steps.length > 8) return null;
        for (let i = 0; i < steps.length; i++) {
            found = finder();
            if (found && defaultVisible(found)) return found;
            const step = steps[i];
            // A visible next control proves this screen is already open; do not toggle its opener.
            const next = steps[i + 1] && resolve(steps[i + 1].control);
            if (next && defaultVisible(next)) continue;
            const control = await waitFor(() => {
                const el = resolve(step.control);
                return el && safe(el) && defaultVisible(el) && label(el) === step.label ? el : null;
            }, 900);
            if (!control) return null;
            if (control.getAttribute('aria-expanded') !== 'true' && control.getAttribute('aria-selected') !== 'true'
                && !(control.matches('summary') && control.parentElement.open)) control.click();
            await waitFor(() => {
                const candidate = finder();
                if (candidate && defaultVisible(candidate)) return candidate;
                const nextControl = steps[i + 1] && resolve(steps[i + 1].control);
                return nextControl && defaultVisible(nextControl);
            }, 1200);
        }
        found = finder();
        if (found) openAncestors(found);
        return await waitFor(() => { const el = finder(); return el && defaultVisible(el) ? el : null; }, 400);
    } finally { replaying = false; }
}
