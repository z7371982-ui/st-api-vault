// Bridge to SillyTavern's own secret store (secrets.json on the server).
// Goes through ST's frontend module when it can, so ST's UI and events stay in sync,
// and falls back to the raw /api/secrets endpoints otherwise.
import { hostOf } from './vault.js';
import { setFieldValue } from './detect.js';

let ctx = null;
let modPromise = null;
let cachedKeys = null;
let modelApplyVersion = 0;

// name, well-known base URL
const PROVIDERS = {
    api_key_openai: ['OpenAI', 'https://api.openai.com/v1'],
    api_key_claude: ['Claude', 'https://api.anthropic.com/v1'],
    api_key_openrouter: ['OpenRouter', 'https://openrouter.ai/api/v1'],
    api_key_makersuite: ['Google AI Studio', 'https://generativelanguage.googleapis.com'],
    api_key_deepseek: ['DeepSeek', 'https://api.deepseek.com'],
    api_key_mistralai: ['MistralAI', 'https://api.mistral.ai/v1'],
    api_key_groq: ['Groq', 'https://api.groq.com/openai/v1'],
    api_key_xai: ['xAI (Grok)', 'https://api.x.ai/v1'],
    api_key_custom: ['自定义 (OpenAI 兼容)', ''],
    api_key_cohere: ['Cohere', ''],
    api_key_perplexity: ['Perplexity', ''],
    api_key_moonshot: ['Moonshot', ''],
    api_key_siliconflow: ['SiliconFlow', ''],
    api_key_zai: ['Z.AI', ''],
    api_key_nanogpt: ['NanoGPT', ''],
    api_key_electronhub: ['Electron Hub', ''],
    api_key_novel: ['NovelAI', ''],
    api_key_horde: ['AI Horde', ''],
    api_key_vertexai: ['Vertex AI', ''],
    api_key_azure_openai: ['Azure OpenAI', ''],
    api_key_ooba: ['Text Generation WebUI', ''],
    api_key_koboldcpp: ['KoboldCpp', ''],
    api_key_llamacpp: ['llama.cpp', ''],
    api_key_tabby: ['TabbyAPI', ''],
    api_key_vllm: ['vLLM', ''],
    api_key_generic: ['Generic (OpenAI 兼容)', ''],
};

// Chat completion source -> prefix of its model setting / dropdown when it differs from the source name,
// e.g. makersuite keeps its model in google_model and #model_google_select.
const MODEL_FIELD = { makersuite: 'google' };

// Secret slot -> the chat completion source that reads it (ST's apiSourceConfig in openai.js).
const SLOT_SOURCE = {
    api_key_openai: 'openai', api_key_claude: 'claude', api_key_openrouter: 'openrouter', api_key_ai21: 'ai21',
    api_key_makersuite: 'makersuite', api_key_vertexai: 'vertexai', api_key_mistralai: 'mistralai',
    api_key_custom: 'custom', api_key_cohere: 'cohere', api_key_perplexity: 'perplexity', api_key_groq: 'groq',
    api_key_electronhub: 'electronhub', api_key_chutes: 'chutes', api_key_nanogpt: 'nanogpt',
    api_key_deepseek: 'deepseek', api_key_aimlapi: 'aimlapi', api_key_xai: 'xai', api_key_pollinations: 'pollinations',
    api_key_moonshot: 'moonshot', api_key_fireworks: 'fireworks', api_key_cometapi: 'cometapi',
    api_key_azure_openai: 'azure_openai', api_key_zai: 'zai', api_key_siliconflow: 'siliconflow',
    api_key_workers_ai: 'workers_ai', api_key_minimax: 'minimax',
};

// Chat completion sources that honour the reverse proxy settings (ST's proxySupportedSources).
const PROXY_SOURCES = new Set(['claude', 'openai', 'mistralai', 'makersuite', 'vertexai', 'deepseek', 'xai', 'zai', 'moonshot']);

// URLs, ids and JSON blobs live in the same store but are not pasteable API keys.
const NOT_A_KEY = /_url$|_id$|_json$/;

function loadModule() {
    // public/scripts/extensions/third-party/<this>/src/st.js -> public/scripts/secrets.js
    if (!modPromise) modPromise = import('../../../../secrets.js').catch(err => {
        console.warn('[API Vault] ST secrets module not reachable, using raw endpoints', err);
        return null;
    });
    return modPromise;
}

async function post(path, body) {
    const res = await fetch(path, {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

export const st = {
    init(context) {
        ctx = context;
        loadModule().then(m => {
            if (m?.SECRET_KEYS) cachedKeys = Object.values(m.SECRET_KEYS);
        });
    },

    providerName(key) {
        if (PROVIDERS[key]) return PROVIDERS[key][0];
        const s = String(key || '').replace(/^api_key_/, '').replace(/_/g, ' ');
        return s.charAt(0).toUpperCase() + s.slice(1);
    },

    providerUrl(key) {
        if (key === 'api_key_custom') return ctx.chatCompletionSettings?.custom_url || '';
        return PROVIDERS[key]?.[1] || '';
    },

    /** Picks the ST secret slot a URL most likely belongs to. */
    suggestTarget(url) {
        const host = hostOf(url);
        if (host) {
            for (const [key, [, base]] of Object.entries(PROVIDERS)) {
                if (base && hostOf(base) === host) return key;
            }
        }
        return 'api_key_custom';
    },

    secretKeys() {
        const all = cachedKeys || Object.keys(PROVIDERS);
        return all.filter(k => !NOT_A_KEY.test(k));
    },

    async canView() {
        try {
            return (await post('/api/secrets/settings'))?.allowKeysExposure === true;
        } catch {
            return false;
        }
    },

    async state() {
        // The host's readSecretState also rebuilds every autocomplete option in the DOM.
        // Only its write/rotate/delete paths need to refresh the host UI.
        return post('/api/secrets/read');
    },

    async initialState() {
        // Current hosts load this snapshot before loading extensions.
        return (await loadModule())?.secret_state ?? this.state();
    },

    /** Every saved secret in ST, one entry per stored value. `value` is masked unless exposure is allowed. */
    async candidates(snapshot) {
        const state = snapshot === undefined ? await this.state() : snapshot;
        const out = [];
        for (const [key, list] of Object.entries(state || {})) {
            if (!Array.isArray(list) || NOT_A_KEY.test(key)) continue;
            for (const s of list) {
                out.push({
                    key,
                    id: s.id,
                    label: s.label || '',
                    value: s.value || '',
                    active: !!s.active,
                    name: this.providerName(key),
                    url: this.providerUrl(key),
                });
            }
        }
        return out;
    },

    async find(key, id) {
        const m = await loadModule();
        if (m) return m.findSecret(key, id);
        try {
            return (await post('/api/secrets/find', { key, id }))?.value ?? null;
        } catch {
            return null;
        }
    },

    /** Stores a new value under `key` and makes it active. Returns the new secret id. */
    async write(key, value, label) {
        const m = await loadModule();
        if (m) return m.writeSecret(key, value, label);
        return (await post('/api/secrets/write', { key, value, label }))?.id ?? null;
    },

    /** Makes an already stored secret the active one for its key. */
    async rotate(key, id) {
        const m = await loadModule();
        if (m) return m.rotateSecret(key, id);
        await post('/api/secrets/rotate', { key, id });
        globalThis.jQuery?.('#main_api').trigger('change');
    },

    async remove(key, id) {
        const m = await loadModule();
        if (m) return m.deleteSecret(key, id);
        await post('/api/secrets/delete', { key, id });
    },

    /**
     * A secret already stored under `key` that holds exactly `value`, so it can be reused instead of
     * written again. ST's writeSecret always appends, and every append is one more row in its key list.
     * Only exact matches count: with keys hidden (no allowKeysExposure) nothing can be compared safely.
     */
    async findSame(key, value) {
        if (!value) return null;
        const state = await this.state().catch(() => null);
        const list = Array.isArray(state?.[key]) ? state[key] : [];
        return list.find(s => s.value && !s.value.includes('*') && s.value === value) || null;
    },

    /**
     * Groups of identical values per secret slot. Keeps the active one (or the first) of each group.
     * Needs allowKeysExposure; with masked values duplicates cannot be told apart.
     * @returns {Promise<{canView: boolean, groups: {key: string, keep: object, drop: object[]}[]}>}
     */
    async duplicates() {
        const canView = await this.canView();
        if (!canView) return { canView, groups: [] };
        const state = await this.state();
        const groups = [];
        for (const [key, list] of Object.entries(state || {})) {
            if (!Array.isArray(list) || NOT_A_KEY.test(key)) continue;
            const byValue = new Map();
            for (const s of list) {
                if (!s.value || s.value.includes('*')) continue;
                if (!byValue.has(s.value)) byValue.set(s.value, []);
                byValue.get(s.value).push(s);
            }
            for (const same of byValue.values()) {
                if (same.length < 2) continue;
                const keep = same.find(s => s.active) || same[0];
                groups.push({ key, keep, drop: same.filter(s => s !== keep) });
            }
        }
        return { canView, groups };
    },

    /**
     * Deletes many secrets of one slot. ST's own deleteSecret re-reads the store and reconnects after every
     * single call, which with thousands of duplicates would hammer the server; this posts the raw deletes and
     * refreshes ST once at the end. `onProgress(done, total)` reports along the way.
     */
    async removeMany(key, ids, onProgress = () => {}) {
        // ST rewrites the whole secrets file on every delete, so one-by-one waits on thousands of round trips
        // (3000 copies took over 8 minutes). Its handlers read, edit and write the file synchronously, so a few
        // requests in flight at once are still applied one after another and cannot overwrite each other.
        let done = 0;
        let next = 0;
        const failed = [];
        // A single write can fail for a moment (the file briefly locked by a scanner or backup on Windows).
        // Retry it a few times; one bad request must not abandon the thousands still queued.
        const removeOne = async id => {
            for (let attempt = 0; ; attempt++) {
                try {
                    return await post('/api/secrets/delete', { key, id });
                } catch (err) {
                    if (attempt >= 3) throw err;
                    await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
                }
            }
        };
        const worker = async () => {
            while (next < ids.length) {
                const id = ids[next++];
                try {
                    await removeOne(id);
                } catch {
                    failed.push(id);
                }
                done++;
                if (done % 25 === 0 || done === ids.length) onProgress(done, ids.length);
            }
        };
        await Promise.all(Array.from({ length: Math.min(6, ids.length) }, worker));
        const m = await loadModule();
        if (m) {
            await m.readSecretState();
            await ctx.eventSource?.emit?.(ctx.eventTypes?.SECRET_DELETED, key);
        }
        return { done: done - failed.length, failed };
    },

    async rename(key, id, label) {
        const m = await loadModule();
        if (m) return m.renameSecret(key, id, label);
        await post('/api/secrets/rename', { key, id, label });
    },

    /**
     * Picks `model` in ST's model dropdown for the current chat completion source, the same as choosing it by hand.
     * Reconnecting (switching key or proxy preset) reloads the list and keeps the model only if it is in the
     * settings, so the settings are written first and the choice is applied again once ST is back online.
     * @returns {boolean} whether there was a model dropdown to set
     */
    applyModel(model) {
        const version = ++modelApplyVersion;
        const s = ctx.chatCompletionSettings;
        if (!s || !model) return false;
        const source = s.chat_completion_source;
        const base = MODEL_FIELD[source] || source;
        const apply = () => {
            s[`${base}_model`] = model;
            const sel = document.getElementById(`model_${base}_select`);
            if (sel && ![...sel.options].some(o => o.value === model)) {
                // A relay's own model id may not be in ST's built-in list; add it like an external model.
                const group = sel.querySelector('#openai_external_category') || sel;
                group.append(new Option(model, model));
            }
            const $ = globalThis.jQuery;
            if (sel) {
                sel.value = model;
                if ($) $(sel).trigger('change');
                else sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
            if (source === 'custom') {
                const input = document.getElementById('custom_model_id');
                if (input) setFieldValue(input, model);
            }
            ctx.saveSettingsDebounced();
            return !!sel;
        };
        const ok = apply();
        const { eventSource, eventTypes } = ctx;
        if (eventSource?.once && eventTypes?.ONLINE_STATUS_CHANGED) {
            let done = false;
            const again = () => {
                if (done) return;
                done = true;
                // A later user choice or another apply owns the selection now. Only repair a
                // reloaded dropdown while the settings still describe this exact application.
                if (version !== modelApplyVersion || ctx.chatCompletionSettings !== s
                    || s.chat_completion_source !== source || s[`${base}_model`] !== model) return;
                if (document.getElementById(`model_${base}_select`)?.value !== model) apply();
            };
            eventSource.once(eventTypes.ONLINE_STATUS_CHANGED, () => setTimeout(again, 50));
            // Some sources do not reconnect at all; stop waiting after a while.
            setTimeout(() => {
                done = true;
            }, 15000);
        }
        return ok;
    },

    /**
     * Reverse proxies only apply to some chat completion sources. Switches to OpenAI when the current
     * one ignores them, and returns the new source's name, or '' when nothing had to change.
     */
    ensureProxySource() {
        const s = ctx.chatCompletionSettings;
        if (!s || PROXY_SOURCES.has(s.chat_completion_source)) return '';
        const sel = document.getElementById('chat_completion_source');
        if (!sel) return '';
        sel.value = 'openai';
        const $ = globalThis.jQuery;
        if ($) $(sel).trigger('change');
        else sel.dispatchEvent(new Event('change', { bubbles: true }));
        return 'OpenAI';
    },

    /**
     * Makes ST actually send through the secret slot it was just given. A key written to, say,
     * api_key_custom does nothing while ST is on another chat completion source, or while a reverse proxy
     * preset is selected (proxy URL + password win over the key slot). Before this, "用于酒馆" reported
     * success but the chat kept going to the previous relay.
     * @returns {string} what had to change, '' when nothing did
     */
    useSlot(slot) {
        const s = ctx.chatCompletionSettings;
        const $ = globalThis.jQuery;
        const pick = (id, value) => {
            const sel = document.getElementById(id);
            if (!sel || sel.value === value || ![...sel.options].some(o => o.value === value)) return false;
            sel.value = value;
            if ($) $(sel).trigger('change');
            else sel.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        };
        const changed = [];
        // getContext() is a snapshot; the live API is whatever ST's own selector shows.
        const mainApi = document.getElementById('main_api')?.value ?? globalThis.SillyTavern?.getContext?.().mainApi;
        if (mainApi !== 'openai' && pick('main_api', 'openai')) changed.push('切到聊天补全');
        const source = SLOT_SOURCE[slot];
        if (source && s?.chat_completion_source !== source && pick('chat_completion_source', source)) changed.push('切换聊天补全来源');
        // The key slot is ignored while a proxy preset is active for this source; drop back to "None".
        if (s?.reverse_proxy && PROXY_SOURCES.has(source || s.chat_completion_source) && pick('openai_proxy_preset', 'None')) {
            changed.push('关闭反向代理预设');
        }
        return changed.join('、');
    },

    /**
     * The chat completion source ST is set to right now, when that source cannot use a reverse proxy but
     * takes its own URL + key: "自定义（兼容 OpenAI）". Profiles applied there should stay there instead of
     * turning ST into "OpenAI + 反向代理", which users read as the switch having gone wrong.
     */
    keepsOwnUrl() {
        const api = document.getElementById('main_api')?.value;
        const source = ctx.chatCompletionSettings?.chat_completion_source;
        return api === 'openai' && source === 'custom' ? 'api_key_custom' : '';
    },

    /** Whether ST is sending through a reverse proxy right now; its API key slot is ignored then. */
    proxyInUse() {
        const s = ctx.chatCompletionSettings;
        return !!s?.reverse_proxy && PROXY_SOURCES.has(s.chat_completion_source);
    },

    currentModel() {
        const s = ctx.chatCompletionSettings;
        if (!s) return '';
        const base = MODEL_FIELD[s.chat_completion_source] || s.chat_completion_source;
        return String(s[`${base}_model`] || '');
    },

    /** Custom (OpenAI-compatible) source keeps its URL in chat completion settings, not in secrets. */
    setCustomUrl(url) {
        const el = document.getElementById('custom_api_url_text');
        if (el) {
            setFieldValue(el, url);
        } else if (ctx.chatCompletionSettings) {
            ctx.chatCompletionSettings.custom_url = url;
            ctx.saveSettingsDebounced();
        }
    },
};
