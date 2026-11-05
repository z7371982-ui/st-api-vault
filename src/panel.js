// The manager panel: a side dock that lists profiles, edits them, imports from SillyTavern
// and always shows which field a click on "填入" would go to.
import { store } from './store.js';
import { st } from './st.js';
import { collectCandidates, importItems, syncToST, resolveKey, pushProfile, reconcile, isActiveInST } from './sync.js';
import { probe } from './probe.js';
import { KIND_LABEL } from './fill.js';
import { isCompact, isTouch, swipeToClose, trackViewport, createFab } from './sheet.js';
import {
    esc, maskKey, hostOf, colorFor, initials, searchProfiles, sortProfiles,
    parseTags, parseCredentialText, findDuplicate, normalizeUrl,
} from './vault.js';

const TITLE = 'API 管理器';

let ctx = null;
let root = null;
let view = 'list'; // list | edit | import | settings
let editId = null;
let query = '';
let tag = '';
let importState = null; // { loading, canView, items, picked:Set }
// Editor-only state for the connection test, kept outside the form so re-renders do not lose it.
let probeState = null; // { busy, ok, text, models:string[] }
let editorEpoch = 0;
let queryComposing = false;
const testing = new Set(); // profile ids with a card-level test running
let armedDelete = null; // profile id whose delete button is waiting for the confirming second tap
let armTimer = 0;

// ---------- helpers ----------

async function copy(text, what) {
    if (!text) return;
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const focused = document.activeElement;
        const ta = Object.assign(document.createElement('textarea'), { value: text });
        ta.style.cssText = 'position:fixed;opacity:0';
        (root.closest('dialog[open]') || document.body).append(ta);
        let copied = false;
        try {
            ta.focus({ preventScroll: true });
            ta.select();
            copied = document.execCommand('copy');
        } catch { /* Report failure below. */ }
        finally {
            ta.remove();
            focused?.focus({ preventScroll: true });
        }
        if (!copied) return toastr.error('复制失败，请在编辑页手动选择并复制', TITLE);
    }
    toastr.success(`${what}已复制`, TITLE, { timeOut: 1200 });
}

async function confirmDialog(title, text) {
    try {
        if (ctx.Popup?.show?.confirm) return !!(await ctx.Popup.show.confirm(title, text));
    } catch { /* fall through */ }
    return window.confirm(`${title}\n\n${text}`);
}

function relTime(ts) {
    if (!ts) return '从未使用';
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return '刚刚用过';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前用过`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前用过`;
    return `${Math.floor(s / 86400)} 天前用过`;
}

function healthBadge(p) {
    if (testing.has(p.id)) return '<span class="avm-badge"><i class="fa-solid fa-spinner fa-spin"></i>测试中</span>';
    const h = p.health;
    if (!h) return '';
    const when = relTime(h.at).replace('用过', '测试');
    if (h.ok) {
        return `<span class="avm-badge is-ok" title="${esc(`${when} · ${h.count} 个模型 · ${h.base}`)}"><i class="fa-solid fa-circle-check"></i>${h.ms}ms · ${h.count} 模型</span>`;
    }
    return `<span class="avm-badge is-bad" title="${esc(`${when}：${h.error}`)}"><i class="fa-solid fa-circle-xmark"></i>连接失败</span>`;
}

function activeTitle(p) {
    if (p.proxyRef && !p.proxyMissing && !(p.stRef && !p.stMissing)) return `酒馆当前选中的代理预设是「${p.proxyRef.name}」`;
    return `酒馆「${st.providerName(p.stRef?.key)}」当前正在用这个密钥`;
}

function allTags() {
    const count = new Map();
    for (const p of store.profiles) for (const t of p.tags) count.set(t, (count.get(t) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

// ---------- rendering ----------

// Filling happens at the field itself (the key button next to it), because a plugin's popup
// usually covers this panel. The panel only explains how.
function fillTip() {
    return `<div class="avm-target is-idle">
        <i class="fa-solid fa-key"></i>
        <span>要填进插件：点插件里的地址或密钥框，框边会出现钥匙按钮，点它选配置就行</span>
    </div>`;
}

function card(p) {
    const bindings = store.bindingsFor(p.id);
    const out = store.isOutOfSync(p);
    const synced = p.stRef && !out;
    const keyText = maskKey(p.key) || (p.keyHint ? `${p.keyHint}` : '');
    const active = isActiveInST(p);
    const badges = [
        healthBadge(p),
        active ? `<span class="avm-badge is-accent" title="${esc(activeTitle(p))}"><i class="fa-solid fa-bolt"></i>酒馆在用</span>` : '',
        p.proxyRef && !p.proxyMissing ? `<span class="avm-badge is-ok" title="${esc(`酒馆的反向代理预设「${p.proxyRef.name}」，在这里改了会同步回去`)}"><i class="fa-solid fa-route"></i>代理预设</span>` : '',
        p.proxyMissing ? '<span class="avm-badge is-warn" title="酒馆里这个代理预设已被删除"><i class="fa-solid fa-unlink"></i>预设已删除</span>' : '',
        p.stMissing ? '<span class="avm-badge is-warn" title="酒馆里这条密钥已被删除，点「用于酒馆」可以重新写入"><i class="fa-solid fa-unlink"></i>酒馆已删除</span>' : '',
        p.extRefs.length ? `<span class="avm-badge" title="${esc(`同步到：${[...new Set(p.extRefs.map(r => r.source))].join('、')}`)}"><i class="fa-solid fa-puzzle-piece"></i>${p.extRefs.length} 个扩展</span>` : '',
        synced && !active && !p.stMissing ? `<span class="avm-badge is-ok" title="已存进酒馆：${esc(st.providerName(p.stRef.key))}"><i class="fa-solid fa-link"></i>酒馆</span>` : '',
        out ? '<span class="avm-badge is-warn" title="密钥改过，酒馆里还是旧的"><i class="fa-solid fa-rotate"></i>待同步</span>' : '',
        !p.key && p.stRef ? '<span class="avm-badge" title="酒馆只给了掩码，只能在酒馆内切换使用"><i class="fa-solid fa-lock"></i>仅酒馆</span>' : '',
        bindings.length ? `<span class="avm-badge" title="${esc(bindings.map(([, b]) => b.scope || b.label).filter(Boolean).join('、'))}"><i class="fa-solid fa-thumbtack"></i>${bindings.length} 处</span>` : '',
    ].join('');

    return `<article class="avm-card" data-id="${esc(p.id)}">
        <div class="avm-card-head">
            <span class="avm-avatar" style="--c:${colorFor(p.name)}">${esc(initials(p.name))}</span>
            <div class="avm-card-title">
                <div class="avm-card-name">${esc(p.name)}</div>
                <div class="avm-card-host">${esc(hostOf(p.url) || '未填地址')}${p.model ? ` · ${esc(p.model)}` : ''}</div>
            </div>
            <button type="button" class="avm-icon-btn" data-act="edit" title="编辑" aria-label="编辑 ${esc(p.name)}"><i class="fa-solid fa-pen"></i></button>
            ${armedDelete === p.id
                ? `<button type="button" class="avm-btn is-confirm" data-act="card-delete" title="再点一次删除" aria-label="确认删除 ${esc(p.name)}"><i class="fa-solid fa-trash"></i>确认删除</button>`
                : `<button type="button" class="avm-icon-btn is-danger" data-act="card-delete" title="删除" aria-label="删除 ${esc(p.name)}"><i class="fa-solid fa-trash"></i></button>`}
        </div>
        <div class="avm-card-fields">
            <button type="button" class="avm-field" data-act="copy-url" ${p.url ? '' : 'disabled'} title="复制地址">
                <i class="fa-solid fa-globe"></i><span>${esc(p.url || '—')}</span><i class="fa-regular fa-copy avm-field-copy"></i>
            </button>
            <button type="button" class="avm-field" data-act="copy-key" ${keyText ? '' : 'disabled'} title="复制密钥">
                <i class="fa-solid fa-key"></i><span class="avm-mono">${esc(keyText || '—')}</span><i class="fa-regular fa-copy avm-field-copy"></i>
            </button>
        </div>
        ${badges || p.tags.length ? `<div class="avm-card-meta">${badges}${p.tags.map(x => `<span class="avm-tag">#${esc(x)}</span>`).join('')}</div>` : ''}
        <div class="avm-card-actions">
            <button type="button" class="avm-btn is-primary" data-act="sync" ${(p.key || (p.stRef && !p.stMissing) || (p.proxyRef && !p.proxyMissing)) && !active ? '' : 'disabled'} title="${active ? '酒馆已经在用这个配置' : (p.syncTarget || (!p.key && p.stRef) ? '设为酒馆 API 密钥栏当前使用的密钥' : '在酒馆的代理预设里选中它（没有的话会先创建）')}">
                <i class="fa-solid fa-plug"></i>${active ? '使用中' : '用于酒馆'}
            </button>
            <button type="button" class="avm-icon-btn" data-act="test" ${testing.has(p.id) ? 'disabled' : ''} title="测试连接并获取模型列表" aria-label="测试 ${esc(p.name)} 的连接">
                <i class="fa-solid fa-stethoscope"></i>
            </button>
            <span class="avm-card-used">${relTime(p.usedAt)}</span>
        </div>
    </article>`;
}

/**
 * Connection block in the editor, modelled on ST's own "连接" button: one /models request
 * tells whether URL + key work and returns the model list. Nothing is generated, so no quota is used.
 */
function testSection(p) {
    const s = probeState;
    const h = !s && p?.health;
    let status = '<div class="avm-test-status"><span class="avm-dot"></span>未连接</div>';
    if (s?.busy) status = '<div class="avm-test-status"><i class="fa-solid fa-spinner fa-spin"></i>正在连接…</div>';
    else if (s?.dirty) status = '<div class="avm-test-status"><span class="avm-dot"></span>配置已更改，尚未测试</div>';
    else if (s) status = `<div class="avm-test-status ${s.ok ? 'is-ok' : 'is-bad'}"><span class="avm-dot"></span>${esc(s.text)}</div>`;
    else if (h) status = `<div class="avm-test-status ${h.ok ? 'is-ok' : 'is-bad'}"><span class="avm-dot"></span>${esc(h.ok
        ? `有效 · ${h.ms}ms · ${h.count} 个模型（${relTime(h.at).replace('用过', '测试')}）`
        : `无效 · ${h.error}`)}</div>`;

    return `<div class="avm-test">
        <div class="avm-test-head">
            <button type="button" class="avm-btn" data-act="probe" ${s?.busy ? 'disabled' : ''} title="和酒馆的「连接」一样，只请求模型列表，不发消息、不消耗额度">
                <i class="fa-solid fa-plug-circle-check"></i>连接
            </button>
            ${status}
        </div>
        <span class="avm-hint">只请求一次模型列表来验证地址和密钥，不会生成内容，不消耗额度。连上后模型可以在下面的「模型」框里直接选。</span>
    </div>`;
}

function listView() {
    let list = sortProfiles(searchProfiles(store.profiles, query));
    if (tag) list = list.filter(p => p.tags.includes(tag));
    const tags = allTags();

    const empty = store.profiles.length
        ? '<div class="avm-empty"><i class="fa-solid fa-magnifying-glass"></i><p>没有匹配的配置</p></div>'
        : `<div class="avm-empty">
            <i class="fa-solid fa-box-open"></i>
            <p>还没有任何 API 配置</p>
            <p class="avm-hint">点「一键扫描」看看酒馆和其他插件里已经存了哪些，想要哪个就勾哪个</p>
            <div class="avm-empty-actions">
                <button type="button" class="avm-btn is-primary" data-act="import"><i class="fa-solid fa-magnifying-glass-plus"></i>一键扫描</button>
                <button type="button" class="avm-btn" data-act="new"><i class="fa-solid fa-plus"></i>手动新建</button>
            </div>
        </div>`;

    return `
        ${store.profiles.length ? fillTip() : ''}
        <div class="avm-toolbar">
            <label class="avm-search">
                <i class="fa-solid fa-magnifying-glass"></i>
                <input type="text" data-role="query" value="${esc(query)}" placeholder="搜索名称、地址、模型、标签" autocomplete="off" spellcheck="false" aria-label="搜索配置">
            </label>
            <button type="button" class="avm-btn" data-act="import" title="扫描酒馆和其他插件里已保存的 API，自己选要导入哪些"><i class="fa-solid fa-magnifying-glass-plus"></i><span class="avm-hide-sm">扫描</span></button>
            <button type="button" class="avm-btn is-primary" data-act="new" title="新建配置"><i class="fa-solid fa-plus"></i><span class="avm-hide-sm">新建</span></button>
        </div>
        ${tags.length ? `<div class="avm-tags" role="group" aria-label="按标签筛选">
            <button type="button" class="avm-tag-btn${tag ? '' : ' is-on'}" data-tag="">全部 ${store.profiles.length}</button>
            ${tags.map(x => `<button type="button" class="avm-tag-btn${x === tag ? ' is-on' : ''}" data-tag="${esc(x)}">${esc(x)}</button>`).join('')}
        </div>` : ''}
        <div class="avm-list">${list.length ? list.map(p => card(p)).join('') : empty}</div>
        ${store.profiles.length ? `<div class="avm-list-foot">
            <button type="button" class="avm-link-btn is-danger" data-act="clear-all"><i class="fa-solid fa-trash-can"></i>清空全部 ${store.profiles.length} 个配置</button>
        </div>` : ''}`;
}

function editView() {
    const p = editId ? store.get(editId) : null;
    const v = p || { name: '', url: '', key: '', model: '', tags: [], note: '', syncTarget: '', keyHint: '', stRef: null };
    const slots = st.secretKeys();
    const current = v.syncTarget;
    if (current && !slots.includes(current)) slots.unshift(current);
    const bindings = p ? store.bindingsFor(p.id) : [];
    const keyPlaceholder = !v.key && v.stRef ? `酒馆里已保存（${v.keyHint || '掩码'}），原文不可见` : 'sk-...';
    const models = probeState ? (probeState.models || []) : (p?.models || []);

    return `
        <div class="avm-subhead">
            <button type="button" class="avm-icon-btn" data-act="back" aria-label="返回列表"><i class="fa-solid fa-arrow-left"></i></button>
            <h3>${p ? '编辑配置' : '新建配置'}</h3>
        </div>
        <form class="avm-form" data-role="editor" autocomplete="off">
            <details class="avm-paste" ${p ? '' : 'open'}>
                <summary><i class="fa-solid fa-paste"></i>粘贴一整段文字，自动识别地址和密钥</summary>
                <textarea data-role="paste" rows="3" placeholder="例如：地址 https://api.openai.com/v1  密钥 sk-xxxx"></textarea>
                <button type="button" class="avm-btn" data-act="parse"><i class="fa-solid fa-wand-magic"></i>识别</button>
            </details>
            <label class="avm-label">名称
                <input name="name" type="text" value="${esc(v.name)}" placeholder="留空则用网站域名">
            </label>
            <label class="avm-label">API 地址
                <input name="url" type="text" inputmode="url" value="${esc(v.url)}" placeholder="https://api.openai.com/v1" spellcheck="false">
            </label>
            <label class="avm-label">密钥
                <span class="avm-input-group">
                    <input name="key" type="password" value="${esc(v.key)}" placeholder="${esc(keyPlaceholder)}" spellcheck="false" autocomplete="new-password">
                    <button type="button" class="avm-icon-btn" data-act="toggle-key" title="显示 / 隐藏" aria-label="显示或隐藏密钥"><i class="fa-solid fa-eye"></i></button>
                    ${!v.key && v.stRef ? '<button type="button" class="avm-icon-btn" data-act="reveal" title="尝试从酒馆读取原文" aria-label="从酒馆读取密钥原文"><i class="fa-solid fa-unlock"></i></button>' : ''}
                </span>
            </label>
            ${testSection(p)}
            <div class="avm-grid2">
                <label class="avm-label">模型（可选）
                    <input name="model" type="text" value="${esc(v.model)}" placeholder="${models.length ? `从 ${models.length} 个模型里选，或直接输入` : 'gpt-4o / claude-…'}" spellcheck="false" list="avm_models_datalist">
                    <datalist id="avm_models_datalist">${models.map(m => `<option value="${esc(m)}"></option>`).join('')}</datalist>
                </label>
                <label class="avm-label">标签
                    <input name="tags" type="text" value="${esc(v.tags.join(', '))}" placeholder="主力, 翻译, 备用">
                </label>
            </div>
            <label class="avm-label">在酒馆里怎么用
                <select name="syncTarget">
                    <option value="" ${current ? '' : 'selected'}>反向代理预设（推荐）</option>
                    <optgroup label="高级：写进下面的 API 密钥栏">
                        ${slots.map(k => `<option value="${esc(k)}" ${k === current ? 'selected' : ''}>${esc(st.providerName(k))} 密钥</option>`).join('')}
                    </optgroup>
                </select>
                <span class="avm-hint">默认存成酒馆「反向代理 → 代理预设」里的一项，点「用于酒馆」就是在下拉框里选中它。只有直接用官方 API、不走反代时，才需要选下面的密钥栏。</span>
            </label>
            <label class="avm-label">备注
                <textarea name="note" rows="2" placeholder="额度、到期时间、用途……">${esc(v.note)}</textarea>
            </label>
            ${bindings.length ? `<div class="avm-label">已绑定的输入框
                <ul class="avm-bindings">
                    ${bindings.map(([fp, b]) => `<li><span><b>${esc(b.scope || '页面')}</b> · ${esc(b.label || KIND_LABEL[b.kind] || '')}</span>
                        <button type="button" class="avm-icon-btn" data-act="unbind" data-fp="${esc(fp)}" title="解除绑定" aria-label="解除绑定"><i class="fa-solid fa-xmark"></i></button></li>`).join('')}
                </ul>
            </div>` : ''}
            <div class="avm-form-actions">
                ${p ? '<button type="button" class="avm-btn is-danger" data-act="delete"><i class="fa-solid fa-trash"></i>删除</button>' : ''}
                <span class="avm-flex"></span>
                <button type="button" class="avm-btn" data-act="back">取消</button>
                <button type="submit" class="avm-btn is-primary"><i class="fa-solid fa-check"></i>保存</button>
            </div>
        </form>`;
}

function importView() {
    const s = importState;
    const head = `
        <div class="avm-subhead">
            <button type="button" class="avm-icon-btn" data-act="back" aria-label="返回列表"><i class="fa-solid fa-arrow-left"></i></button>
            <h3>从酒馆和扩展导入</h3>
            <button type="button" class="avm-icon-btn" data-act="import" title="重新扫描" aria-label="重新扫描"><i class="fa-solid fa-arrows-rotate"></i></button>
        </div>`;
    if (!s || s.loading) return `${head}<div class="avm-empty"><i class="fa-solid fa-spinner fa-spin"></i><p>正在读取…</p></div>`;
    if (!s.items.length) return `${head}<div class="avm-empty"><i class="fa-solid fa-inbox"></i><p>酒馆和其他扩展里都没找到已保存的密钥</p></div>`;

    const status = it => {
        if (!it.existing) return '<span class="avm-badge is-ok">新</span>';
        return `<span class="avm-badge">已有：${esc(it.existing.name)}</span>`;
    };
    return `${head}
        ${s.canView ? '' : `<div class="avm-note"><i class="fa-solid fa-circle-info"></i><div>
            酒馆没开 <code>allowKeysExposure</code>，酒馆里的密钥只能读到掩码。导入后可以一键切换酒馆正在用的密钥，
            但填进其他插件需要原文：在 <code>config.yaml</code> 设为 <code>true</code> 并重启，或在配置里手动补上密钥。
        </div></div>`}
        <div class="avm-import-list">
            ${s.items.map((it, i) => `<label class="avm-import-row">
                <input type="checkbox" data-pick="${i}" ${s.picked.has(i) ? 'checked' : ''}>
                <span class="avm-avatar" style="--c:${colorFor(it.name)}">${esc(initials(it.name))}</span>
                <span class="avm-row-text">
                    <span class="avm-row-name">${esc(it.name)}${it.active ? ' <span class="avm-badge is-accent">酒馆在用</span>' : ''}</span>
                    <span class="avm-row-sub">${esc(it.source)}${it.provider && it.provider !== it.source ? ` · ${esc(it.provider)}` : ''} · ${esc(maskKey(it.key) || it.keyHint || '—')}</span>
                </span>
                ${status(it)}
            </label>`).join('')}
        </div>
        <div class="avm-form-actions">
            <button type="button" class="avm-btn" data-act="pick-all">${s.picked.size === s.items.length ? '全不选' : '全选'}</button>
            <span class="avm-hint avm-hide-sm">已有的配置只会补全缺的信息，不会重复创建</span>
            <span class="avm-flex"></span>
            <button type="button" class="avm-btn is-primary" data-act="do-import" ${s.picked.size ? '' : 'disabled'}>
                <i class="fa-solid fa-file-import"></i>导入 ${s.picked.size} 项
            </button>
        </div>`;
}

function settingsView() {
    const o = store.options;
    const row = (name, title, desc) => `<label class="avm-switch-row">
        <span><b>${title}</b><small>${desc}</small></span>
        <input type="checkbox" class="avm-switch" data-opt="${name}" ${o[name] ? 'checked' : ''}>
    </label>`;
    return `
        <div class="avm-subhead">
            <button type="button" class="avm-icon-btn" data-act="back" aria-label="返回列表"><i class="fa-solid fa-arrow-left"></i></button>
            <h3>设置</h3>
        </div>
        <div class="avm-settings">
            ${row('pill', '输入框旁的钥匙按钮', '点进 API 地址或密钥框时，在框边上显示一个小钥匙，点开就能选配置')}
            ${row('autoFillBound', '自动填入已绑定的配置', '框是空的、之前在这里用过某个配置时，一点进去就自动填好')}
            ${row('capture', '发现新密钥时提示保存', '在插件里手动粘贴了管理器没有的密钥，弹个提示，点一下就存起来')}
            ${row('autoImport', '自动导入新密钥', '默认关闭，用列表上的「扫描」自己挑。打开后，启动时和在酒馆里保存新密钥后会自动导入（删掉的不会再导回来）')}
            ${row('autoSync', '改动自动同步回去', '在管理器里改了密钥、地址或名称，保存时同步更新酒馆里对应的密钥和用到它的扩展设置')}
            <label class="avm-switch-row">
                <span><b>悬浮钥匙按钮</b><small>屏幕边上的圆形按钮，点一下打开管理器，按住可以拖到任意位置，松手会贴到边上</small></span>
                <input type="checkbox" class="avm-switch" data-opt="fab" ${fabEnabled() ? 'checked' : ''}>
            </label>
            <div class="avm-note"><i class="fa-regular fa-keyboard"></i><div>
                ${isCompact() || isTouch()
                    ? '<b>手机上</b>：点进插件的地址或密钥框，框边会出现钥匙按钮，点它从底部弹出配置列表；屏幕边上的悬浮钥匙可以拖动，点它打开管理器。<br>'
                    : '<b>Alt + K</b>：在输入框里按，打开快速选择；在别处按，打开管理器。<br>'}
                配置保存在酒馆的扩展设置里（settings.json），和酒馆本身的设置一起备份。
            </div></div>
        </div>`;
}

export function render({ force = false } = {}) {
    if (!root?.classList.contains('is-open')) return;
    const body = root.querySelector('.avm-body');
    // Background completion and reopening must not replace a live editor or IME input.
    if (!force && ((view === 'edit' && body.querySelector('[data-role="editor"]')) || queryComposing)) return;
    const focused = document.activeElement;
    const keepQuery = focused?.dataset?.role === 'query';
    const caret = keepQuery ? focused.selectionStart : 0;
    body.innerHTML = { list: listView, edit: editView, import: importView, settings: settingsView }[view]();
    root.querySelectorAll('[data-view-btn]').forEach(b => b.classList.toggle('is-on', b.dataset.viewBtn === view));
    if (keepQuery) {
        const q = body.querySelector('[data-role="query"]');
        q?.focus({ preventScroll: true });
        q?.setSelectionRange(caret, caret);
    }
}

// ---------- actions ----------

function go(next, id = null) {
    editorEpoch++;
    queryComposing = false;
    view = next;
    editId = id;
    probeState = null;
    render({ force: true });
    root.querySelector('.avm-body').scrollTop = 0;
}

async function startImport() {
    importState = { loading: true };
    go('import');
    try {
        const { canView, items } = await collectCandidates();
        const picked = new Set(items.map((it, i) => (it.existing ? -1 : i)).filter(i => i >= 0));
        importState = { loading: false, canView, items, picked };
    } catch (err) {
        console.error('[API Vault] import scan failed', err);
        importState = { loading: false, canView: false, items: [], picked: new Set() };
        toastr.error('读取酒馆密钥失败', TITLE);
    }
    if (view === 'import') render();
}

function readForm(form) {
    const f = new FormData(form);
    const get = k => String(f.get(k) || '').trim();
    return {
        name: get('name'),
        url: get('url') ? normalizeUrl(get('url')) : '',
        key: get('key'),
        model: get('model'),
        tags: parseTags(get('tags')),
        note: String(f.get('note') || ''),
        syncTarget: get('syncTarget'),
    };
}

async function saveForm(form) {
    const data = readForm(form);
    const savingId = editId;
    const existing = editId && store.get(editId);
    if (!data.url && !data.key && !existing?.stRef) {
        toastr.warning('地址和密钥至少填一个', TITLE);
        return;
    }
    const dup = findDuplicate(store.profiles.filter(p => p.id !== editId), data);
    if (dup && !(await confirmDialog('有重复的配置', `「${dup.name}」已经是同一个${data.key ? '密钥' : '地址'}，还要再存一份吗？`))) return;
    if (form !== root.querySelector('[data-role="editor"]') || editId !== savingId) return;
    // Keep the ST-only key when the field was left empty for a profile imported with a mask.
    if (existing && !data.key && existing.stRef) delete data.key;
    // A successful test in the editor already fetched the models; keep them.
    if (testedDraftMatches(form)) Object.assign(data, { models: probeState.models, modelsAt: Date.now(), health: probeState.health });
    // A name typed by the user is never replaced by names found later in ST or extensions.
    const typedName = !!data.name && data.name !== existing?.name;
    if (typedName || !data.name) data.nameAuto = !data.name;
    const p = store.upsert({ ...data, id: editId || undefined });
    go('list');

    let pushed = [];
    try {
        pushed = await pushProfile(p, { isNew: !existing });
    } catch (err) {
        toastr.error(`已保存，但同步失败：${esc(err.message || String(err))}`, TITLE);
        return;
    }
    toastr.success(pushed.length ? `已保存「${esc(p.name)}」，并更新了${esc(pushed.join('、'))}` : `已保存「${esc(p.name)}」`, TITLE, { timeOut: 2200 });
}

/**
 * What the editor currently describes. Carries the saved id only while URL and key are unchanged,
 * so a test of unsaved edits does not overwrite the saved profile's health and models.
 */
function editorDraft(form) {
    const data = readForm(form);
    const saved = editId && store.get(editId);
    if (!saved) return data;
    const sameKey = data.key === saved.key || (!data.key && !!saved.stRef);
    if (sameKey && (data.url || '') === (saved.url || '')) return { ...saved, ...data, key: data.key || saved.key };
    return { ...data, key: data.key || (sameKey ? saved.key : ''), stRef: sameKey ? saved.stRef : null, stMissing: saved.stMissing };
}

function probeSignature(form) {
    const p = editorDraft(form);
    // Reading a masked ST secret may populate the store without changing this form.
    return JSON.stringify([p.url, readForm(form).key, p.syncTarget, p.stRef?.key, p.stRef?.id, !!p.stMissing]);
}

function invalidateEditorTest() {
    editorEpoch++;
    if (probeState?.dirty) return;
    probeState = { dirty: true, models: [] };
    refreshTest();
}

function testedDraftMatches(form) {
    return probeState?.ok && probeState.signature === probeSignature(form) && probeState.key === editorDraft(form).key;
}

/** Re-renders only the test block and the model suggestions, leaving typed form values alone. */
function refreshTest() {
    const box = root.querySelector('.avm-test');
    if (!box || view !== 'edit') return;
    const p = editId ? store.get(editId) : null;
    box.outerHTML = testSection(p);
    const models = probeState ? (probeState.models || []) : (p?.models || []);
    const list = root.querySelector('#avm_models_datalist');
    if (list) list.innerHTML = models.map(m => `<option value="${esc(m)}"></option>`).join('');
    const input = root.querySelector('[name="model"]');
    if (input && models.length) input.placeholder = `从 ${models.length} 个模型里选，或直接输入`;
}

async function runEditorProbe(form) {
    const draft = editorDraft(form);
    const epoch = ++editorEpoch;
    const signature = probeSignature(form);
    const isCurrent = () => {
        if (epoch !== editorEpoch || form !== root.querySelector('[data-role="editor"]')) return false;
        if (signature === probeSignature(form)) return true;
        invalidateEditorTest();
        return false;
    };
    probeState = { busy: true };
    refreshTest();
    try {
        const r = await probe(draft);
        if (!isCurrent()) return;
        if (r.stale) return invalidateEditorTest();
        const health = { ok: true, ms: r.ms, at: Date.now(), count: r.models.length, base: r.base };
        const text = `有效 · ${r.ms}ms · ${r.models.length} 个模型${r.via ? `（${r.via}）` : ''}${r.base && r.base !== normalizeUrl(draft.url) ? ` · 实际地址 ${r.base}` : ''}`;
        probeState = { busy: false, ok: true, text, models: r.models, health, signature, key: editorDraft(form).key };
    } catch (err) {
        if (!isCurrent()) return;
        if (err.stale) return invalidateEditorTest();
        probeState = { busy: false, ok: false, text: `无效 · ${err.message || String(err)}`, models: [] };
    }
    refreshTest();
}


async function runCardTest(p) {
    testing.add(p.id);
    render();
    try {
        const r = await probe(p);
        if (r.stale) return;
        toastr.success(`「${esc(p.name)}」连接正常：${r.ms}ms，${r.models.length} 个模型`, TITLE, { timeOut: 2200 });
    } catch (err) {
        if (err.stale) return;
        toastr.error(`「${esc(p.name)}」${esc(err.message || String(err))}`, TITLE);
    } finally {
        testing.delete(p.id);
        render();
    }
}

async function onClick(e) {
    const tagBtn = e.target.closest('[data-tag]');
    if (tagBtn) {
        tag = tagBtn.dataset.tag;
        return render();
    }
    const el = e.target.closest('[data-act], [data-view-btn]');
    if (!el || el.disabled) return;
    if (el.dataset.viewBtn) {
        if (el.dataset.viewBtn === 'import') return startImport();
        return go(view === el.dataset.viewBtn ? 'list' : el.dataset.viewBtn);
    }
    const id = el.closest('[data-id]')?.dataset.id;
    const p = id && store.get(id);
    const form = root.querySelector('[data-role="editor"]');

    switch (el.dataset.act) {
        case 'close': return closePanel();
        case 'new': return go('edit', null);
        case 'edit': return go('edit', id);
        case 'back': return go('list');
        case 'import': return startImport();
        case 'copy-url': return p && copy(p.url, '地址');
        case 'copy-key': {
            if (!p) return;
            const key = await resolveKey(p);
            if (key) return copy(key, '密钥');
            return toastr.warning('酒馆只给了掩码，复制不了原文', TITLE);
        }
        case 'sync': {
            if (!p) return;
            el.disabled = true;
            try {
                const slot = await syncToST(p);
                const cur = store.get(p.id) || p;
                toastr.success(`酒馆的「${esc(slot)}」现在使用「${esc(cur.name)}」${cur.model ? `，模型切到 ${esc(cur.model)}` : ''}`, TITLE);
            } catch (err) {
                toastr.error(esc(err.message || String(err)), TITLE);
            } finally {
                render();
            }
            return;
        }
        case 'toggle-key': {
            const input = form?.querySelector('[name="key"]');
            if (!input) return;
            input.type = input.type === 'password' ? 'text' : 'password';
            el.querySelector('i').className = `fa-solid ${input.type === 'password' ? 'fa-eye' : 'fa-eye-slash'}`;
            return;
        }
        case 'reveal': {
            const cur = store.get(editId);
            const epoch = editorEpoch;
            const signature = probeSignature(form);
            const key = cur && await resolveKey(cur);
            if (epoch !== editorEpoch || form !== root.querySelector('[data-role="editor"]') || signature !== probeSignature(form)) return;
            if (key) {
                form.querySelector('[name="key"]').value = key;
                invalidateEditorTest();
                toastr.success('已从酒馆读到密钥原文', TITLE, { timeOut: 1500 });
            } else {
                toastr.warning('酒馆不允许读取原文（config.yaml 里的 allowKeysExposure 是关的）', TITLE);
            }
            return;
        }
        case 'parse': {
            const { url, key } = parseCredentialText(form.querySelector('[data-role="paste"]').value);
            if (!url && !key) return toastr.warning('没认出地址或密钥', TITLE);
            if (url) form.querySelector('[name="url"]').value = url;
            if (key) form.querySelector('[name="key"]').value = key;
            invalidateEditorTest();
            const name = form.querySelector('[name="name"]');
            if (!name.value && url) name.placeholder = hostOf(url);
            toastr.success(`识别到${[url && '地址', key && '密钥'].filter(Boolean).join('和')}`, TITLE, { timeOut: 1500 });
            return;
        }
        case 'probe': return form && runEditorProbe(form);
        case 'test': return p && !testing.has(p.id) && runCardTest(p);
        case 'unbind': {
            store.unbind(el.dataset.fp);
            const list = el.closest('ul');
            el.closest('li')?.remove();
            if (list && !list.children.length) list.parentElement.remove();
            return;
        }
        case 'delete': {
            const cur = store.get(editId);
            if (!cur) return;
            const note = cur.stRef ? '只删除管理器里的记录，酒馆里保存的密钥不受影响。' : '删除后无法恢复。';
            if (!(await confirmDialog(`删除「${cur.name}」？`, note))) return;
            store.remove(cur.id);
            return go('list');
        }
        case 'card-delete': {
            if (!p) return;
            // Two taps: the first turns the trash icon into a red "确认删除", the second deletes.
            if (armedDelete !== p.id) {
                armedDelete = p.id;
                clearTimeout(armTimer);
                armTimer = setTimeout(() => {
                    armedDelete = null;
                    render();
                }, 4000);
                return render();
            }
            armedDelete = null;
            clearTimeout(armTimer);
            store.remove(p.id);
            toastr.success(`已删除「${esc(p.name)}」${p.stRef || p.proxyRef || p.extRefs.length ? '，酒馆和插件里的原数据没动' : ''}`, TITLE, { timeOut: 2000 });
            return render();
        }
        case 'clear-all': {
            const n = store.profiles.length;
            if (!n) return;
            const ok = await confirmDialog(
                `清空全部 ${n} 个配置？`,
                '只清空管理器里的记录和输入框绑定，酒馆里的密钥、代理预设和各插件自己的设置都不会动。清空后可以用「扫描」重新导入。',
            );
            if (!ok) return;
            store.clearAll();
            toastr.success(`已清空 ${n} 个配置`, TITLE, { timeOut: 2000 });
            return render();
        }
        case 'pick-all': {
            const s = importState;
            if (!s?.items) return;
            s.picked = s.picked.size === s.items.length ? new Set() : new Set(s.items.map((_, i) => i));
            return render();
        }
        case 'do-import': {
            const s = importState;
            const { added, linked } = importItems([...s.picked].map(i => s.items[i]));
            toastr.success(`导入 ${added} 个${linked ? `，补全 ${linked} 个已有配置` : ''}`, TITLE);
            return go('list');
        }
    }
}

function onInput(e) {
    if (e.target.dataset.role === 'query') {
        query = e.target.value;
        if (!e.isComposing && !queryComposing) render();
    } else if (view === 'edit' && ['url', 'key'].includes(e.target.name)) {
        invalidateEditorTest();
    }
}

function onChange(e) {
    const t = e.target;
    if (view === 'edit' && ['url', 'key', 'syncTarget'].includes(t.name)) invalidateEditorTest();
    if (t.dataset.opt) store.setOption(t.dataset.opt, t.checked);
    if (t.dataset.pick !== undefined && importState) {
        const i = Number(t.dataset.pick);
        if (t.checked) importState.picked.add(i);
        else importState.picked.delete(i);
        render();
    }
}

// ---------- open / close ----------

let fab = null;
let panelBackdrop = null;
let panelDialog = null;

function updatePanelLayer() {
    if (!isCompact() || !root.classList.contains('is-open')) {
        panelBackdrop?.remove();
        if (panelDialog?.open) {
            document.body.append(root);
            panelDialog.close();
        }
        return;
    }
    if (!panelBackdrop) {
        panelBackdrop = Object.assign(document.createElement('div'), { className: 'avm-root avm-backdrop avm-panel-backdrop' });
        panelBackdrop.addEventListener('click', () => closePanel());
    }
    // A modal dialog uses the browser's top layer, above host overlays regardless of z-index.
    if (!panelDialog && typeof HTMLDialogElement !== 'undefined' && typeof HTMLDialogElement.prototype.showModal === 'function') {
        panelDialog = Object.assign(document.createElement('dialog'), { className: 'avm-root avm-panel-layer' });
        panelDialog.setAttribute('aria-label', TITLE);
        panelDialog.addEventListener('cancel', e => {
            e.preventDefault();
            closePanel();
        });
        document.body.append(panelDialog);
    }
    if (panelDialog) {
        if (root.parentElement !== panelDialog) panelDialog.append(panelBackdrop, root);
        if (!panelDialog.open) panelDialog.showModal();
    } else {
        document.body.append(panelBackdrop);
    }
}

/** "auto" means: show the floating button only where there is no keyboard shortcut. */
function fabEnabled() {
    const v = store.options.fab;
    return v === 'auto' ? isTouch() || isCompact() : !!v;
}

function updateFab() {
    const on = fabEnabled();
    if (on && !fab) {
        fab = createFab({
            onTap: () => togglePanel(),
            getPos: () => store.options.fabPos,
            setPos: pos => store.setOption('fabPos', pos),
        });
    }
    if (fab) fab.hidden = !on || root.classList.contains('is-open');
}

export function openPanel() {
    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');
    if (view === 'import' && !importState) view = 'list';
    render();
    updatePanelLayer();
    updateFab();
}

export function closePanel() {
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    root.style.transform = '';
    updatePanelLayer();
    updateFab();
}

export function togglePanel() {
    if (root.classList.contains('is-open')) closePanel();
    else openPanel();
}

export function initPanel(context) {
    ctx = context;
    root = document.createElement('aside');
    root.className = 'avm-root avm-panel';
    root.setAttribute('aria-label', TITLE);
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
        <header class="avm-head">
            <div class="avm-grabber" aria-hidden="true"></div>
            <div class="avm-brand">
                <span class="avm-logo"><i class="fa-solid fa-vault"></i></span>
                <div><div class="avm-brand-name">API 管理器</div><div class="avm-brand-sub">点框 · 选配置 · 自动填</div></div>
            </div>
            <nav class="avm-head-actions">
                <button type="button" class="avm-icon-btn" data-view-btn="import" title="从酒馆导入" aria-label="从酒馆导入"><i class="fa-solid fa-file-import"></i></button>
                <button type="button" class="avm-icon-btn" data-view-btn="settings" title="设置" aria-label="设置"><i class="fa-solid fa-sliders"></i></button>
                <button type="button" class="avm-icon-btn" data-act="close" title="关闭" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
            </nav>
        </header>
        <div class="avm-body"></div>`;
    document.body.append(root);

    root.addEventListener('click', e => onClick(e).catch(err => console.error('[API Vault]', err)));
    root.addEventListener('input', onInput);
    root.addEventListener('compositionstart', e => {
        if (e.target.dataset.role === 'query') queryComposing = true;
    });
    root.addEventListener('compositionend', e => {
        if (e.target.dataset.role === 'query') {
            queryComposing = false;
            onInput(e);
        }
    });
    root.addEventListener('change', onChange);
    root.addEventListener('submit', e => {
        e.preventDefault();
        saveForm(e.target).catch(err => console.error('[API Vault]', err));
    });
    root.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (view !== 'list') go('list');
            else closePanel();
        }
    });

    // Phones: drag the header down to close, and keep the sheet above the on-screen keyboard.
    swipeToClose(root.querySelector('.avm-head'), root, () => closePanel());
    trackViewport();
    window.addEventListener('resize', () => {
        updatePanelLayer();
        updateFab();
    });

    // The editor holds unsaved input, so only the other views follow live changes.
    store.onChange(() => {
        updateFab();
        if (view !== 'edit') render();
        else if (probeState?.ok) {
            const form = root.querySelector('[data-role="editor"]');
            if (form && !testedDraftMatches(form)) invalidateEditorTest();
        }
    });
    updateFab();
}
