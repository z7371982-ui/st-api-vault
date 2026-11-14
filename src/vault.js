// Pure data helpers for the vault. No DOM and no SillyTavern globals, so they run under plain Node tests.

export const MODULE = 'apiVault';

export function defaultSettings() {
    return {
        version: 4,
        profiles: [],
        // fingerprint -> { profileId, kind, scope, label, at }
        bindings: {},
        // "<secretKey>:<secretId>" refs already looked at during import, so deleted profiles are not re-imported
        seenRefs: [],
        options: {
            theme: 'light',
            pill: true,
            autoFillBound: false,
            capture: true,
            // Off: nothing is imported behind the user's back; the "扫描" button lets them pick.
            autoImport: false,
            autoSync: true,
            // After a reload, reconnect to the API that last connected on this device.
            autoConnect: true,
            // One-time default only; the actual preference is ST's native setting.
            presetApiProtectionInitialized: false,
            // Floating key button: on by default on touch screens, where there is no Alt+K.
            fab: 'auto',
            fabPos: null,
            fabSize: 48,
            // Read notice.json and the repo version from GitHub; only "major" notices pop up.
            notices: true,
            // Row of tag buttons under the search box, in the panel list and the fill picker.
            tagBar: false,
        },
    };
}

/**
 * @param {object} raw saved settings
 * @param {string[]} extIds top-level keys of ST's extension_settings, i.e. other plugins' ids
 */
export function migrate(raw, extIds = []) {
    const base = defaultSettings();
    if (!raw || typeof raw !== 'object') return base;
    const options = { ...base.options, ...(raw.options && typeof raw.options === 'object' ? raw.options : {}) };
    // v1 imported automatically by default; v2 leaves it to the scan button. Reset once for old installs.
    if (!(raw.version >= 2)) options.autoImport = false;
    let profiles = Array.isArray(raw.profiles) ? raw.profiles.map(createProfile) : [];
    // v2 sent "用于酒馆" into ST's API key slot by default; v3 uses proxy presets. Profiles that got a
    // slot only because of that old default go back to the preset route (masked-only keys keep working
    // through their stRef in syncToST).
    if (!(raw.version >= 3)) profiles = profiles.map(p => ({ ...p, syncTarget: '' }));
    // Up to v3 a scan tagged each import with the plugin's settings id ("baibai_image", "st-chatu8",
    // "variables"), which only clutters the tag bar. Drop those once; tags the user typed stay.
    if (!(raw.version >= 4)) {
        const ids = new Set(extIds.filter(id => id !== MODULE));
        profiles = profiles.map(p => {
            const sources = new Set(p.extRefs.map(r => r.source));
            return { ...p, tags: p.tags.filter(t => !ids.has(t) && !sources.has(t)) };
        });
    }
    return {
        version: 4,
        profiles,
        bindings: raw.bindings && typeof raw.bindings === 'object' ? { ...raw.bindings } : {},
        seenRefs: Array.isArray(raw.seenRefs) ? raw.seenRefs.filter(x => typeof x === 'string') : [],
        options,
    };
}

const str = v => (typeof v === 'string' ? v.trim() : '');
const num = (v, d) => (Number.isFinite(v) ? v : d);

export function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function createProfile(p = {}) {
    const now = Date.now();
    return {
        id: str(p.id) || uid(),
        name: str(p.name) || guessName(p.url),
        url: str(p.url),
        key: str(p.key),
        // masked value shown by SillyTavern when the raw key cannot be read
        keyHint: str(p.keyHint),
        model: str(p.model),
        tags: Array.isArray(p.tags) ? [...new Set(p.tags.map(str).filter(Boolean))] : [],
        note: typeof p.note === 'string' ? p.note : '',
        stRef: p.stRef && typeof p.stRef.key === 'string' ? { key: p.stRef.key, id: p.stRef.id ?? null } : null,
        // last label seen on the ST secret, so a rename in ST can be told apart from a rename here
        stLabel: str(p.stLabel),
        stMissing: !!p.stMissing,
        // ST reverse proxy preset this profile mirrors; hash of url+password tells a rename in ST from a delete
        proxyRef: p.proxyRef && typeof p.proxyRef.name === 'string' ? { name: p.proxyRef.name, hash: str(p.proxyRef.hash) } : null,
        proxyMissing: !!p.proxyMissing,
        // name was derived (host / extension id), so a real name found later may replace it
        nameAuto: p.nameAuto === undefined ? looksDerivedName(p) : !!p.nameAuto,
        syncTarget: str(p.syncTarget),
        syncedHash: str(p.syncedHash),
        // places in other extensions' settings that hold this key
        extRefs: Array.isArray(p.extRefs) ? p.extRefs.map(normExtRef).filter(Boolean) : [],
        // hashes of keys this profile held before, so plugin fields still showing an old one can be refreshed
        prevKeys: Array.isArray(p.prevKeys) ? p.prevKeys.filter(h => typeof h === 'string' && h).slice(-10) : [],
        models: Array.isArray(p.models) ? p.models.filter(m => typeof m === 'string' && m).slice(0, 2000) : [],
        // models starred in the model list of this profile; they are listed first
        favModels: Array.isArray(p.favModels) ? [...new Set(p.favModels.filter(m => typeof m === 'string' && m))].slice(0, 200) : [],
        modelsAt: num(p.modelsAt, 0),
        health: normHealth(p.health),
        createdAt: num(p.createdAt, now),
        updatedAt: num(p.updatedAt, now),
        usedAt: num(p.usedAt, 0),
        useCount: num(p.useCount, 0),
    };
}

/** Older profiles have no nameAuto flag; treat host names and source tags as derived. */
function looksDerivedName(p) {
    const name = str(p.name);
    if (!name) return true;
    if (str(p.url) && name === guessName(p.url)) return true;
    return Array.isArray(p.tags) && p.tags.some(t => str(t) === name);
}

function normHealth(h) {
    if (!h || typeof h !== 'object') return null;
    return { ok: !!h.ok, ms: num(h.ms, 0), at: num(h.at, 0), count: num(h.count, 0), error: str(h.error), base: str(h.base) };
}

/**
 * extension_settings entries that belong to SillyTavern itself, not to a plugin's API config.
 * Connection Manager profiles hold a secret *id* and a proxy preset name, and ST applies them as a whole,
 * so the vault must never import or write back into them.
 */
export const ST_OWNED_SETTINGS = new Set(['connectionManager']);

function normExtRef(r) {
    if (!r || !Array.isArray(r.segs) || !str(r.keyProp)) return null;
    if (ST_OWNED_SETTINGS.has(String(r.segs[0]))) return null;
    return {
        segs: r.segs.map(String), keyProp: str(r.keyProp), urlProp: str(r.urlProp), source: str(r.source), hash: str(r.hash),
        urlSeen: typeof r.urlSeen === 'string' ? r.urlSeen : undefined,
        nameProp: str(r.nameProp), nameSeen: str(r.nameSeen),
        // a note the user gave this place in the bound-fields list
        alias: str(r.alias).slice(0, 40),
    };
}

/** Stable id of an extension settings location, e.g. "translate.nested.apiKey". */
export function extRefId(r) {
    return [...r.segs, r.keyProp].join('.');
}

/**
 * Whether a bound plugin field still holds what the profile has now.
 * 'ok' / 'stale', or '' for bindings made before fills were recorded (and masked-only keys).
 */
export function bindingStatus(b, p) {
    const want = b?.kind === 'url' ? p?.url : p?.key;
    if (!b?.valueHash || !want) return '';
    return b.valueHash === hashKey(want) ? 'ok' : 'stale';
}

export function normalizeUrl(url) {
    let s = str(url);
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
    return s.replace(/\/+$/, '');
}

export function hostOf(url) {
    try {
        return new URL(normalizeUrl(url)).host;
    } catch {
        return '';
    }
}

/** URL parsing normalizes host/protocol casing, but paths and queries remain case-sensitive. */
export function urlIdentity(url) {
    const value = normalizeUrl(url);
    if (!value) return '';
    try { return new URL(value).href; } catch { return value; }
}

export function sameUrl(a, b) {
    const x = urlIdentity(a);
    return !!x && x === urlIdentity(b);
}

export function guessName(url, fallback = '新配置') {
    const host = hostOf(url);
    if (host) return host.replace(/^(api|www|openai)\./i, '');
    return str(fallback) || '新配置';
}

export function maskKey(key) {
    const s = str(key);
    if (!s) return '';
    if (s.length <= 8) return '•'.repeat(s.length);
    return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

/** Non-cryptographic hash, only used to notice that a key changed since the last sync. */
export function hashKey(s) {
    let h = 5381;
    for (const ch of String(s)) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0;
    return h.toString(16);
}

/** Whether a full key matches the masked form SillyTavern returns, e.g. "*******abc". */
export function maskMatches(key, masked) {
    const k = str(key);
    const m = str(masked);
    if (!k || !m) return false;
    if (!m.includes('*')) return k === m;
    const tail = m.replace(/^\*+/, '');
    return tail.length >= 3 && k.length > 10 && k.endsWith(tail);
}

export function parseTags(text) {
    return [...new Set(String(text || '').split(/[,，、\s]+/).map(t => t.trim()).filter(Boolean))];
}

export function findProfileByKey(profiles, key) {
    const k = str(key);
    return k ? profiles.find(p => p.key === k) || null : null;
}

/** Same key at the same address. One key used on two different relays stays two profiles. */
export function findProfileByPair(profiles, key, url) {
    const k = str(key);
    if (!k) return null;
    return profiles.find(p => p.key === k && (!p.url || !str(url) || sameUrl(p.url, url))) || null;
}

/** Hash of a proxy preset's contents, to recognise it after a rename in ST. */
export function proxyHash(url, password) {
    return hashKey(`${str(url)}\n${str(password)}`);
}

/** Same key means duplicate. Without a key, the same URL (with no key either) is a duplicate. */
export function findDuplicate(profiles, { url, key }) {
    if (str(key)) return findProfileByKey(profiles, key);
    if (!str(url)) return null;
    return profiles.find(p => !p.key && sameUrl(p.url, url)) || null;
}

export function searchProfiles(profiles, query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [...profiles];
    return profiles.filter(p => {
        const hay = `${p.name} ${p.url} ${p.model} ${p.tags.join(' ')} ${p.note}`.toLowerCase();
        return words.every(w => hay.includes(w));
    });
}

export function sortProfiles(profiles) {
    return [...profiles].sort((a, b) => (b.usedAt - a.usedAt) || (b.createdAt - a.createdAt));
}

/** Tags in use, most used first. */
export function tagList(profiles) {
    const count = new Map();
    for (const p of profiles) for (const t of p.tags) count.set(t, (count.get(t) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

/** Wrapping row of tag filter buttons, used by the panel list and the fill picker. */
export function tagBarHtml(tags, current, total) {
    if (!tags.length) return '';
    return `<div class="avm-tags" role="group" aria-label="按标签筛选">
        <button type="button" class="avm-tag-btn${current ? '' : ' is-on'}" data-tag="" aria-pressed="${!current}">全部${total ? ` ${total}` : ''}</button>
        ${tags.map(x => `<button type="button" class="avm-tag-btn${x === current ? ' is-on' : ''}" data-tag="${esc(x)}" aria-pressed="${x === current}">${esc(x)}</button>`).join('')}
    </div>`;
}

/** Splits a model list into the starred ones and the rest, both in list order. */
export function splitFavorites(models, favs) {
    const set = new Set(favs);
    return { fav: models.filter(m => set.has(m)), rest: models.filter(m => !set.has(m)) };
}

/**
 * Groups profiles by host for a batch test: different sites are tested at the same time,
 * several keys on one site one after another, so that site does not see a burst of requests.
 */
export function hostQueues(profiles) {
    const groups = new Map();
    for (const p of profiles) {
        const host = hostOf(p.url) || `#${p.id}`;
        groups.set(host, [...(groups.get(host) || []), p]);
    }
    return [...groups.values()];
}

// Stops at CJK text and full-width punctuation, so "https://a.com/v1密钥：sk-..." splits cleanly.
const URL_IN_TEXT = /https?:\/\/[^\s"'<>　-鿿＀-￯]+/i;
const KEY_PREFIX = /^(sk|ak|pk|rk|gsk|xai|cr|key)[-_]|^AIza/i;

/**
 * Pulls a URL and an API key out of a blob of pasted text,
 * e.g. "地址: https://api.openai.com/v1  密钥: sk-abc..." -> { url, key }.
 */
export function parseCredentialText(text) {
    const s = String(text || '');
    const m = s.match(URL_IN_TEXT);
    const url = m ? m[0].replace(/[),.;]+$/, '') : '';
    const rest = m ? s.replace(m[0], ' ') : s;
    const tokens = rest.split(/[\s"'`,;，；：:|、=]+/).filter(Boolean);
    const looksKey = t => /^[\w\-.]{16,}$/.test(t) && /\d/.test(t) && /[a-z]/i.test(t);
    const key = tokens.find(t => KEY_PREFIX.test(t) && looksKey(t)) || tokens.find(looksKey) || '';
    return { url, key };
}

/** Model ids from any of the common /models response shapes (OpenAI, Gemini, Cohere, bare arrays). */
export function parseModelList(data) {
    const list = [data, data?.data, data?.models, data?.data?.data].find(Array.isArray) || [];
    const ids = list
        .map(m => (typeof m === 'string' ? m : m?.id || m?.name || ''))
        .map(s => String(s).trim().replace(/^models\//, ''))
        .filter(Boolean);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/**
 * Base URLs worth trying for a user-entered address. People often paste the site root
 * or a full ".../chat/completions" endpoint, so strip that and also try "/v1".
 */
export function baseCandidates(url) {
    const u = normalizeUrl(url).replace(/\/(chat\/completions|completions|models|messages)$/i, '');
    if (!u) return [];
    let path = '';
    try {
        path = new URL(u).pathname;
    } catch {
        return [u];
    }
    if (/\/v\d+[a-z0-9]*$/i.test(path) || /googleapis\.com$/i.test(hostOf(u))) return [u];
    return [u, `${u}/v1`];
}

/** Plain-language reason for a failed API request. */
export function httpMessage(status) {
    if (status === 401 || status === 403) return `密钥无效或没有权限（${status}）`;
    if (status === 404) return '地址不对，找不到模型列表（404）';
    if (status === 429) return '请求太频繁或额度用完了（429）';
    if (status >= 500) return `服务端出错（${status}）`;
    return `请求失败（${status}）`;
}

export function colorFor(seed) {
    let h = 0;
    for (const ch of String(seed || '?')) h = (h * 31 + ch.codePointAt(0)) % 360;
    return `hsl(${h} 62% 58%)`;
}

export function initials(name) {
    const s = str(name);
    if (!s) return '?';
    if (/[㐀-鿿]/.test(s[0])) return s[0];
    const words = s.split(/[\s·\-_./]+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : s.slice(0, 2)).toUpperCase();
}

export function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- versions and announcements (notice.json) ----------

/** Compares dotted versions numerically: 1 when a is newer, -1 when older, 0 when equal. */
export function compareVersions(a, b) {
    const pa = String(a || '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
    const pb = String(b || '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d > 0 ? 1 : -1;
    }
    return 0;
}

/** notice.json -> clean list, newest version first. Entries without a version are dropped. */
export function normNotices(raw) {
    const list = Array.isArray(raw?.notices) ? raw.notices : [];
    return list
        .filter(n => n && typeof n === 'object' && str(n.version))
        .map(n => ({
            id: str(n.id) || str(n.version),
            version: str(n.version),
            major: n.major === true || n.level === 'major',
            title: str(n.title),
            date: str(n.date),
            content: typeof n.content === 'string' ? n.content : '',
        }))
        .sort((a, b) => compareVersions(b.version, a.version));
}

/** The newest major notice for a version above the installed one that the user has not turned down. */
export function majorNoticeToPrompt(notices, localVersion, dismissed = []) {
    return notices.find(n => n.major && compareVersions(n.version, localVersion) > 0 && !dismissed.includes(n.id)) || null;
}

/** The major notice of the version now installed, shown once after updating to it. */
export function noticeForInstalled(notices, localVersion, shown = []) {
    return notices.find(n => n.major && compareVersions(n.version, localVersion) === 0 && !shown.includes(n.id)) || null;
}

/**
 * A small, safe subset of Markdown for announcements: "#" headings, "-" lists, **bold** and
 * [links](https://...). Everything is escaped first, so a notice cannot carry HTML or scripts.
 */
export function renderNotice(md) {
    const inline = s => esc(s)
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    const out = [];
    let list = false;
    for (const raw of String(md || '').split(/\r?\n/)) {
        const line = raw.trim();
        const item = line.match(/^[-*]\s+(.*)$/);
        if (!item && list) {
            out.push('</ul>');
            list = false;
        }
        if (!line) continue;
        if (item) {
            if (!list) out.push('<ul>');
            list = true;
            out.push(`<li>${inline(item[1])}</li>`);
            continue;
        }
        const h = line.match(/^#{1,4}\s+(.*)$/);
        out.push(h ? `<h4>${inline(h[1])}</h4>` : `<p>${inline(line)}</p>`);
    }
    if (list) out.push('</ul>');
    return out.join('');
}
