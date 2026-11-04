// Field detection: decides whether an input is an API URL or an API key field,
// finds its partner field, and produces a stable fingerprint for bindings.

export const KIND = Object.freeze({ KEY: 'key', URL: 'url' });

const SKIP_TYPES = new Set([
    'hidden', 'checkbox', 'radio', 'number', 'range', 'file', 'submit', 'button', 'reset', 'color',
    'date', 'datetime-local', 'month', 'time', 'week', 'image', 'search', 'email', 'tel',
]);

const KEY_TOKENS = new Set(['key', 'apikey', 'token', 'secret', 'password', 'passwd', 'pwd', 'pass', 'bearer', 'authorization', 'credential', 'credentials']);
const URL_TOKENS = new Set(['url', 'uri', 'endpoint', 'host', 'baseurl', 'apiurl', 'apibase', 'proxy', 'server', 'domain', 'address', 'addr']);
// If an identifier contains these, it is something like "max_tokens" or "hotkey", not a credential.
const NEGATIVE_TOKENS = new Set(['max', 'min', 'limit', 'count', 'budget', 'length', 'size', 'num', 'search', 'filter', 'hotkey', 'keybind', 'keybinding', 'shortcut', 'name', 'label', 'title', 'prompt', 'template', 'avatar', 'icon', 'webhook']);

const KEY_ZH = /密钥|秘钥|令牌|口令|密码/;
const URL_ZH = /地址|网址|域名|接口|端点|反代|代理|链接/;
const KEY_SHAPE = /^(sk|ak|pk|rk|gsk|xai|cr)-[\w-]{6,}$|^AIza[\w-]{20,}$/;

const FIELD_SELECTOR = 'input, textarea';
const BOUNDARY_SELECTOR = '.inline-drawer-content, form, dialog, .popup, [role="dialog"]';
const RANDOMISH_ID = /\d{4,}|[0-9a-f]{8,}|^[a-z0-9]{16,}$/i;

export function tokenize(s) {
    return String(s || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/** Last matching token wins, so "proxy_password" is a key and "api_key_url" is a URL. */
function kindFromTokens(tokens) {
    let kind = null;
    for (const t of tokens) {
        if (KEY_TOKENS.has(t)) kind = KIND.KEY;
        else if (URL_TOKENS.has(t) || (t === 'base' && tokens.includes('api'))) kind = KIND.URL;
    }
    return kind;
}

function kindFromChinese(text) {
    if (KEY_ZH.test(text)) return KIND.KEY;
    if (URL_ZH.test(text)) return KIND.URL;
    return null;
}

/**
 * Classifies a plain description of a field. Kept DOM-free for testing.
 * @returns {'key'|'url'|null}
 */
export function classifyDescriptor(d = {}) {
    const tag = String(d.tag || 'input').toLowerCase();
    const type = String(d.type || 'text').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return null;
    if (tag === 'input' && SKIP_TYPES.has(type)) return null;
    if (d.disabled || d.readOnly) return null;
    if (tag === 'input' && type === 'password') return KIND.KEY;
    if (tag === 'input' && type === 'url') return KIND.URL;

    const primary = tokenize(`${d.id || ''} ${d.name || ''}`);
    if (primary.some(t => NEGATIVE_TOKENS.has(t))) return null;

    const secondaryText = [d.placeholder, d.ariaLabel, d.label, d.title].filter(Boolean).join(' ');
    const secondary = tokenize(secondaryText);

    let kind = kindFromTokens(primary);
    if (!kind && !secondary.some(t => NEGATIVE_TOKENS.has(t))) {
        kind = kindFromTokens(secondary) || kindFromChinese(secondaryText);
    }
    if (!kind) {
        const value = String(d.value || '').trim();
        const ph = String(d.placeholder || '').trim();
        if (/^https?:\/\/\S+$/i.test(value) || /^https?:\/\//i.test(ph)) kind = KIND.URL;
        else if (KEY_SHAPE.test(value) || /^sk-/i.test(ph)) kind = KIND.KEY;
    }
    // Textareas are mostly prompts; only accept them when they clearly hold keys.
    if (tag === 'textarea' && kind !== KIND.KEY) return null;
    return kind;
}

export function isFieldElement(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

function shortText(node) {
    if (!node || node.querySelector?.(FIELD_SELECTOR + ', select')) return '';
    if (!/^(LABEL|SPAN|SMALL|B|STRONG|H4|H5|H6|DIV|P)$/.test(node.tagName)) return '';
    const t = clean(node.textContent);
    return t.length <= 60 ? t : '';
}

/** Best-effort human label for a field: <label>, then a short preceding sibling. */
export function fieldLabel(el) {
    const own = clean(el.labels?.[0]?.textContent);
    if (own) return own.slice(0, 60);
    return shortText(el.previousElementSibling) || shortText(el.parentElement?.previousElementSibling) || '';
}

export function describeElement(el) {
    return {
        tag: el.tagName.toLowerCase(),
        type: el.tagName === 'INPUT' ? el.type : 'textarea',
        id: el.id,
        name: el.getAttribute('name'),
        placeholder: el.getAttribute('placeholder'),
        ariaLabel: el.getAttribute('aria-label'),
        title: el.getAttribute('title'),
        label: fieldLabel(el),
        value: el.value,
        disabled: el.disabled,
        readOnly: el.readOnly,
    };
}

export function classifyElement(el) {
    if (!isFieldElement(el)) return null;
    if (el.closest('.avm-root') || el.id === 'send_textarea') return null;
    return classifyDescriptor(describeElement(el));
}

export function defaultVisible(el) {
    if (!el.getClientRects().length) return false;
    return el.ownerDocument.defaultView.getComputedStyle(el).visibility !== 'hidden';
}

const MODEL_NEGATIVE = new Set(['list', 'filter', 'search', 'prefix', 'suffix', 'temperature', 'temp', 'max', 'min', 'count', 'prompt', 'template']);

/** A free-text model id field, e.g. id="custom_model_id" or placeholder="模型名称". Selects are left alone. */
export function isModelDescriptor(d = {}) {
    const tag = String(d.tag || 'input').toLowerCase();
    const type = String(d.type || 'text').toLowerCase();
    if (tag !== 'input' || !['text', ''].includes(type) || d.disabled || d.readOnly) return false;
    const primary = tokenize(`${d.id || ''} ${d.name || ''}`);
    if (primary.some(t => MODEL_NEGATIVE.has(t))) return false;
    if (primary.includes('model')) return true;
    const text = [d.placeholder, d.ariaLabel, d.label].filter(Boolean).join(' ');
    return !primary.length && (tokenize(text).includes('model') || /模型/.test(text));
}

export function isModelElement(el) {
    if (!isFieldElement(el) || el.closest('.avm-root')) return false;
    return isModelDescriptor(describeElement(el));
}

/** Nearest model field in the same block as `el`, so filling a profile can set its model too. */
export function findModelField(el, opts) {
    return findNearby(el, isModelElement, opts);
}

/**
 * Finds the field of the opposite kind that belongs with `el` (URL <-> key).
 * Walks up a few ancestors and stops at the first container that holds a match,
 * never crossing an extension drawer / form / popup boundary.
 */
export function findPartner(el, wantKind, opts) {
    return findNearby(el, c => classifyElement(c) === wantKind, opts);
}

function findNearby(el, predicate, { isVisible = defaultVisible, maxDepth = 5 } = {}) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < maxDepth; depth++, node = node.parentElement) {
        const all = [...node.querySelectorAll(FIELD_SELECTOR)];
        const self = all.indexOf(el);
        const matches = all.filter(c => c !== el && !c.disabled && predicate(c) && isVisible(c));
        if (matches.length) {
            // Nearest in document order; on a tie prefer the earlier one (URL usually precedes key).
            return matches.sort((a, b) => {
                const da = Math.abs(all.indexOf(a) - self);
                const db = Math.abs(all.indexOf(b) - self);
                return da - db || all.indexOf(a) - all.indexOf(b);
            })[0];
        }
        if (node.matches(BOUNDARY_SELECTOR)) break;
    }
    return null;
}

/** Stable identity for a field across page reloads, used as the binding key. */
export function fingerprint(el) {
    if (el.id && !RANDOMISH_ID.test(el.id)) return `#${el.id}`;
    let scope = el.parentElement;
    while (scope && (!scope.id || RANDOMISH_ID.test(scope.id))) scope = scope.parentElement;
    const root = scope || el.ownerDocument.body;
    const sig = el.getAttribute('name') || el.getAttribute('placeholder') || `#${[...root.querySelectorAll(FIELD_SELECTOR)].indexOf(el)}`;
    return `${scope ? `#${scope.id}` : 'body'} ${el.tagName.toLowerCase()}[${sig}]`;
}

/** Name of the extension / popup that owns the field, e.g. the drawer header text. */
export function scopeTitle(el) {
    const drawer = el.closest('.inline-drawer');
    let t = clean(drawer?.querySelector(':scope > .inline-drawer-header, :scope > .inline-drawer-toggle')?.textContent);
    if (!t) t = clean(el.closest('.popup, dialog, [role="dialog"]')?.querySelector('h1, h2, h3, h4')?.textContent);
    if (!t) t = el.parentElement?.closest('[id]')?.id || '';
    return t.slice(0, 48);
}

/** Sets a value the way a user would, so jQuery, React and plain listeners all notice. */
export function setFieldValue(el, value) {
    const view = el.ownerDocument.defaultView;
    const proto = el.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new view.Event('input', { bubbles: true }));
    el.dispatchEvent(new view.Event('change', { bubbles: true }));
}
