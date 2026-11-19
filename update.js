// Update notices.
//   - "New!" on the extensions-panel drawer title while the repo has a newer version; gone once updated.
//   - A popup offering the update only for versions marked `"major": true` in notice.json.
//   - Nothing at all after updating.
// Automatic checks read public files from the confirmed install or bundled release source.
// Failures stay quiet; manual checks discover the repository and report the reason.
import { store } from './store.js';
import { compareVersions, normNotices, majorNoticeToPrompt, renderNotice, esc } from './vault.js';

const TITLE = '通用钥匙API管理器';
const TIMEOUT = 8000;
// A page left open for hours must still notice a new version, so the check is repeated
// when the extensions panel is opened, and once an hour, but never more often than this.
// Cache the first successful git lookup (ST runs `git fetch` in the extension folder).
// Failed lookups can be retried; after success, later checks only read GitHub files
// to avoid repeating git operations alongside ST's "管理扩展" updater.
const RECHECK_MS = 10 * 60 * 1000;
// public/scripts/extensions/third-party/<folder>/src/update.js -> "<folder>"
const FOLDER = decodeURIComponent(new URL('..', import.meta.url).pathname.split('/').filter(Boolean).pop() || '');

let ctx = null;
let git = null;
let gitLocal = ''; // installed version at the time ST's git endpoint was asked
const state = { local: '', remote: '', updatable: false, notices: [], checked: false, deferred: false, error: '', busy: false, at: 0 };
let running = null;
let runningManual = false;
let queuedManual = null;
const listeners = new Set();

export const updateState = () => state;
export function onUpdateState(fn) {
    listeners.add(fn);
}

function emit() {
    for (const fn of listeners) {
        try {
            fn(state);
        } catch (err) {
            console.warn('[API Vault] update listener failed', err);
        }
    }
}

/** Per-user record of what was seen: last version opened, popups dismissed or shown. */
function meta() {
    const s = store.settings;
    if (!s.updates || typeof s.updates !== 'object') s.updates = {};
    const u = s.updates;
    if (typeof u.seen !== 'string') u.seen = '';
    if (!Array.isArray(u.dismissed)) u.dismissed = [];
    if (!Array.isArray(u.shown)) u.shown = [];
    return u;
}

function timeout(ms) {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
}

async function getJson(url, init = {}) {
    const res = await fetch(url, { cache: 'no-store', signal: timeout(TIMEOUT), ...init });
    if (!res.ok) {
        const detail = String(url).startsWith('/api/extensions/') ? (await res.text().catch(() => '')).trim() : '';
        throw new Error(`HTTP ${res.status}${detail && !detail.startsWith('<') ? `：${detail.slice(0, 300)}` : ''}`);
    }
    return res.json();
}

function errorReason(err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return '请求超时，请稍后重试';
    if (err?.name === 'SyntaxError') return '返回的数据不是有效的 JSON';
    return String(err?.message || err);
}

/** "https://github.com/user/repo(.git)" -> { owner, repo }, or null for other hosts. */
function githubRepo(remoteUrl) {
    const m = String(remoteUrl || '').match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i);
    return m ? { owner: m[1], repo: m[2] } : null;
}

/** Only public repository coordinates survive reloads, never scope or update status. */
function rememberRepo(info) {
    const gh = githubRepo(info.remoteUrl);
    const source = gh && typeof info.currentBranchName === 'string' && info.currentBranchName
        ? { folder: FOLDER, remoteUrl: `https://github.com/${gh.owner}/${gh.repo}`, branch: info.currentBranchName }
        : null;
    if (JSON.stringify(store.options.updateSource || null) !== JSON.stringify(source)) {
        store.options.updateSource = source;
        store.save();
    }
}

function cachedRepo() {
    const source = store.options.updateSource;
    const gh = source?.folder === FOLDER && githubRepo(source.remoteUrl);
    return gh && typeof source.branch === 'string' && source.branch ? { ...gh, branch: source.branch } : null;
}

/** A release declares its public source so a fresh install needs no manual setup. */
function declaredRepo(manifest) {
    try {
        const url = new URL(manifest.homePage);
        if (url.protocol !== 'https:' || url.hostname !== 'github.com'
            || url.username || url.password || url.search || url.hash) return null;
        const gh = githubRepo(url.href);
        const branch = manifest.update_branch;
        return gh && typeof branch === 'string' && branch.trim() ? { ...gh, branch: branch.trim() } : null;
    } catch {
        return null;
    }
}

/** First URL that answers wins; a blocked GitHub falls through to the CDN mirror. */
async function firstJson(urls) {
    let lastError;
    for (const url of urls) {
        try {
            return await getJson(url);
        } catch (err) { lastError = err; }
    }
    throw lastError;
}

/** Asks ST about this extension's git repo: branch, remote, and whether origin has newer commits. */
async function gitInfo() {
    let extensions;
    try {
        extensions = await getJson('/api/extensions/discover');
    } catch (err) {
        throw new Error(`读取扩展安装信息失败：${errorReason(err)}`);
    }
    if (!Array.isArray(extensions)) throw new Error('酒馆返回的扩展安装列表格式不正确');
    const extension = extensions.find(e => e?.name === `third-party/${FOLDER}`);
    if (!extension) throw new Error('酒馆未找到当前扩展的安装记录');
    if (extension.type !== 'local' && extension.type !== 'global') throw new Error('无法确认扩展的安装范围');
    const global = extension.type === 'global';
    let info;
    try {
        info = await getJson('/api/extensions/version', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ extensionName: FOLDER, global }),
            signal: timeout(20000),
        });
    } catch (err) {
        throw new Error(`查询扩展仓库失败：${errorReason(err)}`);
    }
    if (typeof info?.isUpToDate !== 'boolean' || typeof info?.remoteUrl !== 'string') throw new Error('酒馆返回的仓库信息格式不正确');
    rememberRepo(info);
    if (!info.remoteUrl) throw new Error('当前安装没有仓库来源信息，无法检查更新');
    if (githubRepo(info.remoteUrl) && !info.currentBranchName) throw new Error('仓库未提供分支信息，无法读取远程版本');
    return { ...info, global };
}

/** Checks the repo. Also run from the settings page ("检查更新"). One check runs at a time. */
export function checkForUpdates({ prompt = true, manual = true } = {}) {
    if (running) {
        if (!manual || runningManual) return running;
        // A manual click must not inherit an automatic check's deferred/quiet result.
        queuedManual ||= running.catch(() => {}).then(() => checkForUpdates({ prompt, manual: true }))
            .finally(() => { queuedManual = null; });
        return queuedManual;
    }
    runningManual = manual;
    running = runCheck(prompt, manual).finally(() => {
        running = null;
    });
    return running;
}

/** Checks again when the last check is older than `ms`, e.g. when the user opens the extensions panel. */
export function recheckIfOld(ms = RECHECK_MS) {
    if (running || (state.at && Date.now() - state.at < ms)) return;
    checkForUpdates({ manual: false }).catch(err => console.warn('[API Vault] update check failed', err));
}

async function runCheck(prompt, manual) {
    state.error = '';
    state.deferred = false;
    state.updatable = false;
    state.remote = '';
    state.notices = [];
    state.busy = true;
    emit();
    try {
        const local = await getJson(new URL('../manifest.json', import.meta.url).href).catch(err => {
            throw new Error(`读取本地版本失败：${errorReason(err)}`);
        });
        state.local = String(local?.version || '');
        if (!state.local) throw new Error('本地版本文件没有有效版本号');
        // TT emits backend errors independently of fetch. Only an explicit user action
        // may call discover/version; automatic checks never invoke those commands.
        if (manual && !git) {
            git = await gitInfo();
            gitLocal = state.local;
        }
        // ST's "behind origin" answer holds while the installed version is the one it was given for;
        // after an update from "管理扩展" (no reload yet) only the version numbers below count.
        state.updatable = manual && !!git && git.isUpToDate === false && state.local === gitLocal;
        const source = cachedRepo() || (!manual && declaredRepo(local));
        if (source) {
            const raw = f => `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.branch}/${f}`;
            const cdn = f => `https://cdn.jsdelivr.net/gh/${source.owner}/${source.repo}@${source.branch}/${f}`;
            const [remote, notice] = await Promise.all([
                firstJson([raw('manifest.json'), cdn('manifest.json')]).catch(err => {
                    throw new Error(`读取远程版本失败：${errorReason(err)}`);
                }),
                firstJson([raw('notice.json'), cdn('notice.json')]).catch(() => null),
            ]);
            if (typeof remote?.version !== 'string' || !remote.version.trim()) throw new Error('远程版本文件没有有效版本号');
            state.remote = remote.version;
            state.notices = normNotices(notice);
            // A higher version number in the repo counts too, even if ST's git check missed it.
            if (state.remote && state.local && compareVersions(state.remote, state.local) > 0) state.updatable = true;
        } else if (!manual) {
            state.deferred = true;
        }
    } catch (err) {
        state.updatable = false;
        if (manual) state.error = errorReason(err);
        else state.deferred = true;
    }
    state.checked = true;
    state.busy = false;
    state.at = Date.now();
    updateBadges();
    emit();
    if (!state.error && !state.deferred && prompt && store.options.notices !== false) await maybePrompt();
    return state;
}

// ---------- marks ----------

/**
 * "New!" means "an update is waiting". It sits only on the extensions-panel drawer title and
 * goes away once the installed version is the newest; nothing is shown after updating.
 */
export function updateBadges() {
    const host = document.querySelector('#avm_settings .inline-drawer-header');
    if (!host) return;
    let el = host.querySelector('.avm-new');
    if (!state.updatable) {
        el?.remove();
        return;
    }
    if (!el) {
        el = document.createElement('span');
        el.className = 'avm-new';
        el.textContent = 'New!';
        // ST lays the header out with space-between, so a third child would be pushed to the middle
        // and the title with it. Inside the title the mark sits right after the name, like other plugins.
        const title = host.querySelector('b');
        if (title) title.append(el);
        else host.prepend(el);
    }
    el.title = `有新版本${state.remote ? ` ${state.remote}` : ''}，打开通用钥匙API管理器的设置页点「更新」`;
}

// ---------- popups ----------

async function confirm(html, ok, cancel) {
    try {
        if (ctx.callGenericPopup && ctx.POPUP_TYPE) {
            const type = cancel ? ctx.POPUP_TYPE.CONFIRM : ctx.POPUP_TYPE.TEXT;
            const r = await ctx.callGenericPopup(html, type, '', { okButton: ok, cancelButton: cancel || false, allowVerticalScrolling: true });
            return r === (ctx.POPUP_RESULT?.AFFIRMATIVE ?? 1) || r === true;
        }
    } catch { /* fall through */ }
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return cancel ? window.confirm(text) : (window.alert(text), true);
}

function noticeHtml(n, head) {
    return `<div class="avm-root avm-notice">
        <h3>${esc(head)}</h3>
        ${n?.title ? `<div class="avm-notice-title">${esc(n.title)}${n.date ? ` <small>${esc(n.date)}</small>` : ''}</div>` : ''}
        ${n?.content ? `<div class="avm-notice-body">${renderNotice(n.content)}</div>` : ''}
    </div>`;
}

/** Only `major` notices pop up: one offering the update, and one after updating to that version. */
async function maybePrompt() {
    const u = meta();
    const pending = state.updatable && majorNoticeToPrompt(state.notices, state.local, u.dismissed);
    if (pending) {
        const ok = await confirm(
            `${noticeHtml(pending, `${TITLE}发现新版本 ${pending.version}`)}<p class="avm-notice-foot">更新完成后，SillyTavern 会自动刷新页面。</p>`,
            '更新', '稍后',
        );
        if (ok) {
            await runUpdate();
            return;
        }
        u.dismissed = [...u.dismissed, pending.id].slice(-50);
        store.save();
    }
    // Nothing is shown after updating: the user already has it.
}

/** Pulls the repo through ST's own updater, then reloads so the new code runs. */
export async function runUpdate() {
    try {
        // An automatic public-file check has no authority to choose an install scope.
        if (!git) {
            git = await gitInfo();
            gitLocal = state.local;
        }
        const res = await fetch('/api/extensions/update', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ extensionName: FOLDER, global: git.global }),
        });
        if (!res.ok) throw new Error((await res.text()) || res.statusText);
        toastr.success('更新完成，正在刷新页面…', TITLE, { timeOut: 1500 });
        setTimeout(() => location.reload(), 1200);
        return true;
    } catch (err) {
        toastr.error(`更新失败：${esc(err?.message || String(err))}。可以在酒馆的「扩展 → 管理扩展」里手动更新。`, TITLE);
        return false;
    }
}

/** Every announcement, newest first, for the settings page. */
export async function showChangelog() {
    const body = state.notices.length
        ? state.notices.map(n => `<section class="avm-notice-item">
            <div class="avm-notice-title">${esc(n.title || n.version)} <small>${esc([n.version, n.date].filter(Boolean).join(' · '))}</small></div>
            <div class="avm-notice-body">${renderNotice(n.content)}</div>
        </section>`).join('')
        : '<p>还没有公告，或者暂时连不上 GitHub。</p>';
    await confirm(`<div class="avm-root avm-notice"><h3>${TITLE} 更新日志</h3>${body}</div>`, '关闭', '');
}

export function initUpdates(context) {
    ctx = context;
    // Network checks run after startup work, and never block it.
    setTimeout(() => recheckIfOld(0), 6000);
    // Opening ST's extensions panel is when the "New!" mark is looked for, so check again then.
    document.addEventListener('click', e => {
        if (e.target.closest?.('#extensions-settings-button')) recheckIfOld();
    }, true);
    setInterval(() => recheckIfOld(), 60 * 60 * 1000);
}
