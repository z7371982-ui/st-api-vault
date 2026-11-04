// Scans other extensions' saved settings for URL + key pairs they already store,
// and reads / writes those locations so vault edits can flow back into the extensions.
import { classifyDescriptor, KIND } from './detect.js';
import { MODULE, guessName, hashKey } from './vault.js';

const isPlain = v => v && typeof v === 'object' && !Array.isArray(v);
const looksUrl = v => /^https?:\/\/\S+$/i.test(v.trim());
const looksKey = v => v.trim().length >= 8 && !/\s/.test(v.trim()) && !looksUrl(v);

/**
 * @param {object} settings SillyTavern extension_settings
 * @returns {{source:string, url:string, key:string, name:string,
 *   refs:{segs:string[], keyProp:string, urlProp:string, source:string, hash:string}[]}[]}
 *   One entry per distinct key; `refs` lists every place that key is stored.
 */
export function scanExtensionSettings(settings, { maxDepth = 5 } = {}) {
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
        const source = segs[0];
        for (const k of keys) {
            const url = urls[0]?.value || '';
            out.push({ source, url, key: k.value, name: guessName(url, source), ref: { segs, keyProp: k.prop, urlProp: urls[0]?.prop || '' } });
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
                name: 'Extras API',
                ref: { segs: [], keyProp: 'apiKey', urlProp: 'apiUrl' },
            });
        }
    }

    const unique = new Map();
    for (const { ref, ...c } of out) {
        const entry = unique.get(c.key) || { ...c, refs: [] };
        entry.refs.push({ ...ref, source: c.source, hash: hashKey(c.key) });
        unique.set(c.key, entry);
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
