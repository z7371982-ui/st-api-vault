// Bridge to SillyTavern's reverse proxy presets (Chat Completion -> 反向代理 -> 代理预设).
// Relay users often keep every relay here with a name of their own, a URL and a password (= API key).
// These live in settings.json `proxies`, not in secrets.json.
import { setFieldValue } from './detect.js';

let ctx = null;
let modPromise = null;

function loadModule() {
    // public/scripts/extensions/third-party/<this>/src/proxy.js -> public/scripts/openai.js
    // Same URL as ST's own import, so this is the live module and its `proxies` array.
    if (!modPromise) modPromise = import('../../../../openai.js').catch(err => {
        console.warn('[API Vault] ST openai module not reachable, proxy presets are read-only', err);
        return null;
    });
    return modPromise;
}

const clean = p => ({
    name: String(p?.name ?? ''),
    url: String(p?.url ?? '').trim(),
    password: String(p?.password ?? '').trim(),
});

/** Read-only fallback when the module cannot be imported. */
async function fromSettingsFile() {
    try {
        const res = await fetch('/api/settings/get', { method: 'POST', headers: ctx.getRequestHeaders(), body: '{}' });
        if (!res.ok) return [];
        const data = await res.json();
        const proxies = JSON.parse(data?.settings || '{}')?.proxies;
        return Array.isArray(proxies) ? proxies : [];
    } catch {
        return [];
    }
}

export const proxy = {
    init(context) {
        ctx = context;
        loadModule();
    },

    /** Saved presets, without ST's built-in empty "None". */
    async list() {
        const m = await loadModule();
        const raw = Array.isArray(m?.proxies) ? m.proxies : await fromSettingsFile();
        return raw.map(clean).filter(p => p.name && p.name !== 'None' && (p.url || p.password));
    },

    async selectedName() {
        const m = await loadModule();
        return m?.selected_proxy?.name || '';
    },

    /**
     * Changes a preset in place and saves ST's settings. Keeps the old name if the new one is taken.
     * @returns {Promise<{name:string, url:string, password:string}|null>} the preset after the update
     */
    async update(oldName, { name, url, password }) {
        const m = await loadModule();
        const preset = Array.isArray(m?.proxies) && m.proxies.find(p => p.name === oldName);
        if (!preset) return null;

        preset.url = url;
        preset.password = password;
        const nextName = String(name || '').trim();
        if (nextName && nextName !== oldName && nextName !== 'None' && !m.proxies.some(p => p.name === nextName)) {
            preset.name = nextName;
            const opt = [...(document.getElementById('openai_proxy_preset')?.options || [])].find(o => o.value === oldName);
            if (opt) {
                opt.value = nextName;
                opt.textContent = nextName;
            }
        }

        // The selected preset is mirrored into the chat completion settings and the form fields.
        if (m.selected_proxy === preset || m.selected_proxy?.name === oldName) {
            const nameEl = document.getElementById('openai_reverse_proxy_name');
            if (nameEl) nameEl.value = preset.name;
            const urlEl = document.getElementById('openai_reverse_proxy');
            const keyEl = document.getElementById('openai_proxy_access_key');
            if (urlEl) setFieldValue(urlEl, url);
            if (keyEl) setFieldValue(keyEl, password);
            if (ctx.chatCompletionSettings) {
                ctx.chatCompletionSettings.reverse_proxy = url;
                ctx.chatCompletionSettings.proxy_password = password;
            }
        }
        ctx.saveSettingsDebounced();
        return clean(preset);
    },

    /** Selects a preset the same way choosing it in ST's dropdown does. */
    async select(name) {
        const sel = document.getElementById('openai_proxy_preset');
        if (!sel || ![...sel.options].some(o => o.value === name)) return false;
        sel.value = name;
        // jQuery handlers are plain listeners, so a native event reaches ST's onProxyPresetChange.
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    },
};
