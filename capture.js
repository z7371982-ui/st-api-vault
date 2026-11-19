import { store } from './store.js';
import { esc, hashKey, hostOf, urlIdentity } from './vault.js';

const PAGE_SIZE = 20;
const pending = new Map();
const dismissed = new Set();
let saveSelection, layer, returnFocus, opening, saving = false, page = 0;

export const captureEnabled = () => store.options.capture && !store.options.autoImport;

export function initCapture(save) {
    saveSelection = save;
    store.onChange(() => {
        if (!captureEnabled() && !saving) clearDialog();
    });
}

export function offerCaptures(items) {
    if (!captureEnabled() || !items.length) return;
    const single = !pending.size && items.length === 1;
    for (const it of items) {
        // Never merge two masked secrets by the visible ending. ST identifies each one by its own id.
        const id = it.key ? 'pair:' + JSON.stringify([it.key, urlIdentity(it.url)]) : it.ref;
        if (dismissed.has(hashKey(id))) continue;
        let group = pending.get(id);
        if (!group) {
            group = { items: [], checked: single };
            pending.set(id, group);
        }
        if (!group.items.some(other => other.ref === it.ref)) group.items.push(it);
    }
    if (!pending.size) return;
    if (layer) render();
    else if (!opening) opening = setTimeout(openDialog, 0);
}

function clearDialog() {
    clearTimeout(opening);
    opening = null;
    pending.clear();
    page = 0;
    if (!layer) return;
    if (layer.open) layer.close?.();
    layer.remove();
    layer = null;
    window.removeEventListener('resize', positionFallback);
    window.visualViewport?.removeEventListener('resize', positionFallback);
    window.visualViewport?.removeEventListener('scroll', positionFallback);
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
}

function dismiss() {
    if (saving) return;
    for (const id of pending.keys()) dismissed.add(hashKey(id));
    clearDialog();
}

function openDialog() {
    opening = null;
    if (!pending.size || !captureEnabled()) return clearDialog();
    returnFocus = document.activeElement;
    layer = document.createElement('dialog');
    layer.className = 'avm-root avm-capture-layer';
    layer.setAttribute('aria-labelledby', 'avm-capture-title');
    layer.setAttribute('aria-modal', 'true');
    layer.innerHTML = `
        <section class="avm-capture-card">
            <header><span class="avm-capture-mark" aria-hidden="true"><i class="fa-solid fa-key"></i></span>
                <div><small>通用钥匙API管理器</small><h2 id="avm-capture-title" tabindex="-1">发现新密钥</h2></div></header>
            <p data-caption></p>
            <div class="avm-capture-list"></div>
            <nav class="avm-pages" aria-label="新配置翻页" hidden>
                <button type="button" class="avm-btn" data-step="-1">上一页</button><span></span>
                <button type="button" class="avm-btn" data-step="1">下一页</button></nav>
            <p data-status role="status" hidden></p>
            <footer><button type="button" class="avm-btn" data-cancel>取消</button>
                <button type="button" class="avm-btn is-primary" data-add>新增</button></footer>
        </section>`;
    layer.addEventListener('change', e => {
        const input = e.target;
        if (saving || !input.matches('[data-pick]')) return;
        [...pending.values()][Number(input.dataset.pick)].checked = input.checked;
        updateAdd();
    });
    layer.addEventListener('click', e => {
        const button = e.target.closest('button');
        if (!button || saving) return;
        if (button.hasAttribute('data-cancel')) dismiss();
        else if (button.hasAttribute('data-add')) confirmSelection();
        else if (button.dataset.step) {
            page += Number(button.dataset.step);
            render();
            layer.querySelector('.avm-capture-list').scrollTop = 0;
        }
    });
    layer.addEventListener('cancel', e => { e.preventDefault(); dismiss(); });
    layer.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            dismiss();
        } else if (e.key === 'Tab' && layer.classList.contains('is-fallback')) {
            const nodes = [...layer.querySelectorAll('button:enabled,input:enabled')].filter(n => n.getClientRects().length);
            const first = nodes[0], last = nodes[nodes.length - 1];
            if (e.shiftKey && (document.activeElement === first || document.activeElement.tagName === 'H2')) {
                e.preventDefault(); last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault(); first?.focus();
            }
        }
    });
    document.body.append(layer);
    render();
    try {
        layer.showModal();
    } catch {
        // An older WebView can still present the card inside the host's active dialog.
        const host = [...document.querySelectorAll('dialog[open]')].filter(d => d !== layer).pop() || document.body;
        host.append(layer);
        layer.setAttribute('open', '');
        layer.setAttribute('role', 'dialog');
        layer.classList.add('is-fallback');
        positionFallback();
        window.addEventListener('resize', positionFallback);
        window.visualViewport?.addEventListener('resize', positionFallback);
        window.visualViewport?.addEventListener('scroll', positionFallback);
    }
    layer.querySelector('h2').focus({ preventScroll: true });
}

function positionFallback() {
    if (!layer?.classList.contains('is-fallback')) return;
    // ST themes can give fixed children a transformed containing block, including a zero-height body.
    const v = window.visualViewport;
    Object.assign(layer.style, { top: '0', left: '0', width: (v?.width || innerWidth) + 'px', height: (v?.height || innerHeight) + 'px' });
    const rect = layer.getBoundingClientRect();
    layer.style.left = ((v?.offsetLeft || 0) - rect.left) + 'px';
    layer.style.top = ((v?.offsetTop || 0) - rect.top) + 'px';
}

function updateAdd() {
    const count = [...pending.values()].filter(g => g.checked).length;
    const button = layer.querySelector('[data-add]');
    button.textContent = saving ? '保存中…' : pending.size === 1 ? '新增' : `新增（${count}）`;
    button.disabled = saving || !count;
}

function render() {
    const groups = [...pending.values()];
    const many = groups.length > 1;
    if (!many && !saving) groups[0].checked = true;
    layer.querySelector('[data-caption]').textContent = many ? `发现 ${groups.length} 项新配置，请勾选要加入管理器的项。` : '要将这项配置加入管理器吗？';
    const offset = page * PAGE_SIZE;
    layer.querySelector('.avm-capture-list').innerHTML = groups.slice(offset, offset + PAGE_SIZE).map((group, i) => {
        const it = group.items.find(x => x.ref) || group.items[0];
        const secret = it.key || it.keyHint || '';
        const tail = secret ? '••••' + (secret.length > 6 ? secret.slice(-3) : '') : '';
        const name = it.name && it.name !== secret ? it.name : 'API 配置';
        const secretId = many && it.stRef && !it.key ? 'ID ' + it.stRef.id : '';
        const source = [it.source, hostOf(it.url), tail, secretId].filter(Boolean).join(' · ');
        const check = many ? `<input type="checkbox" data-pick="${i + offset}" ${group.checked ? 'checked' : ''} ${saving ? 'disabled' : ''}>` : '';
        return `<label>${check}<span><b>${esc(name)}</b><small>${esc(source)}</small></span></label>`;
    }).join('');
    const pages = Math.ceil(groups.length / PAGE_SIZE);
    const nav = layer.querySelector('nav');
    nav.hidden = pages <= 1;
    nav.querySelector('span').textContent = `${page + 1} / ${pages}`;
    nav.firstElementChild.disabled = saving || page === 0;
    nav.lastElementChild.disabled = saving || page + 1 >= pages;
    layer.querySelector('[data-cancel]').disabled = saving;
    updateAdd();
}

async function confirmSelection() {
    if (saving || !captureEnabled()) return;
    const entries = [...pending];
    const selected = entries.filter(([, g]) => g.checked).map(([, g]) => g.items.slice());
    if (!selected.length) return;
    saving = true;
    render();
    const status = layer.querySelector('[data-status]');
    status.hidden = true;
    try {
        const added = await saveSelection(selected);
        for (const [id] of entries) {
            dismissed.add(hashKey(id));
            pending.delete(id);
        }
        if (!added) toastr.info('所选配置已保存或来源已变更。', '通用钥匙API管理器');
    } catch (err) {
        console.warn('[API Vault] capture save failed', err);
        status.textContent = '暂时无法读取配置，可以重试或取消。';
        status.hidden = false;
    } finally {
        saving = false;
        if (!pending.size || !captureEnabled()) clearDialog();
        else { page = 0; render(); }
    }
}
