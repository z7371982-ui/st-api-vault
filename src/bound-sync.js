// Explicit fills discover saved credential locations; manual sync never changes ST's active API.
import { store } from './store.js';
import { scanExtensionSettings, readAt, writeAt } from './scan.js';
import { hashKey, urlIdentity } from './vault.js';

let ctx = null, resolving = false;
const pending = new Map(), listed = new Map(), syncing = new Set();
const TTL = 15 * 60 * 1000;
const idOf = r => JSON.stringify([...r.segs, r.keyProp]);
const pairOf = p => ({ hash: p.key ? hashKey(p.key) : '', url: urlIdentity(p.url) });
const versionOf = p => JSON.stringify([p.updatedAt, pairOf(p)]);
const nodeAt = segs => segs.reduce((node, part) => node?.[part], ctx?.extensionSettings);
const hasArray = r => r.segs.some((part, i) => /^\d+$/.test(part) && Array.isArray(nodeAt(r.segs.slice(0, i))));
const identityTag = identity => identity ? JSON.stringify([identity.segs.slice(0, -1), identity.prop, identity.value]) : '';
const copyRef = r => ({ ...r, segs: [...r.segs], ...(r.bindingFps ? { bindingFps: [...r.bindingFps] } : {}),
    ...(r.identity ? { identity: { ...r.identity, segs: [...r.identity.segs] } } : {}) });
const resultItem = (t, reason) => ({ id: t.id, source: t.source, label: t.label, path: t.path, ...(reason ? { reason } : {}) });
const emptyResult = () => ({ updated: [], unchanged: [], skipped: [], failed: [] });
const bindingsOwned = (profileId, fps) => fps.every(fp => store.binding(fp)?.profileId === profileId);

export function initBoundSync(context) {
    ctx = context;
    pending.clear(); listed.clear(); syncing.clear();
}

function identify(r) {
    let minimum = 1;
    r.segs.forEach((part, i) => { if (/^\d+$/.test(part) && Array.isArray(nodeAt(r.segs.slice(0, i)))) minimum = i + 1; });
    for (let size = r.segs.length; size >= minimum; size--) {
        const segs = r.segs.slice(0, size), node = nodeAt(segs);
        if (!node || Array.isArray(node) || typeof node !== 'object') continue;
        for (const prop of ['id', 'uuid', 'uid', 'channelId']) {
            const parent = nodeAt(segs.slice(0, -1));
            if (typeof node[prop] === 'string' && node[prop]
                && (!Array.isArray(parent) || parent.filter(item => item?.[prop] === node[prop]).length === 1)) {
                return { segs, prop, value: node[prop] };
            }
        }
    }
    return undefined;
}

function identityMatches(r) {
    const identity = r.identity;
    return !identity || readAt(ctx?.extensionSettings, identity.segs, identity.prop) === identity.value;
}

export function boundRefIdentityMatches(r) { return !r.manualOnly && identityMatches(r); }

function currentPair(r) {
    const key = readAt(ctx?.extensionSettings, r.segs, r.keyProp);
    if (typeof key !== 'string') return null;
    const url = r.urlProp ? readAt(ctx.extensionSettings, r.segs, r.urlProp) : '';
    return typeof url === 'string' ? { hash: hashKey(key.trim()), url: urlIdentity(url) } : null;
}
const samePair = (a, b) => !!a && !!b && a.hash === b.hash && a.url === b.url;

function scanRefs() {
    if (!ctx?.extensionSettings) return [];
    // Scan rows merge matching credentials; ownership must remain per individual saved location.
    return scanExtensionSettings(ctx.extensionSettings).flatMap(row => row.refs.map(raw => {
        const r = copyRef(raw), identity = identify(r);
        if (identity) r.identity = identity;
        return { id: idOf(r), ref: r, pair: currentPair(r) };
    }));
}

function otherOwner(profileId, r) {
    const id = idOf(r);
    return store.profiles.some(p => p.id !== profileId && p.extRefs.some(other => idOf(other) === id));
}

function attach(p, r, bindingFps = []) {
    const next = { ...copyRef(r), bound: true }, id = idOf(r);
    if (hasArray(r) && !r.identity) next.manualOnly = true;
    const index = p.extRefs.findIndex(other => idOf(other) === id);
    next.bindingFps = [...new Set([...(p.extRefs[index]?.bindingFps || []), ...(r.bindingFps || []), ...bindingFps]
        .filter(fp => typeof fp === 'string' && fp))];
    if (index < 0) p.extRefs.push(next);
    else p.extRefs[index] = next;
}

export function rememberSyncBaseline(p) {
    if (!p?.key) return;
    const pair = pairOf(p);
    p.syncBaselines = [pair, ...(p.syncBaselines || []).filter(old => !samePair(old, pair))].slice(0, 20);
}

export function beginFillIntent(profileId) {
    if (!ctx?.extensionSettings) return null;
    const p = store.get(profileId);
    if (!p?.key) return null;
    return { profileId, version: versionOf(p), pair: pairOf(p), at: Date.now(),
        before: new Map(scanRefs().map(entry => [entry.id, { pair: entry.pair, identity: entry.ref.identity }])) };
}

export function commitFillIntent(token, bindingFps = []) {
    if (!ctx || !token?.before || Date.now() - token.at > TTL) return;
    const p = store.get(token.profileId);
    if (!p || versionOf(p) !== token.version) return;
    token.bindingFps = Array.isArray(bindingFps) ? bindingFps.filter(fp => typeof fp === 'string' && fp) : [];
    rememberSyncBaseline(p);
    pending.set(token, token);
    while (pending.size > 32) pending.delete(pending.keys().next().value);
    store.save();
    resolveFillIntents(p.id);
}

export function resolveFillIntents(profileId) {
    if (!ctx?.extensionSettings || resolving) return;
    resolving = true;
    try {
        const current = scanRefs();
        let changed = false;
        for (const [token, intent] of pending) {
            const p = store.get(intent.profileId);
            if (!p || Date.now() - intent.at > TTL || versionOf(p) !== intent.version) { pending.delete(token); continue; }
            if (!bindingsOwned(intent.profileId, intent.bindingFps || [])) { pending.delete(token); continue; }
            if (profileId && p.id !== profileId) continue;
            let matches = current.filter(e => {
                const before = intent.before.get(e.id), identity = identityTag(e.ref.identity);
                if (before?.identity && identityTag(before.identity) !== identity) return false;
                if (identity && [...intent.before.values()].some(old => identityTag(old.identity) === identity && samePair(old.pair, e.pair))) return false;
                return samePair(e.pair, intent.pair) && !samePair(before?.pair, e.pair) && !otherOwner(p.id, e.ref);
            });
            // BaiBai persists channel mirrors together. Its shared store is the canonical location.
            const shared = matches.filter(e => e.ref.segs[0] === 'baibai_api_channels');
            if (shared.length === 1 && shared[0].ref.identity && matches.every(e =>
                ['baibai_api_channels', 'baibai_book', 'baibai_image'].includes(e.ref.segs[0])
                && e.ref.segs[1] === 'channels' && e.ref.identity?.value === shared[0].ref.identity.value)) matches = shared;
            if (matches.length !== 1) continue;
            const r = matches[0].ref;
            if (hasArray(r) && !r.identity) continue;
            attach(p, r, intent.bindingFps); pending.delete(token); changed = true;
        }
        if (changed) store.save();
    } finally { resolving = false; }
}

function targetFor(r, confirmed) {
    return { id: idOf(r), source: r.source || r.segs[0] || '扩展设置',
        label: r.nameSeen || r.source || r.segs[0] || '扩展设置',
        path: [...r.segs, r.keyProp].join(' → '), confirmed, ref: copyRef(r) };
}

export function listBoundSyncTargets(profileId) {
    if (!ctx?.extensionSettings) return [];
    resolveFillIntents(profileId);
    const p = store.get(profileId);
    if (!p) return [];
    const targets = new Map(), baselines = [...(p.syncBaselines || []), pairOf(p)];
    for (const raw of p.extRefs) {
        const r = copyRef(raw);
        // Legacy imported references did not record their URL baseline; only adopt a known profile baseline.
        if (r.urlSeen === undefined && baselines.some(pair => samePair(pair, currentPair(r)))) {
            r.urlSeen = r.urlProp ? readAt(ctx.extensionSettings, r.segs, r.urlProp) : '';
        }
        targets.set(idOf(r), targetFor(r, !r.manualOnly && (!hasArray(r) || !!r.identity)));
    }
    for (const entry of scanRefs()) {
        // A key-only plugin can be explicitly selected, but never inferred as the matching URL by auto-discovery.
        const matchesBaseline = baselines.some(pair => samePair(pair, entry.pair)
            || (!entry.ref.urlProp && entry.pair?.hash && pair.hash === entry.pair.hash));
        if (!targets.has(entry.id) && matchesBaseline) {
            targets.set(entry.id, targetFor(entry.ref, false));
        }
    }
    const items = [...targets.values()];
    listed.set(profileId, { version: versionOf(p), at: Date.now(), targets: new Map(items.map(t =>
        [t.id, { target: t, node: nodeAt(t.ref.segs) }])) });
    return items.map(t => ({ ...t, ref: copyRef(t.ref) }));
}

function checkTarget(profileId, t, snapshotNode, desired) {
    const r = t.ref;
    if (otherOwner(profileId, r)) return '已关联其他配置，未覆盖';
    if (!identityMatches(r)) return '渠道已移动或被替换，请重新确认';
    const pair = currentPair(r);
    if (!pair) return '保存位置已删除或字段类型改变';
    const alreadyDesired = samePair(pair, { hash: hashKey(desired.key), url: r.urlProp ? urlIdentity(desired.url) : '' });
    if (nodeAt(r.segs) !== snapshotNode && (!alreadyDesired || (hasArray(r) && !r.identity))) {
        return '保存位置在确认后发生变化，请重新打开同步列表';
    }
    if (!alreadyDesired && !samePair(pair, { hash: r.hash, url: urlIdentity(r.urlSeen || '') })) return '插件中的密钥或地址已改动，未覆盖';
    return '';
}

/** Notify only the verified BaiBai shared-channel protocol; this does not claim to refresh arbitrary plugins. */
export function notifyBoundSyncTargets(refs) {
    if (!ctx || !refs.some(r => r.segs[0] === 'baibai_api_channels' && r.segs[1] === 'channels')) return false;
    const shared = ctx.extensionSettings.baibai_api_channels;
    if (!shared || shared.schemaVersion !== 1 || !Array.isArray(shared.channels)) return false;
    shared.revision = (Number.isSafeInteger(shared.revision) && shared.revision >= 0 ? shared.revision : 0) + 1;
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent('st-baibai-api-channels:changed', {
            detail: { revision: shared.revision, source: 'st-api-vault' },
        }));
    }
    return true;
}

export async function syncBoundExtensions(profileId, selectedIds, { bindingFps = [] } = {}) {
    const result = emptyResult();
    if (!ctx?.extensionSettings) return result;
    const p = store.get(profileId), list = listed.get(profileId);
    const ids = [...new Set(Array.isArray(selectedIds) ? selectedIds : [])];
    const fps = Array.isArray(bindingFps) ? [...new Set(bindingFps.filter(fp => typeof fp === 'string' && fp))] : [];
    const reject = reason => { for (const id of ids) result.skipped.push(resultItem(list?.targets.get(id)?.target || { id }, reason)); return result; };
    if (!p || !list) return reject('请先打开同步列表并确认目标');
    if (syncing.has(profileId)) return reject('该配置正在同步');
    if (Date.now() - list.at > TTL || versionOf(p) !== list.version) return reject('配置或确认列表已变化，请重新打开同步列表');
    if (!p.key) return reject('配置没有可读取的密钥');
    if (!bindingsOwned(profileId, fps)) return reject('输入框绑定已变化，请重新打开同步列表');
    syncing.add(profileId);
    try {
        const writes = [], desired = { key: p.key, url: p.url };
        rememberSyncBaseline(p);
        for (const id of ids) {
            const entry = list.targets.get(id);
            if (!entry) { result.skipped.push({ id, reason: '不在本次确认列表中' }); continue; }
            const t = entry.target, r = copyRef(t.ref), problem = checkTarget(profileId, t, entry.node, desired);
            if (problem) { result.skipped.push(resultItem(t, problem)); continue; }
            if (r.urlProp && !desired.url) { result.skipped.push(resultItem(t, '配置没有地址，未清空插件地址')); continue; }
            try {
                const oldKey = readAt(ctx.extensionSettings, r.segs, r.keyProp);
                const oldUrl = r.urlProp ? readAt(ctx.extensionSettings, r.segs, r.urlProp) : '';
                const changed = oldKey !== desired.key || (!!r.urlProp && oldUrl !== desired.url);
                if (oldKey !== desired.key && !writeAt(ctx.extensionSettings, r.segs, r.keyProp, desired.key)) throw new Error('密钥写入失败');
                if (r.urlProp && oldUrl !== desired.url && !writeAt(ctx.extensionSettings, r.segs, r.urlProp, desired.url)) throw new Error('地址写入失败');
                writes.push({ t, r, changed, node: nodeAt(r.segs) });
            } catch (error) { result.failed.push(resultItem(t, error.message || '写入失败')); }
        }
        notifyBoundSyncTargets(writes.filter(w => w.changed).map(w => w.r));
        if (writes.length) ctx.saveSettingsDebounced();
        // Let reactive consumers persist their mirror; verify a host did not immediately restore old values.
        await Promise.resolve();
        await new Promise(resolve => setTimeout(resolve, 0));
        for (const { t, r, changed, node } of writes) {
            const key = readAt(ctx.extensionSettings, r.segs, r.keyProp);
            const url = r.urlProp ? readAt(ctx.extensionSettings, r.segs, r.urlProp) : '';
            if (store.get(profileId) !== p || p.key !== desired.key || p.url !== desired.url || otherOwner(profileId, r)
                || !bindingsOwned(profileId, fps)) {
                result.failed.push(resultItem(t, '同步期间配置或关联归属发生变化，请重新确认'));
                continue;
            }
            if (!identityMatches(r) || (hasArray(r) && !r.identity && nodeAt(r.segs) !== node)
                || key !== desired.key || (r.urlProp && url !== desired.url)) {
                result.failed.push(resultItem(t, '插件恢复了旧值或改变了保存位置，本次同步未保留'));
                continue;
            }
            r.hash = hashKey(desired.key); r.urlSeen = url;
            attach(p, r, fps);
            result[changed ? 'updated' : 'unchanged'].push(resultItem(t,
                hasArray(r) && !r.identity ? '已更新所选保存位置；匿名列表每次需要重新确认' : undefined));
        }
        if (writes.length) store.save();
        return result;
    } finally { syncing.delete(profileId); listed.delete(profileId); }
}
