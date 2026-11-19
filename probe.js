// Connection test the way ST's own "Connect" button does it: one GET /models.
// A model list confirms this endpoint responds; it does not prove every model can generate.
// Requests go through SillyTavern's server first (no browser CORS), and fall back to a
// direct fetch, which also tells us the real HTTP status when ST only reports "error".
import { store } from './store.js';
import { st } from './st.js';
import { resolveKey } from './sync.js';
import { baseCandidates, parseModelList, httpMessage, hostOf, normalizeUrl } from './vault.js';

const STATUS = '/api/backends/chat-completions/status';
const TIMEOUT = 20000;

let ctx = null;
const latestProbe = new Map();

export function initProbe(context) {
    ctx = context;
}

export class ProbeError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.status = status;
    }
}

const isGoogle = url => /generativelanguage\.googleapis\.com$/i.test(hostOf(url));
const isAnthropic = url => /(^|\.)anthropic\.com$/i.test(hostOf(url));
const googleRoot = url => url.replace(/\/v1(beta|alpha)?$/i, '');
// ST secret slot -> chat completion source, e.g. api_key_openrouter -> openrouter
const sourceOf = slot => slot.replace(/^api_key_/, '');

function friendly(err) {
    if (err instanceof ProbeError) return err;
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new ProbeError('连接超时');
    return new ProbeError(err?.message || String(err));
}

// AbortSignal.timeout is missing on older Android WebViews (Chrome < 103), which many Termux users browse with.
function timeoutSignal(ms) {
    if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
}

async function postST(path, body) {
    const res = await fetch(path, {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify(body),
        signal: timeoutSignal(TIMEOUT),
    });
    const data = await res.json().catch(() => null);
    return { res, data };
}

async function modelsViaST(body) {
    const { res, data } = await postST(STATUS, body);
    if (!res.ok) throw new ProbeError(httpMessage(res.status), res.status);
    return checkedModels(data);
}

function checkedModels(data) {
    const status = Number(data?.code ?? data?.status);
    if (!data || data.error || data.success === false || (status >= 400 && status < 600)) {
        throw new ProbeError('接口返回错误，未能取得模型列表', status >= 400 && status < 600 ? status : 0);
    }
    const models = parseModelList(data);
    if (!models.length) throw new ProbeError('没有返回可用的模型列表，暂时无法确认连接有效');
    return models;
}

async function modelsDirect(url, headers) {
    const res = await fetch(url, { headers, signal: timeoutSignal(TIMEOUT) });
    if (!res.ok) throw new ProbeError(httpMessage(res.status), res.status);
    const data = await res.json().catch(() => {
        throw new ProbeError('返回的不是 JSON，地址可能不对');
    });
    return checkedModels(data);
}

async function listAt(base, key) {
    if (isAnthropic(base)) {
        // Anthropic allows browser calls with this header; ST's status route does not cover Claude.
        return modelsDirect(`${base}/models`, {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
        });
    }
    const google = isGoogle(base);
    const body = google
        ? { chat_completion_source: 'makersuite', reverse_proxy: googleRoot(base), proxy_password: key }
        : { chat_completion_source: 'openai', reverse_proxy: base, proxy_password: key };
    try {
        return await modelsViaST(body);
    } catch (stErr) {
        const url = google ? `${googleRoot(base)}/v1beta/models?key=${encodeURIComponent(key)}` : `${base}/models`;
        const headers = !google && key ? { Authorization: `Bearer ${key}` } : {};
        try {
            return await modelsDirect(url, headers);
        } catch (err) {
            // A CORS / network failure says nothing useful; keep ST's answer then.
            throw err instanceof ProbeError && err.status ? err : friendly(stErr);
        }
    }
}

/** Body for asking ST to use a secret it stores itself, for profiles we only have a mask of. */
function stSecretBody(p) {
    const body = { chat_completion_source: sourceOf(p.stRef.key), secret_id: p.stRef.id };
    if (p.stRef.key === 'api_key_custom') body.custom_url = p.url || st.providerUrl('api_key_custom');
    return body;
}

function credentials(p) {
    return JSON.stringify([p.url || '', p.key || '', p.stRef?.key || '', p.stRef?.id ?? null, !!p.stMissing]);
}

function save(p, token, patch) {
    const current = p.id && store.get(p.id);
    if (current && latestProbe.get(p.id) === token && credentials(current) === credentials(p)) {
        store.upsert({ id: p.id, ...patch });
        return true;
    }
    return false;
}

/**
 * Tests the connection by listing models. Works on saved profiles and on unsaved editor drafts.
 * @returns {Promise<{ok:true, ms:number, base:string, models:string[], via:string, stale:boolean}>}
 */
export async function probe(profile) {
    // The store mutates records in place; do not let edits change an in-flight request's identity.
    const p = { ...profile, stRef: profile.stRef ? { ...profile.stRef } : null };
    const token = {};
    if (p.id) latestProbe.set(p.id, token);
    const t0 = performance.now();
    try {
        // Editor drafts carry the key being typed, which may differ from the saved one.
        const key = p.key || await resolveKey(p);
        if (key) p.key = key;
        let models;
        let base = normalizeUrl(p.url);
        let via = '';

        if (!key && p.stRef && !p.stMissing) {
            models = await modelsViaST(stSecretBody(p));
            via = '酒馆保存的密钥';
        } else {
            const bases = baseCandidates(p.url);
            if (!bases.length) throw new ProbeError('没有填写地址');
            let lastErr = null;
            for (const b of bases) {
                try {
                    models = await listAt(b, key);
                    base = b;
                    lastErr = null;
                    break;
                } catch (err) {
                    lastErr = friendly(err);
                    // A rejected key is rejected on every path; no point trying "/v1".
                    if (lastErr.status === 401 || lastErr.status === 403) break;
                }
            }
            if (lastErr) throw lastErr;
        }

        const ms = Math.round(performance.now() - t0);
        const saved = save(p, token, { models, modelsAt: Date.now(), health: { ok: true, ms, at: Date.now(), count: models.length, base } });
        return { ok: true, ms, base, models, via, stale: !!p.id && !saved };
    } catch (err) {
        const e = friendly(err);
        const saved = save(p, token, { health: { ok: false, ms: 0, at: Date.now(), error: e.message } });
        e.stale = !!p.id && !saved;
        throw e;
    } finally {
        if (p.id && latestProbe.get(p.id) === token) latestProbe.delete(p.id);
    }
}
