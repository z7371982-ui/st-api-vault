// Update notices.
//   - "New!" on the extensions-panel drawer title while the repo has a newer version; gone once updated.
//   - A popup offering the update only for versions marked `"major": true` in notice.json.
//   - Nothing at all after updating.
// notice.json is read from the repo (raw.githubusercontent.com, then jsDelivr). If both fail,
// nothing is shown and nothing is reported: the extension works the same offline.
import { store } from './store.js';
import { compareVersions, normNotices, majorNoticeToPrompt, renderNotice, esc } from './vault.js';

const TITLE = '通用钥匙API管理器';
const TIMEOUT = 8000;
// A page left open for hours must still notice a new version, so the check is repeated
// when the extensions panel is opened, and once an hour, but never more often than this.
// Only the first check asks ST's git endpoint (it runs `git fetch` in the extension folder);
// later ones just read manifest.json from GitHub, so they can never collide with an update
// started from ST's "管理扩展" (two git operations at once make that update fail).
const RECHECK_MS = 10 * 60 * 1000;
// public/scripts/extensions/third-party/<folder>/src/update.js -> "<folder>"
const FOLDER = decodeURIComponent(new URL('..', import.meta.url).pathname.split('/').filter(Boolean).pop() || '');

let ctx = null;
let git = null;
let gitAsked = false;
let gitLocal = ''; // installed version at the time ST's git endpoint was asked
const state = { local: '', remote: '', updatable: false, notices: [], checked: false, error: '', busy: false, at: 0 };
let running = null;
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
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
}

/** "https://github.com/user/repo(.git)" -> { owner, repo }, or null for other hosts. */
function githubRepo(remoteUrl) {
    const m = String(remoteUrl || '').match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i);
    return m ? { owner: m[1], repo: m[2] } : null;
}

/** First URL that answers wins; a blocked GitHub falls through to the CDN mirror. */
async function firstJson(urls) {
    for (const url of urls) {
        try {
            return await getJson(url);
        } catch { /* try the next mirror */ }
    }
    return null;
}

/** Asks ST about this extension's git repo: branch, remote, and whether origin has newer commits. */
async function gitInfo() {
    for (const global of [false, true]) {
        try {
            const res = await fetch('/api/extensions/version', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ extensionName: FOLDER, global }),
                signal: timeout(20000),
            });
            if (res.status === 404) continue;
            if (!res.ok) return null;
            return { ...(await res.json()), global };
        } catch {
            return null;
        }
    }
    return null;
}

/** Checks the repo. Also run from the settings page ("检查更新"). One check runs at a time. */
export function checkForUpdates({ prompt = true } = {}) {
    running ||= runCheck(prompt).finally(() => {
        running = null;
    });
    return running;
}

/** Checks again when the last check is older than `ms`, e.g. when the user opens the extensions panel. */
export function recheckIfOld(ms = RECHECK_MS) {
    if (running || (state.at && Date.now() - state.at < ms)) return;
    checkForUpdates().catch(err => console.warn('[API Vault] update check failed', err));
}

async function runCheck(prompt) {
    state.error = '';
    state.busy = true;
    emit();
    try {
        const local = await getJson(new URL('../manifest.json', import.meta.url).href).catch(() => null);
        state.local = String(local?.version || '');
        if (!gitAsked) {
            gitAsked = true;
            git = await gitInfo();
            gitLocal = state.local;
        }
        // ST's "behind origin" answer holds while the installed version is the one it was given for;
        // after an update from "管理扩展" (no reload yet) only the version numbers below count.
        state.updatable = !!git && git.isUpToDate === false && state.local === gitLocal;
        const gh = githubRepo(git?.remoteUrl);
        if (gh) {
            const branch = git.currentBranchName || 'main';
            const raw = f => `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${branch}/${f}`;
            const cdn = f => `https://cdn.jsdelivr.net/gh/${gh.owner}/${gh.repo}@${branch}/${f}`;
            const [remote, notice] = await Promise.all([
                firstJson([raw('manifest.json'), cdn('manifest.json')]),
                firstJson([raw('notice.json'), cdn('notice.json')]),
            ]);
            state.remote = String(remote?.version || '');
            state.notices = normNotices(notice);
            // A higher version number in the repo counts too, even if ST's git check missed it.
            if (state.remote && state.local && compareVersions(state.remote, state.local) > 0) state.updatable = true;
        } else if (!git) {
            state.error = '没能读取扩展的仓库信息';
        }
    } catch (err) {
        state.error = String(err?.message || err);
    }
    state.checked = true;
    state.busy = false;
    state.at = Date.now();
    updateBadges();
    emit();
    if (prompt && store.options.notices !== false) await maybePrompt();
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
    let el = host.querySelector(':scope > .avm-new');
    if (!state.updatable) {
        el?.remove();
        return;
    }
    if (!el) {
        el = document.createElement('span');
        el.className = 'avm-new';
        el.textContent = 'New!';
        // The drawer toggle is the whole header; keep the mark from looking like a separate button.
        // (after() returns undefined, so `?? prepend` would have moved the mark to the front again.)
        const title = host.querySelector('b');
        if (title) title.after(el);
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
        const res = await fetch('/api/extensions/update', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ extensionName: FOLDER, global: !!git?.global }),
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
