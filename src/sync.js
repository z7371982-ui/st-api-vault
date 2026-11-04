// Two-way sync between the vault and SillyTavern.
//   ST / extensions -> vault: import what they store, follow renames, deletions and key changes.
//   vault -> ST / extensions: push edited keys, URLs and names back to every linked place.
import { store } from './store.js';
import { st } from './st.js';
import { scanExtensionSettings, readAt, writeAt } from './scan.js';
import { hashKey, findProfileByKey, maskMatches, extRefId } from './vault.js';

const ST_SOURCE = '酒馆';
// ST labels new secrets with a timestamp; those make poor profile names.
const DATE_LABEL = /^\d{1,4}[/.\-年]\d{1,2}/;

let ctx = null;
let busyUntil = 0;
let importTimer = null;
let reconcileTimer = null;
// Runtime only: "<slot>:<id>" of secrets ST currently uses.
const activeRefs = new Set();

export function initSync(context) {
    ctx = context;
}

const refKey = r => `${r.key}:${r.id}`;
const niceLabel = l => (l && !DATE_LABEL.test(l) ? l : '');

export function isActiveInST(p) {
    return !!p.stRef && !p.stMissing && activeRefs.has(refKey(p.stRef));
}

/** Raw key for a profile, fetched from ST (and cached) when only a masked copy is known. */
export async function resolveKey(profile) {
    const p = store.get(profile.id) || profile;
    if (p.key) return p.key;
    if (!p.stRef || p.stMissing) return '';
    const value = await st.find(p.stRef.key, p.stRef.id);
    if (value && !value.includes('*')) {
        if (store.get(p.id)) store.upsert({ id: p.id, key: value, syncedHash: hashKey(value) });
        return value;
    }
    return '';
}

function matchExisting(candidate, raw) {
    const { key, id } = candidate.stRef;
    return store.profiles.find(p => p.stRef?.key === key && p.stRef?.id === id)
        || (raw
            ? findProfileByKey(store.profiles, raw)
            : store.profiles.find(p => !p.stRef && (!p.syncTarget || p.syncTarget === key) && maskMatches(p.key, candidate.keyHint)))
        || null;
}

function mergeExtRefs(current, incoming) {
    const map = new Map(current.map(r => [extRefId(r), r]));
    for (const r of incoming) map.set(extRefId(r), r);
    return [...map.values()];
}

/** Everything importable right now: ST secrets plus URL/key pairs found in other extensions' settings. */
export async function collectCandidates() {
    const canView = await st.canView();
    const items = [];

    for (const c of await st.candidates()) {
        const raw = canView && !c.value.includes('*') ? c.value : '';
        const item = {
            ref: `${c.key}:${c.id}`,
            source: ST_SOURCE,
            provider: c.name,
            name: niceLabel(c.label) || c.name,
            label: c.label,
            url: c.url,
            key: raw,
            keyHint: c.value,
            stRef: { key: c.key, id: c.id },
            extRefs: [],
            active: c.active,
        };
        item.existing = matchExisting(item, raw);
        items.push(item);
    }

    try {
        for (const s of scanExtensionSettings(ctx.extensionSettings)) {
            items.push({
                ref: `ext:${s.source}:${hashKey(s.key)}`,
                source: s.source,
                provider: s.source,
                name: s.name,
                url: s.url,
                key: s.key,
                keyHint: '',
                stRef: null,
                extRefs: s.refs,
                existing: findProfileByKey(store.profiles, s.key),
            });
        }
    } catch (err) {
        console.warn('[API Vault] extension settings scan failed', err);
    }

    return { canView, items };
}

/** Imports candidates. Ones that match an existing profile only fill its gaps, so nothing is duplicated. */
export function importItems(items) {
    const seen = new Set(store.settings.seenRefs);
    let added = 0;
    let linked = 0;

    for (const it of items) {
        seen.add(it.ref);
        const p = it.existing && store.get(it.existing.id);
        if (p) {
            const patch = { id: p.id };
            if (it.stRef && (!p.stRef || p.stMissing)) {
                patch.stRef = it.stRef;
                patch.stLabel = it.label || '';
                patch.stMissing = false;
                patch.syncTarget = p.syncTarget || it.stRef.key;
                if (p.key) patch.syncedHash = hashKey(p.key);
            }
            const refs = mergeExtRefs(p.extRefs, it.extRefs || []);
            if (refs.length !== p.extRefs.length) patch.extRefs = refs;
            if (!p.key && it.key) patch.key = it.key;
            if (!p.keyHint && it.keyHint) patch.keyHint = it.keyHint;
            if (!p.url && it.url) patch.url = it.url;
            if (Object.keys(patch).length > 1) {
                store.upsert(patch);
                linked++;
            }
            continue;
        }
        store.upsert({
            name: it.name,
            url: it.url,
            key: it.key,
            keyHint: it.keyHint,
            stRef: it.stRef,
            stLabel: it.label || '',
            syncTarget: it.stRef?.key || '',
            syncedHash: it.key && it.stRef ? hashKey(it.key) : '',
            extRefs: it.extRefs || [],
            tags: [it.source],
        });
        added++;
    }

    store.settings.seenRefs = [...seen].slice(-500);
    store.save();
    return { added, linked };
}

/** Imports only what has never been looked at, so profiles the user deleted stay deleted. */
export async function autoImport({ silent = false } = {}) {
    if (Date.now() < busyUntil) {
        scheduleImport();
        return;
    }
    const { items } = await collectCandidates();
    const seen = new Set(store.settings.seenRefs);
    // Known keys showing up in new extension locations are linked even if the ref was seen before.
    // Only genuinely new locations count, otherwise every settings save would re-import and save again.
    const hasNewRef = it => {
        const p = it.existing && store.get(it.existing.id);
        if (!p || !it.extRefs?.length) return false;
        const known = new Set(p.extRefs.map(extRefId));
        return it.extRefs.some(r => !known.has(extRefId(r)));
    };
    const fresh = items.filter(it => !seen.has(it.ref) || hasNewRef(it));
    if (!fresh.length) return;
    const { added } = importItems(fresh);
    if (added && !silent) {
        toastr.info(`已从酒馆读取 ${added} 个 API 配置`, 'API 管理器', { timeOut: 2500 });
    }
}

/** Debounced import, used when ST reports a newly written secret. */
export function scheduleImport() {
    clearTimeout(importTimer);
    importTimer = setTimeout(() => autoImport().catch(err => console.warn('[API Vault] import failed', err)), 1000);
}

// ---------- ST / extensions -> vault ----------

/**
 * Follows changes made on the ST side: secrets deleted or renamed in ST's key manager,
 * the active key switched, and extensions overwriting a key the vault linked to.
 * Idempotent, and only saves when something actually changed, so it can run on every settings event.
 */
export async function reconcile() {
    let changed = false;

    const state = await st.state().catch(() => null);
    if (state) {
        activeRefs.clear();
        const byRef = new Map();
        for (const [key, list] of Object.entries(state)) {
            if (!Array.isArray(list)) continue;
            for (const s of list) {
                byRef.set(`${key}:${s.id}`, s);
                if (s.active) activeRefs.add(`${key}:${s.id}`);
            }
        }
        for (const p of store.profiles) {
            if (!p.stRef) continue;
            const s = byRef.get(refKey(p.stRef));
            if (!s) {
                if (!p.stMissing) {
                    p.stMissing = true;
                    changed = true;
                }
                continue;
            }
            if (p.stMissing) {
                p.stMissing = false;
                changed = true;
            }
            // Renamed in ST's own key manager: adopt the new label as the profile name.
            if ((s.label || '') !== p.stLabel) {
                if (niceLabel(s.label) && p.stLabel) p.name = s.label;
                p.stLabel = s.label || '';
                changed = true;
            }
            if (s.value && s.value !== p.keyHint) {
                p.keyHint = s.value;
                changed = true;
            }
        }
    }

    for (const p of store.profiles) {
        if (!p.extRefs.length) continue;
        const kept = p.extRefs.filter(r => {
            const v = readAt(ctx.extensionSettings, r.segs, r.keyProp);
            // Path gone, or the extension now holds a different key it got elsewhere: unlink.
            // A brand-new key there is picked up by the next import as its own profile.
            if (typeof v !== 'string') return false;
            const h = hashKey(v.trim());
            return h === r.hash || (p.key && v.trim() === p.key);
        });
        if (kept.length !== p.extRefs.length) {
            p.extRefs = kept;
            changed = true;
        }
    }

    if (changed) store.save();
    else store.notify();
}

export function scheduleReconcile(delay = 800) {
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => reconcile().catch(err => console.warn('[API Vault] reconcile failed', err)), delay);
}

// ---------- vault -> ST / extensions ----------

/** Writes the profile's current key / URL into every extension setting it is linked to. */
function pushToExtensions(p) {
    if (!p.key || !p.extRefs.length) return 0;
    const hash = hashKey(p.key);
    let n = 0;
    for (const r of p.extRefs) {
        const cur = readAt(ctx.extensionSettings, r.segs, r.keyProp);
        if (typeof cur !== 'string') continue;
        let touched = false;
        if (cur.trim() !== p.key && writeAt(ctx.extensionSettings, r.segs, r.keyProp, p.key)) touched = true;
        if (r.urlProp && p.url) {
            const curUrl = readAt(ctx.extensionSettings, r.segs, r.urlProp);
            if (typeof curUrl === 'string' && curUrl.trim() !== p.url && writeAt(ctx.extensionSettings, r.segs, r.urlProp, p.url)) touched = true;
        }
        r.hash = hash;
        if (touched) n++;
    }
    if (n) ctx.saveSettingsDebounced();
    return n;
}

/** Replaces the linked ST secret with the profile's new key, keeping ST's active choice as it was. */
async function pushKeyToST(p) {
    const { key: slot, id: oldId } = p.stRef;
    const wasActive = activeRefs.has(refKey(p.stRef));
    busyUntil = Date.now() + 3000;
    const newId = await st.write(slot, p.key, p.name);
    if (!newId) throw new Error('酒馆没有接受新的密钥');
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
export async function pushProfile(profile) {
    if (!store.get(profile.id) || !store.options.autoSync) return [];
    // Fresh view of ST first, so we know which key is active and whether ours still exists.
    await reconcile().catch(err => console.warn('[API Vault] reconcile failed', err));
    const p = store.get(profile.id);
    if (!p) return [];
    const done = [];

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

    const n = pushToExtensions(p);
    if (n) done.push(`${n} 个扩展的设置`);

    store.save();
    await reconcile();
    return done;
}

/**
 * Makes the profile the active key of its ST slot. Reuses the stored secret when the key
 * has not changed, otherwise writes a new one.
 * @returns {Promise<string>} friendly name of the ST slot
 */
export async function syncToST(profile, target) {
    const p = store.get(profile.id) || profile;
    const slot = target || p.syncTarget || st.suggestTarget(p.url);
    busyUntil = Date.now() + 3000;
    const key = await resolveKey(p);
    const linked = p.stRef?.key === slot && !p.stMissing;
    const unchanged = linked && (!key || p.syncedHash === hashKey(key));

    if (unchanged) {
        await st.rotate(p.stRef.key, p.stRef.id);
    } else if (key) {
        const id = await st.write(slot, key, p.name);
        if (!id) throw new Error('酒馆没有接受这个密钥');
        // The old copy of this profile in the same slot is now stale.
        if (linked) await st.remove(slot, p.stRef.id).catch(() => {});
        store.upsert({ id: p.id, syncTarget: slot, stLabel: p.name, stMissing: false });
        store.markSynced(p.id, { key: slot, id });
        store.settings.seenRefs.push(`${slot}:${id}`);
    } else {
        throw new Error('只有掩码，没有密钥原文，无法写入酒馆');
    }

    if (slot === 'api_key_custom' && p.url) st.setCustomUrl(p.url);
    store.touch(p.id);
    await reconcile();
    return st.providerName(slot);
}
