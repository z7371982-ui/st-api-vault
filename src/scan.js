// Scans other extensions' saved settings for URL + key pairs they already store,
// and reads / writes those locations so vault edits can flow back into the extensions.
import { classifyDescriptor, KIND, tokenize } from './detect.js';
import { MODULE, guessName, hashKey, normalizeUrl } from './vault.js';

const isPlain = v => v && typeof v === 'object' && !Array.isArray(v);
const looksUrl = v => /^https?:\/\/\S+$/i.test(v.trim());
const looksKey = v => v.trim().length >= 8 && !/\s/.test(v.trim()) && !looksUrl(v);

// Props that hold a human name for a channel / API entry, e.g. { name: '主力中转', url, key }.
const NAME_TOKENS = new Set(['name', 'label', 'title', 'alias', 'remark', 'remarks', 'nickname', 'nick', 'note', 'display']);
const NOT_NAME_TOKENS = new Set(['model', 'prompt', 'template', 'file', 'user', 'char', 'character', 'avatar', 'preset', 'voice', 'key', 'url']);
const EXACT_NAME = /^(name|label|title|alias|remark|displayName|display_name|channelName|channel_name|nickname)$/i;

/** Best name prop in one settings object, preferring exact ones like "name" over "xxx_label". */
export function pickNameProp(node) {
    const hits = [];
    for (const [prop, value] of Object.entries(node)) {
        if (typeof value !== 'string') continue;
        const v = value.trim();
        if (!v || v.length > 60 || looksUrl(v) || /^(sk|ak|pk)-/i.test(v)) continue;
        const tokens = tokenize(prop);
        if (!tokens.some(t => NAME_TOKENS.has(t)) || tokens.some(t => NOT_NAME_TOKENS.has(t))) continue;
        hits.push({ prop, value: v, exact: EXACT_NAME.test(prop) });
    }
    hits.sort((a, b) => b.exact - a.exact);
    return hits[0] || null;
}

/**
 * @param {object} settings SillyTavern extension_settings
 * @returns {{source:string, url:string, key:string, name:string, label:string,
 *   refs:{segs:string[], keyProp:string, urlProp:string, nameProp:string, nameSeen:string, source:string, hash:string}[]}[]}
 *   One entry per distinct key + address; `refs` lists every place that pair is stored.
 */
export function scanExtensionSettings(settings, { maxDepth = 6 } = {}) {
    const out = [];
    const seen = new WeakSet();

    const visit = (node, segs, depth) => {
        if (!node || typeof node !== 'object' || seen.has(node) || depth > maxDepth) return;
        seen.add(node);
        if (Array.isArray(node)) {
            node.forEach((v, i) => visit(v, [...segs, String(i)], depth + 1));
            return;
        }
        const urls = [];
        const keys = [];
        for (const [prop, value] of Object.entries(node)) {
            if (typeof value === 'string' && value.trim()) {
                const kind = classifyDescriptor({ id: prop, value });
                if (kind === KIND.URL && looksUrl(value)) urls.push({ prop, value: value.trim() });
                else if (kind === KIND.KEY && looksKey(value)) keys.push({ prop, value: value.trim() });
            } else if (typeof value === 'object') {
                visit(value, [...segs, prop], depth + 1);
            }
        }
        if (!keys.length) return;
        const source = segs[0];
        const named = pickNameProp(node);
        for (const k of keys) {
            const url = urls[0]?.value || '';
            out.push({
                source,
                url,
                key: k.value,
                label: named?.value || '',
                name: named?.value || guessName(url, source),
                ref: { segs, keyProp: k.prop, urlProp: urls[0]?.prop || '', nameProp: named?.prop || '', nameSeen: named?.value || '' },
            });
        }
    };

    if (isPlain(settings)) {
        for (const [ext, value] of Object.entries(settings)) {
            if (ext === MODULE) continue;
            visit(value, [ext], 1);
        }
        // Top-level Extras API pair lives directly on extension_settings.
        const { apiUrl, apiKey } = settings;
        if (typeof apiKey === 'string' && looksKey(apiKey)) {
            out.push({
                source: 'Extras',
                url: typeof apiUrl === 'string' ? apiUrl : '',
                key: apiKey.trim(),
                label: '',
                name: 'Extras API',
                ref: { segs: [], keyProp: 'apiKey', urlProp: 'apiUrl', nameProp: '', nameSeen: '' },
            });
        }
    }

    // The same key on two different relays is two configs; only the exact same pair is merged.
    // A copy of the key stored without any address joins the first entry that has that key.
    const unique = new Map();
    const add = (id, c, ref) => {
        const entry = unique.get(id) || { ...c, refs: [] };
        if (!entry.label && c.label) Object.assign(entry, { label: c.label, name: c.name });
        entry.refs.push({ ...ref, source: c.source, hash: hashKey(c.key) });
        unique.set(id, entry);
    };
    const pairId = c => `${c.key}\n${normalizeUrl(c.url).toLowerCase()}`;
    for (const { ref, ...c } of out) if (c.url) add(pairId(c), c, ref);
    for (const { ref, ...c } of out) {
        if (c.url) continue;
        const withUrl = [...unique.keys()].find(id => id.startsWith(`${c.key}\n`));
        add(withUrl || pairId(c), c, ref);
    }
    return [...unique.values()];
}

function parentAt(root, segs) {
    let node = root;
    for (const s of segs) {
        if (!node || typeof node !== 'object') return null;
        node = node[s];
    }
    return node && typeof node === 'object' ? node : null;
}

/** Value stored at extension_settings[...segs][prop], or undefined if the path is gone. */
export function readAt(root, segs, prop) {
    return parentAt(root, segs)?.[prop];
}

/** Writes only into an existing object; never creates paths in another extension's settings. */
export function writeAt(root, segs, prop, value) {
    const parent = parentAt(root, segs);
    if (!parent || !(prop in parent)) return false;
    parent[prop] = value;
    return true;
}
