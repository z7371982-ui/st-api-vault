// 通用钥匙API管理器 · Universal Key — entry point.
import { store } from './src/store.js';
import { st } from './src/st.js';
import { proxy } from './src/proxy.js';
import { initSync, autoImport, scheduleImport, scheduleReconcile } from './src/sync.js';
import { initProbe } from './src/probe.js';
import { initFill } from './src/fill.js';
import { initPanel, openPanel, togglePanel } from './src/panel.js';
import { initUpdates, updateBadges } from './src/update.js';
import { initPresetProtection } from './src/preset.js';
import { initAutoConnect } from './src/autoconnect.js';

function addMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('avm_menu_entry')) return;
    const item = document.createElement('div');
    item.id = 'avm_menu_entry';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.title = '通用钥匙API管理器 · Alt+K';
    item.innerHTML = '<div class="fa-fw fa-solid fa-vault extensionsMenuExtensionButton"></div><span>通用钥匙API管理器</span>';
    item.addEventListener('click', () => openPanel());
    item.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPanel();
        }
    });
    menu.append(item);
}

function addSettingsDrawer() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('avm_settings')) return;
    const box = document.createElement('div');
    box.id = 'avm_settings';
    box.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>通用钥匙API管理器</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p class="avm-drawer-text">集中保存各个 API 的地址和密钥。在任何插件里点进地址或密钥框，旁边会出现一个钥匙按钮，选一个配置就会把地址和密钥一起填好。</p>
                <div class="menu_button menu_button_icon" data-avm-open><i class="fa-solid fa-vault"></i><span>打开通用钥匙API管理器</span></div>
            </div>
        </div>`;
    box.querySelector('[data-avm-open]').addEventListener('click', () => openPanel());
    host.append(box);
}

function registerSlashCommand(ctx) {
    try {
        ctx.registerSlashCommand?.('apivault', () => {
            togglePanel();
            return '';
        }, ['apimgr'], '– 打开 / 关闭通用钥匙API管理器', true, true);
    } catch (err) {
        console.warn('[API Vault] slash command not registered', err);
    }
}

async function init() {
    const ctx = SillyTavern.getContext();
    store.init(ctx);
    initPresetProtection(ctx);
    st.init(ctx);
    proxy.init(ctx);
    initSync(ctx);
    initProbe(ctx);
    initPanel(ctx);
    initFill({ openPanel });
    addMenuEntry();
    addSettingsDrawer();
    registerSlashCommand(ctx);
    initUpdates(ctx);
    initAutoConnect(ctx);
    // The wand menu is rebuilt by ST at times; put the mark back on our entry.
    document.getElementById('extensionsMenuButton')?.addEventListener('click', () => setTimeout(updateBadges, 0));

    const { eventSource, eventTypes } = ctx;
    const on = (name, fn) => eventTypes?.[name] && eventSource.on(eventTypes[name], fn);
    // New key saved in ST: import it. Deleted / switched / renamed in ST, or an extension
    // rewrote its settings: follow the change on linked profiles.
    on('SECRET_WRITTEN', () => {
        if (store.options.autoImport) scheduleImport();
        scheduleReconcile();
    });
    on('SECRET_DELETED', () => scheduleReconcile());
    on('SECRET_ROTATED', () => scheduleReconcile());
    on('SECRET_EDITED', () => scheduleReconcile());
    on('SETTINGS_UPDATED', () => {
        scheduleReconcile(1500);
        if (store.options.autoImport) scheduleImport();
    });

    // Give ST a moment to finish its own secret / settings loading.
    setTimeout(() => {
        const first = store.options.autoImport ? autoImport({ silent: false }) : Promise.resolve();
        first
            .catch(err => console.warn('[API Vault] auto import failed', err))
            .finally(() => scheduleReconcile(0));
    }, 2500);
}

jQuery(() => {
    init().catch(err => console.error('[API Vault] failed to start', err));
});
