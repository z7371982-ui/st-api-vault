// Two-way sync between the vault and SillyTavern.
//   ST / extensions -> vault: import what they store, follow renames, deletions and key changes.
//   vault -> ST / extensions: push edited keys, URLs and names back to every linked place.
// Three ST-side sources: secrets.json (API keys), reverse proxy presets (settings.json `proxies`),
// and other extensions' settings.
import { store } from './store.js';
import { st } from './st.js';
import { proxy } from './proxy.js';
import { offerCaptures, captureEnabled } from './capture.js';
import { scanExtensionSettings, readAt, writeAt } from './scan.js';
import { hashKey, findProfileByPair, extImportRef, extRefId, proxyHash, urlIdentity, sameUrl } from './vault.js';

const ST_SOURCE = '酒馆';
const PROXY_SOURCE = '反向代理';
// ST labels new secrets with a timestamp; those make poor profile names.
const DATE_LABEL = /^\d{1,4}[/.\-年]\d{1,2}/;

let ctx = null;
let busyUntil = 0;
let syncTimer = null;
let pendingSync = null;
let syncRunning = false;
let retrySecretRead = false;
// Runtime only: "<slot>:<id>" of secrets ST currently uses, and the selected proxy preset.
const activeRefs = new Set();
let activeProxy = '';
let proxyInUse = false;

export function initSync(context) {
    ctx = context;
}

const observed = new Set();
let secretsPrimed = false;
let proxiesPrimed = false;
let captureReady;

/** Inspect source identities before constructing candidates or reading key exposure settings. */
function selectSources({ state, presets, extensions }, include) {
    const selectedState = {};
    for (const [slot, rows] of Object.entries(state || {})) {
        if (!Array.isArray(rows)) continue;
        const selected = rows.filter(row => row?.id && include(slot + ':' + row.id, 'secret'));
        if (selected.length) selectedState[slot] = selected;
    }
    return {
        state: Object.keys(selectedState).length ? selectedState : null,
        presets: { ...presets, list: (presets.list || []).filter(p => include('proxy:' + proxyHash(p.url, p.password), 'proxy')) },
        extensions: extensions.filter(e => include(extImportRef(e.source, e.key, e.url), 'extension')),
    };
}

export function primeCapture() {
    const extensions = scanExtensionSettings(ctx.extensionSettings);
    captureReady = Promise.all([st.initialState().catch(() => null), proxy.list().catch(() => null)])
        .then(([state, list]) => {
            selectSources({ state, presets: { list }, extensions }, ref => { observed.add(ref); return false; });
            secretsPrimed = state !== null;
            proxiesPrimed = list !== null;
        });
}

async function discoverForCapture(sources) {
    await captureReady;
    const enabled = captureEnabled();
    const fresh = selectSources(sources, (ref, type) => {
        if (observed.has(ref)) return false;
        observed.add(ref);
        return enabled && (type !== 'secret' || secretsPrimed) && (type !== 'proxy' || proxiesPrimed);
    });
    if (sources.state !== null) secretsPrimed = true;
    if (sources.presets.list !== null) proxiesPrimed = true;
    if (!fresh.state && !fresh.presets.list.length && !fresh.extensions.length) return;
    const { items } = await collectCandidates(fresh);
    offerCaptures(items.filter(it => !it.existing && !it.removed && (it.key || it.keyHint || it.url)));
}

/** Re-read only the sources represented in the selection before applying the user's decision. */
export async function saveCaptured(groups) {
    const all = groups.flat();
    const saved = all.filter(it => it.ref);
    let added = 0;
    if (saved.length) {
        const selectedRefs = new Map();
        for (const it of saved) for (const ref of it.sourceRefs) selectedRefs.set(ref, it);
        const [state, list] = await Promise.all([
            saved.some(it => it.stRef) ? st.state() : null,
            saved.some(it => it.proxyRef) ? proxy.list() : [],
        ]);
        const extensions = saved.some(it => it.extRefs.length) ? scanExtensionSettings(ctx.extensionSettings) : [];
        const sources = selectSources({ state, presets: { list }, extensions }, ref => selectedRefs.has(ref));
        const { items } = await collectCandidates(sources);
        if (!captureEnabled()) return 0;
        const removed = new Set(store.settings.removedRefs);
        const eligible = items.filter(it => {
            const original = selectedRefs.get(it.ref);
            return original && !it.removed && !it.sourceRefs.some(ref => removed.has(ref))
                && (!it.stRef || (it.keyHint === original.keyHint && urlIdentity(it.url) === urlIdentity(original.url)));
        });
        if (eligible.length) added = importItems(eligible).added;
    }
    if (!captureEnabled()) return added;
    for (const group of groups) {
        // A saved source takes precedence over a field that may since have been cleared.
        if (!group.some(it => it.ref) && group[0].saveField?.()) added++;
    }
    return added;
}

const refKey = r => `${r.key}:${r.id}`;
const niceLabel = l => (l && !DATE_LABEL.test(l) ? l : '');

function requireLiveProfile(p, sourceRef) {
    if (store.get(p.id) === p) return;
    // A write already in flight can finish after a local delete. Keep the returned source excluded too.
    if (sourceRef && !store.settings.removedRefs.includes(sourceRef)) {
        store.settings.removedRefs.push(sourceRef);
        store.save();
    }
    throw new Error('此配置已移除，已停止同步');
}

export function isActiveInST(p) {
    if (p.proxyRef && !p.proxyMissing && activeProxy && p.proxyRef.name === activeProxy && st.proxyInUse()) return true;
    // While a reverse proxy is set, ST ignores the API key slot, so a key there is not "in use".
    return !!p.stRef && !p.stMissing && !st.proxyInUse() && activeRefs.has(refKey(p.stRef));
}

/** Creates an ST proxy preset for a profile that has none and links the two. Returns the preset name. */
async function linkNewProxy(p) {
    if (!p.url) return '';
    const r = await proxy.create({ name: p.name, url: p.url, password: p.key });
    if (!r) return '';
    requireLiveProfile(p, 'proxy:' + proxyHash(r.url, r.password));
    p.proxyRef = { name: r.name, hash: proxyHash(r.url, r.password) };
    p.proxyMissing = false;
    store.settings.seenRefs.push(`proxy:${p.proxyRef.hash}`);
    return r.name;
}

/** Raw key for a profile, fetched from ST (and cached) when only a masked copy is known. */
export async function resolveKey(profile) {
    const saved = store.get(profile.id);
    const p = saved || profile;
    if (p.key) return p.key;
    if (!p.stRef || p.stMissing) return '';
    const identity = () => JSON.stringify([p.url, p.key, p.stRef, p.stMissing]);
    const before = identity();
    const value = await st.find(p.stRef.key, p.stRef.id);
    if ((saved && store.get(p.id) !== saved) || identity() !== before) {
        throw new Error('读取密钥期间配置已变化，请重新选择配置');
    }
    if (value && !value.includes('*')) {
        if (store.get(p.id)) store.upsert({ id: p.id, key: value, syncedHash: hashKey(value) });
        return value;
    }
    return '';
}

/** Per scan/batch. Preserve profile order when several saved profiles match the same key. */
function importIndex() {
    const byKey = new Map(), byRef = new Map(), position = new Map();
    const add = (map, key, p) => {
        const bucket = map.get(key);
        if (!bucket) {
            map.set(key, [p]);
            return;
        }
        const outOfOrder = position.get(bucket[bucket.length - 1]) > position.get(p);
        bucket.push(p);
        if (outOfOrder) bucket.sort((a, b) => position.get(a) - position.get(b));
    };
    const index = (p, keyChanged = true, refChanged = true) => {
        if (!position.has(p)) position.set(p, position.size);
        if (keyChanged && p.key) add(byKey, p.key, p);
        if (refChanged && p.stRef) add(byRef, refKey(p.stRef), p);
    };
    for (const p of store.profiles) index(p);
    return {
        index,
        linked: ref => byRef.get(ref)?.find(p => p.stRef && refKey(p.stRef) === ref),
        pair: (key, url) => findProfileByPair(byKey.get(key?.trim()) || [], key, url),
    };
}

function mergeExtRefs(current, incoming) {
    const map = new Map(current.map(r => [extRefId(r), r]));
    // A note the user gave a place is kept when a later scan finds it again.
    for (const r of incoming) map.set(extRefId(r), { ...r, alias: map.get(extRefId(r))?.alias || r.alias || '' });
    return [...map.values()];
}

/** An extension settings location belongs to exactly one profile; take it away from the others. */
function claimExtRefs(owner, refs) {
    if (!refs?.length) return;
    const ids = new Set(refs.map(extRefId));
    for (const o of store.profiles) {
        if (o.id === owner.id) continue;
        const kept = o.extRefs.filter(r => !ids.has(extRefId(r)));
        if (kept.length !== o.extRefs.length) o.extRefs = kept;
    }
}

/**
 * Links every place in other extensions' settings that holds this profile's key (and address),
 * so a later key change in the vault is written there too. Runs after a fill: the plugin has
 * saved what was typed into its field by then. Returns how many new places were linked.
 */
export function linkExtensionsFor(profileId, candidates) {
    const p = store.get(profileId);
    if (!p?.key) return 0;
    const known = new Set(p.extRefs.map(extRefId));
    const fresh = [];
    for (const s of candidates ?? scanExtensionSettings(ctx.extensionSettings)) {
        if (s.key !== p.key || (s.url && p.url && !sameUrl(s.url, p.url))) continue;
        for (const r of s.refs) if (!known.has(extRefId(r))) fresh.push(r);
    }
    if (!fresh.length) return 0;
    claimExtRefs(p, fresh);
    p.extRefs = mergeExtRefs(p.extRefs, fresh);
    store.save();
    return fresh.length;
}

/** Names the user gave in ST's Connection Manager, keyed by the secret id a profile points at. */
function connectionProfileNames() {
    const map = new Map();
    for (const cp of ctx.extensionSettings?.connectionManager?.profiles || []) {
        const id = cp?.['secret-id'];
        if (id && cp.name && !map.has(id)) map.set(id, { name: String(cp.name), url: String(cp['api-url'] || '') });
    }
    return map;
}

/** Everything importable right now: ST secrets, proxy presets, and URL/key pairs in other extensions. */
export async function collectCandidates({ state, extensions, presets } = {}) {
    const canView = state !== null && await st.canView();
    const items = [];
    const cm = connectionProfileNames();

    // A masked group is a display group only. Keep each id independently selectable.
    const groups = new Map();
    for (const c of state === null ? [] : await st.candidates(state)) {
        const raw = canView && !c.value.includes('*') ? c.value : '';
        const url = urlIdentity(cm.get(c.id)?.url || c.url);
        const id = JSON.stringify([c.key, url, raw ? 'exact' : 'mask', raw || c.value]);
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(c);
    }
    const lookup = importIndex();
    const pick = list => list.find(c => lookup.linked(refKey(c))) || list.find(c => c.active)
        || list.find(c => niceLabel(c.label)) || list[0];
    const addSecret = (c, list, choiceGroup = null) => {
        const raw = canView && !c.value.includes('*') ? c.value : '';
        const named = cm.get(c.id);
        const realName = niceLabel(c.label) || named?.name || '';
        const item = {
            ref: `${c.key}:${c.id}`,
            source: ST_SOURCE,
            provider: c.name,
            name: realName || c.name,
            realName,
            label: c.label,
            url: named?.url || c.url || '',
            key: raw,
            keyHint: c.value,
            stRef: { key: c.key, id: c.id },
            proxyRef: null,
            extRefs: [],
            active: list.some(x => x.active),
            copies: list.length,
            sourceRefs: list.map(refKey),
            choiceGroup,
        };
        item.existing = lookup.linked(item.ref) || (raw && lookup.pair(raw, item.url)) || null;
        items.push(item);
    };
    for (const list of groups.values()) {
        const c = pick(list);
        if (list.length > 1 && !(canView && c.value && !c.value.includes('*'))) {
            const choiceGroup = items.length;
            for (const member of list) addSecret(member, [member], choiceGroup);
        } else {
            addSecret(c, list);
        }
    }

    try {
        const selected = presets ? presets.selected : await proxy.selectedName();
        for (const pr of (presets ? presets.list || [] : await proxy.list())) {
            const hash = proxyHash(pr.url, pr.password);
            items.push({
                ref: `proxy:${hash}`,
                source: PROXY_SOURCE,
                provider: '代理预设',
                name: pr.name,
                realName: pr.name,
                url: pr.url,
                key: pr.password,
                keyHint: '',
                stRef: null,
                proxyRef: { name: pr.name, hash },
                extRefs: [],
                active: pr.name === selected,
                existing: store.profiles.find(p => p.proxyRef?.name === pr.name)
                    || store.profiles.find(p => p.proxyRef?.hash === hash)
                    || lookup.pair(pr.password, pr.url),
            });
        }
    } catch (err) {
        console.warn('[API Vault] proxy preset scan failed', err);
    }

    try {
        for (const s of extensions ?? scanExtensionSettings(ctx.extensionSettings)) {
            items.push({
                ref: extImportRef(s.source, s.key, s.url),
                source: s.source,
                provider: s.source,
                name: s.name,
                realName: s.label,
                url: s.url,
                key: s.key,
                keyHint: '',
                stRef: null,
                proxyRef: null,
                extRefs: s.refs,
                existing: lookup.pair(s.key, s.url),
            });
        }
    } catch (err) {
        console.warn('[API Vault] extension settings scan failed', err);
    }

    const removed = new Set(store.settings.removedRefs);
    const seen = new Set(store.settings.seenRefs);
    for (const it of items) {
        it.sourceRefs ??= [it.ref];
        it.removed = !it.existing && it.sourceRefs.some(r => removed.has(r) || seen.has(r));
    }
    return { canView, items };
}

/** Imports candidates. Ones that match an existing profile only fill its gaps, so nothing is duplicated. */
export function importItems(items) {
    return store.batch(() => applyImport(items));
}

function applyImport(items) {
    const lookup = importIndex();
    const seen = new Set(store.settings.seenRefs);
    const removed = new Set(store.settings.removedRefs);
    let added = 0;
    let linked = 0;

    for (const it of items) {
        const sourceRefs = it.sourceRefs || [it.ref];
        for (const r of sourceRefs) {
            seen.add(r);
            removed.delete(r);
        }
        // Earlier items in this same batch may already have created or completed a profile.
        const p = (it.stRef && lookup.linked(refKey(it.stRef)))
            || (it.proxyRef && store.profiles.find(p => p.proxyRef?.name === it.proxyRef.name || p.proxyRef?.hash === it.proxyRef.hash))
            || lookup.pair(it.key, it.url);
        if (p) {
            const patch = { id: p.id };
            const knownRefs = new Set(p.importRefs);
            if (sourceRefs.some(r => !knownRefs.has(r))) patch.importRefs = [...new Set([...knownRefs, ...sourceRefs])];
            if (it.stRef && (!p.stRef || p.stMissing)) {
                patch.stRef = it.stRef;
                patch.stLabel = it.label || '';
                patch.stMissing = false;
                if (p.key) patch.syncedHash = hashKey(p.key);
            }
            if (it.proxyRef && (!p.proxyRef || p.proxyMissing)) {
                patch.proxyRef = it.proxyRef;
                patch.proxyMissing = false;
            }
            const refs = mergeExtRefs(p.extRefs, it.extRefs || []);
            if (JSON.stringify(refs) !== JSON.stringify(p.extRefs)) patch.extRefs = refs;
            if (!p.key && it.key) patch.key = it.key;
            if (!p.keyHint && it.keyHint) patch.keyHint = it.keyHint;
            if (!p.url && it.url) patch.url = it.url;
            // A name the user actually typed somewhere beats a host name or extension id.
            if (p.nameAuto && it.realName && it.realName !== p.name) {
                patch.name = it.realName;
                patch.nameAuto = false;
            }
            claimExtRefs(p, it.extRefs);
            if (Object.keys(patch).length > 1) {
                store.upsert(patch);
                lookup.index(p, !!patch.key, !!patch.stRef);
                linked++;
            }
            continue;
        }
        const created = store.upsert({
            name: it.name,
            nameAuto: !it.realName,
            url: it.url,
            key: it.key,
            keyHint: it.keyHint,
            stRef: it.stRef,
            importRefs: sourceRefs,
            stLabel: it.label || '',
            proxyRef: it.proxyRef,
            // Empty = "用于酒馆" goes through a proxy preset. Masked-only secrets fall back to their slot in syncToST.
            syncTarget: '',
            syncedHash: it.key && it.stRef ? hashKey(it.key) : '',
            extRefs: it.extRefs || [],
            // Only "酒馆" / "反向代理" make useful tags; a plugin's settings id ("st-chatu8") does not.
            tags: [ST_SOURCE, PROXY_SOURCE].includes(it.source) ? [it.source] : [],
        });
        claimExtRefs(created, it.extRefs);
        lookup.index(created);
        added++;
    }

    store.settings.seenRefs = [...seen];
    store.settings.removedRefs = [...removed];
    store.save();
    return { added, linked };
}

/** Imports only what has never been looked at, so profiles the user deleted stay deleted. */
export async function autoImport({ silent = false, sources } = {}) {
    if (Date.now() < busyUntil) {
        scheduleSync({ secrets: sources?.state !== null, discover: true });
        return;
    }
    const { items } = await collectCandidates(sources);
    if (!store.options.autoImport) return;
    const seen = new Set(store.settings.seenRefs);
    const removed = new Set(store.settings.removedRefs);
    const owners = new Map();
    for (const p of store.profiles) for (const r of p.extRefs) owners.set(extRefId(r), p);
    const fresh = [];
    for (const it of items) {
        if (it.choiceGroup != null || it.removed || it.sourceRefs.some(r => removed.has(r))) continue;
        // An explicit fill may have assigned a matching location to a different profile with the same key.
        const unlinked = it.extRefs.filter(r => {
            const owner = owners.get(extRefId(r));
            return !owner || owner.key !== it.key || (owner.url && it.url && !sameUrl(owner.url, it.url));
        });
        if (it.sourceRefs.some(r => !seen.has(r)) || (it.existing && unlinked.length)) {
            fresh.push({ ...it, extRefs: unlinked });
        }
    }
    if (!fresh.length) return;
    const { added } = importItems(fresh);
    if (added && !silent) {
        toastr.info(`已从酒馆读取 ${added} 个 API 配置`, '通用钥匙API管理器', { timeOut: 2500 });
    }
}

/** Merge bursts of host events. A later settings save must not cancel a pending secret refresh. */
export function scheduleSync({ secrets = false, discover = false, delay = 800 } = {}) {
    pendingSync = { secrets: secrets || !!pendingSync?.secrets, discover: discover || !!pendingSync?.discover };
    clearTimeout(syncTimer);
    if (!syncRunning) syncTimer = setTimeout(runScheduledSync, delay);
}

async function runScheduledSync() {
    const job = pendingSync;
    pendingSync = null;
    syncRunning = true;
    try {
        const needsSecrets = job.secrets || retrySecretRead;
        const state = needsSecrets ? await st.state().catch(() => null) : null;
        retrySecretRead = needsSecrets && state === null;
        const presets = { list: await proxy.list().catch(() => null), selected: await proxy.selectedName().catch(() => '') };
        const sources = { state, presets, extensions: scanExtensionSettings(ctx.extensionSettings) };
        if (job.discover && store.options.autoImport) {
            if (Date.now() < busyUntil) scheduleSync(job);
            else await autoImport({ sources });
        }
        await reconcile(sources);
        await discoverForCapture(sources);
    } catch (err) {
        console.warn('[API Vault] background sync failed', err);
    } finally {
        syncRunning = false;
        if (pendingSync) syncTimer = setTimeout(runScheduledSync, Math.max(800, busyUntil - Date.now()));
    }
}

// ---------- ST / extensions -> vault ----------

/** Follows proxy presets edited, renamed or deleted in ST. Returns true if a profile changed. */
async function reconcileProxies(snapshot) {
    const presets = snapshot ? snapshot.list : await proxy.list().catch(() => null);
    if (!presets) return false;
    activeProxy = snapshot ? snapshot.selected : await proxy.selectedName().catch(() => '');
    let changed = false;
    const byName = new Map(presets.map(x => [x.name, x]));
    const taken = n => store.profiles.some(o => o.proxyRef?.name === n);

    for (const p of store.profiles) {
        if (!p.proxyRef) continue;
        let pr = byName.get(p.proxyRef.name);
        if (!pr) {
            // Gone under its old name: if the same URL + password sits under a new name, it was renamed in ST.
            pr = presets.find(x => proxyHash(x.url, x.password) === p.proxyRef.hash && !taken(x.name));
            if (pr) {
                if (p.nameAuto || p.name === p.proxyRef.name) {
                    p.name = pr.name;
                    p.nameAuto = false;
                }
                p.proxyRef = { ...p.proxyRef, name: pr.name };
                changed = true;
            }
        }
        if (!pr) {
            if (!p.proxyMissing) {
                p.proxyMissing = true;
                changed = true;
            }
            continue;
        }
        if (p.proxyMissing) {
            p.proxyMissing = false;
            changed = true;
        }
        const hash = proxyHash(pr.url, pr.password);
        // Vault edits update the stored hash when they are pushed, so a mismatch means ST changed it.
        if (hash !== p.proxyRef.hash) {
            if (p.url !== pr.url || p.key !== pr.password) {
                p.health = null;
                p.models = [];
                p.modelsAt = 0;
            }
            p.url = pr.url;
            p.key = pr.password;
            p.proxyRef = { name: pr.name, hash };
            changed = true;
        }
    }
    return changed;
}

/** A linked setting is writable only while both credentials still match its baseline. */
function extensionRefMatches(p, r) {
    const value = readAt(ctx.extensionSettings, r.segs, r.keyProp);
    if (typeof value !== 'string' || (hashKey(value.trim()) !== r.hash && value.trim() !== p.key)) return false;
    if (!r.urlProp) return true;
    const url = readAt(ctx.extensionSettings, r.segs, r.urlProp);
    return typeof url === 'string' && urlIdentity(url) === urlIdentity(r.urlSeen ?? p.url);
}

/**
 * Follows changes made on the ST side: secrets deleted or renamed in ST's key manager,
 * the active key switched, proxy presets edited, and extensions overwriting a key or name the vault linked to.
 * Idempotent, and only saves when something actually changed, so it can run on every settings event.
 */
export async function reconcile({ state: snapshot, presets, extensions } = {}) {
    let changed = false;
    let activeChanged = false;
    const previousProxy = activeProxy;

    const state = snapshot === undefined ? await st.state().catch(() => null) : snapshot;
    if (state) {
        const current = new Set();
        const byRef = new Map();
        for (const [key, list] of Object.entries(state)) {
            if (!Array.isArray(list)) continue;
            for (const s of list) {
                byRef.set(`${key}:${s.id}`, s);
                if (s.active) current.add(`${key}:${s.id}`);
            }
        }
        activeChanged = current.size !== activeRefs.size || [...current].some(id => !activeRefs.has(id));
        if (activeChanged) {
            activeRefs.clear();
            for (const id of current) activeRefs.add(id);
        }
        for (const p of store.profiles) {
            if (!p.stRef) continue;
            const s = byRef.get(refKey(p.stRef));
            if (!s) {
                if (!p.stMissing) {
                    p.stMissing = true;
                    p.health = null;
                    p.models = [];
                    p.modelsAt = 0;
                    changed = true;
                }
                continue;
            }
            if (p.stMissing) {
                p.stMissing = false;
                p.health = null;
                p.models = [];
                p.modelsAt = 0;
                changed = true;
            }
            // Renamed in ST's own key manager: adopt the new label as the profile name.
            if ((s.label || '') !== p.stLabel) {
                if (niceLabel(s.label) && (p.stLabel || p.nameAuto)) {
                    p.name = s.label;
                    p.nameAuto = false;
                }
                p.stLabel = s.label || '';
                changed = true;
            }
            if (s.value && s.value !== p.keyHint) {
                p.keyHint = s.value;
                changed = true;
            }
        }
    }

    if (await reconcileProxies(presets)) changed = true;
    const usingProxy = !!(activeProxy || activeRefs.size) && !!st.proxyInUse();
    activeChanged ||= activeProxy !== previousProxy || usingProxy !== proxyInUse;
    proxyInUse = usingProxy;

    for (const p of store.profiles) {
        if (!p.extRefs.length) continue;
        const kept = p.extRefs.filter(r => {
            // External URL/key edits detach the old link instead of being overwritten later.
            if (!extensionRefMatches(p, r)) return false;
            if (r.urlProp && r.urlSeen === undefined) {
                r.urlSeen = readAt(ctx.extensionSettings, r.segs, r.urlProp);
                changed = true;
            }
            return true;
        });
        for (const r of kept) {
            if (!r.nameProp) continue;
            const n = readAt(ctx.extensionSettings, r.segs, r.nameProp);
            if (typeof n !== 'string' || n.trim() === r.nameSeen) continue;
            // Renamed inside the extension: follow it unless the user named the profile differently here.
            if (n.trim() && (p.nameAuto || p.name === r.nameSeen)) {
                p.name = n.trim();
                p.nameAuto = false;
            }
            r.nameSeen = n.trim();
            changed = true;
        }
        if (kept.length !== p.extRefs.length) {
            p.extRefs = kept;
            changed = true;
        }
    }

    // Scripts that read a saved key from their own settings never show a field to fill; link them too.
    const claimed = new Set();
    for (const p of store.profiles) for (const r of p.extRefs) claimed.add(extRefId(r));
    const byKey = new Map();
    for (const s of extensions ?? scanExtensionSettings(ctx.extensionSettings)) {
        if (!byKey.has(s.key)) byKey.set(s.key, []);
        byKey.get(s.key).push(s);
    }
    // Preserve the existing owner. When several profiles first match a location, use the
    // same final owner as the old forward scan, without repeatedly moving it and saving.
    for (let i = store.profiles.length - 1; i >= 0; i--) {
        const p = store.profiles[i];
        const fresh = [];
        for (const s of byKey.get(p.key) || []) {
            if (s.url && p.url && !sameUrl(s.url, p.url)) continue;
            for (const r of s.refs) {
                const id = extRefId(r);
                if (claimed.has(id)) continue;
                claimed.add(id);
                fresh.push(r);
            }
        }
        if (fresh.length) {
            p.extRefs = mergeExtRefs(p.extRefs, fresh);
            changed = true;
        }
    }

    if (changed) store.save();
    else if (activeChanged) store.notify();
}

// ---------- vault -> ST / extensions ----------

/** Writes the profile's current key / URL / name into every extension setting it is linked to. */
function pushToExtensions(p) {
    if (!p.key || !p.extRefs.length) return 0;
    const hash = hashKey(p.key);
    const set = (r, prop, value) => {
        const cur = readAt(ctx.extensionSettings, r.segs, prop);
        return typeof cur === 'string' && cur.trim() !== value && writeAt(ctx.extensionSettings, r.segs, prop, value);
    };
    let n = 0;
    // Recheck after async ST/proxy writes, which may have allowed another extension to edit settings.
    p.extRefs = p.extRefs.filter(r => extensionRefMatches(p, r));
    for (const r of p.extRefs) {
        if (typeof readAt(ctx.extensionSettings, r.segs, r.keyProp) !== 'string') continue;
        let touched = set(r, r.keyProp, p.key);
        if (r.urlProp && p.url && set(r, r.urlProp, p.url)) touched = true;
        // Only names the user set; a host-derived name should not overwrite a channel name.
        if (r.nameProp && !p.nameAuto && set(r, r.nameProp, p.name)) {
            r.nameSeen = p.name;
            touched = true;
        }
        r.hash = hash;
        if (r.urlProp) r.urlSeen = readAt(ctx.extensionSettings, r.segs, r.urlProp);
        if (touched) n++;
    }
    if (n) ctx.saveSettingsDebounced();
    return n;
}

/** Writes URL, password and name back into the linked ST proxy preset. */
async function pushToProxy(p) {
    if (!p.proxyRef || p.proxyMissing) return false;
    const current = (await proxy.list()).find(pr => pr.name === p.proxyRef.name);
    if (!current) throw new Error('关联的代理预设已不存在，请刷新酒馆页面后再应用');
    if (proxyHash(current.url, current.password) !== p.proxyRef.hash) {
        throw new Error('酒馆里的代理地址或密钥已经变化，请刷新酒馆页面并确认最新配置后再应用');
    }
    const hash = proxyHash(p.url, p.key);
    if (hash === p.proxyRef.hash && p.name === p.proxyRef.name) return false;
    const r = await proxy.update(p.proxyRef.name, { name: p.name, url: p.url, password: p.key });
    if (!r) throw new Error('无法更新关联的代理预设，配置尚未应用');
    p.proxyRef = { name: r.name, hash: proxyHash(r.url, r.password) };
    return true;
}

/** Replaces the linked ST secret with the profile's new key, keeping ST's active choice as it was. */
async function pushKeyToST(p) {
    const { key: slot, id: oldId } = p.stRef;
    const wasActive = activeRefs.has(refKey(p.stRef));
    busyUntil = Date.now() + 3000;
    // The new key is already in the slot: link to that copy instead of adding a duplicate.
    const same = await st.findSame(slot, p.key);
    requireLiveProfile(p);
    if (same && same.id !== oldId) {
        // The old copy is left in ST: a Connection Manager profile may still point at it.
        if (wasActive && !same.active) await st.rotate(slot, same.id);
        p.stRef = { key: slot, id: same.id };
        p.stLabel = same.label || '';
        p.syncedHash = hashKey(p.key);
        return;
    }
    const newId = await st.write(slot, p.key, p.name);
    if (!newId) throw new Error('酒馆没有接受新的密钥');
    requireLiveProfile(p, slot + ':' + newId);
    store.settings.seenRefs.push(`${slot}:${newId}`);
    // writeSecret activates the new value; put ST's previous active key back if this one was not it.
    const prevActive = !wasActive && [...activeRefs].find(r => r.startsWith(`${slot}:`));
    await st.remove(slot, oldId);
    if (prevActive) await st.rotate(slot, prevActive.slice(slot.length + 1));
    p.stRef = { key: slot, id: newId };
    p.stLabel = p.name;
    p.syncedHash = hashKey(p.key);
}

/**
 * Pushes an edited profile out to ST and linked extensions.
 * @returns {Promise<string[]>} human-readable list of what was updated
 */
export async function pushProfile(profile, { isNew = false } = {}) {
    if (!store.get(profile.id) || !store.options.autoSync) return [];
    // Fresh view of ST first, so we know which key is active and whether ours still exists.
    await reconcile().catch(err => console.warn('[API Vault] reconcile failed', err));
    const p = store.get(profile.id);
    if (!p) return [];
    const done = [];

    // A profile created here shows up in ST's proxy preset list, where relays normally live.
    if (isNew && p.url && !p.proxyRef && !p.syncTarget) {
        busyUntil = Date.now() + 3000;
        const name = await linkNewProxy(p);
        if (name) done.push(`酒馆的代理预设「${name}」`);
    }

    if (p.stRef && !p.stMissing) {
        const keyChanged = p.key && p.syncedHash !== hashKey(p.key) && p.stRef.key === (p.syncTarget || p.stRef.key);
        if (keyChanged) {
            await pushKeyToST(p);
            done.push(`酒馆「${st.providerName(p.stRef.key)}」的密钥`);
        } else if (p.name !== p.stLabel) {
            await st.rename(p.stRef.key, p.stRef.id, p.name);
            p.stLabel = p.name;
            done.push('酒馆里的名称');
        }
        if (p.stRef.key === 'api_key_custom' && p.url && isActiveInST(p)) st.setCustomUrl(p.url);
    }

    busyUntil = Date.now() + 3000;
    if (await pushToProxy(p)) done.push(`酒馆的代理预设「${p.proxyRef.name}」`);

    const n = pushToExtensions(p);
    if (n) done.push(`${n} 个扩展的设置`);

    // Editing the model of the profile ST is using right now switches ST's model as well.
    if (p.model && isActiveInST(p) && st.currentModel() !== p.model && st.applyModel(p.model)) {
        done.push('酒馆当前的模型');
    }

    store.save();
    await reconcile();
    return done;
}

/**
 * Makes the profile what ST uses: selects its proxy preset, or makes it the active key of its
 * secret slot (reusing the stored secret when the key has not changed, otherwise writing a new one).
 * @returns {Promise<string>} friendly name of what ST now uses it for
 */
export async function syncToST(profile, target, { remember = true } = {}) {
    const p = store.get(profile.id) || profile;
    requireLiveProfile(p);
    // A key imported from secrets.json with only a mask cannot become a proxy preset; switch its slot instead.
    const maskedOnly = !p.key && p.stRef && !p.stMissing ? p.stRef.key : '';
    // ST on "自定义（兼容 OpenAI）": fill its own URL + key there and keep the source, rather than switching
    // ST to OpenAI just to use a proxy preset. Only for the default route; an explicit slot choice still wins.
    const followCustom = !target && !p.syncTarget && p.key && p.url ? st.keepsOwnUrl() : '';
    const slotTarget = target || (p.syncTarget && p.syncTarget !== 'none' ? p.syncTarget : '') || maskedOnly || followCustom;

    // Default: use it through a reverse proxy preset, which is how relays are set up in ST.
    // Only an explicitly chosen secret slot (advanced) goes into secrets.json.
    if (!slotTarget) {
        if (!p.url) throw new Error('这个配置没有填地址，没法设成反向代理');
        busyUntil = Date.now() + 3000;
        if (!p.proxyRef || p.proxyMissing) {
            const live = store.get(p.id);
            if (!(await linkNewProxy(live || p))) throw new Error('没能在酒馆里创建代理预设，先打开一次 API 连接面板');
            store.save();
        }
        // Explicit application must use the current profile even when automatic sync is off.
        if (await pushToProxy(p)) store.save();
        st.ensureProxySource();
        if (!(await proxy.select(p.proxyRef.name))) throw new Error('酒馆的代理预设下拉框还没加载，先打开一次 API 连接面板');
        // Switching the preset only changes URL + password; the model dropdown has to be set too.
        if (p.model) st.applyModel(p.model);
        store.touch(p.id);
        await reconcile();
        return `代理预设「${p.proxyRef.name}」`;
    }

    const slot = slotTarget;
    busyUntil = Date.now() + 3000;
    const key = await resolveKey(p);
    const linked = p.stRef?.key === slot && !p.stMissing;
    // A pick into ST's own key box is a one-off: the profile's "在酒馆里怎么用" choice stays as it was.
    const syncTarget = remember && !followCustom ? slot : p.syncTarget;
    const unchanged = linked && (!key || p.syncedHash === hashKey(key));

    // The same key may already be stored in this slot (saved by ST's own Connect, another profile, or an
    // earlier switch). Reuse it: writing again only adds another identical row to ST's key list.
    const same = !unchanged && key ? await st.findSame(slot, key) : null;
    requireLiveProfile(p);

    if (unchanged) {
        await st.rotate(p.stRef.key, p.stRef.id);
    } else if (same) {
        if (!same.active) await st.rotate(slot, same.id);
        requireLiveProfile(p, slot + ':' + same.id);
        store.upsert({ id: p.id, syncTarget, stLabel: same.label || '', stMissing: false });
        store.markSynced(p.id, { key: slot, id: same.id });
        if (!store.settings.seenRefs.includes(`${slot}:${same.id}`)) store.settings.seenRefs.push(`${slot}:${same.id}`);
    } else if (key) {
        const id = await st.write(slot, key, p.name);
        if (!id) throw new Error('酒馆没有接受这个密钥');
        requireLiveProfile(p, slot + ':' + id);
        // The old copy of this profile in the same slot is now stale.
        if (linked) await st.remove(slot, p.stRef.id).catch(() => {});
        requireLiveProfile(p, slot + ':' + id);
        store.upsert({ id: p.id, syncTarget, stLabel: p.name, stMissing: false });
        store.markSynced(p.id, { key: slot, id });
        store.settings.seenRefs.push(`${slot}:${id}`);
    } else {
        throw new Error('只有掩码，没有密钥原文，无法写入酒馆');
    }

    if (slot === 'api_key_custom' && p.url) st.setCustomUrl(p.url);
    // An explicit "用于酒馆" must leave ST sending through this slot; a pick into ST's own key box is already there.
    const switched = remember ? st.useSlot(slot) : '';
    if (p.model) st.applyModel(p.model);
    store.touch(p.id);
    await reconcile();
    return switched ? `${st.providerName(slot)}（已自动${switched}）` : st.providerName(slot);
}
