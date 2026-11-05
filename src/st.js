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
        const m = await loadModule();
        if (m) {
            await m.readSecretState();
            return m.secret_state;
        }
        return post('/api/secrets/read');
    },

    /** Every saved secret in ST, one entry per stored value. `value` is masked unless exposure is allowed. */
    async candidates() {
        const state = await this.state();
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
