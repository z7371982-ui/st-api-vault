// ST 1.19 / TT 2.2 and 2.4 expose this native setting through getContext().
// The host owns which fields belong to a connection (including TT-only fields).
// Keep a single source of truth instead of saving/restoring credentials or presets.
import { store } from './store.js';

let ctx = null;
let cleanup = () => {};

export const presetProtection = {
    get supported() {
        return typeof ctx?.chatCompletionSettings?.bind_preset_to_connection === 'boolean';
    },
    get enabled() {
        return this.supported && !ctx.chatCompletionSettings.bind_preset_to_connection;
    },
    setEnabled(enabled) {
        if (!this.supported || typeof enabled !== 'boolean') return false;
        ctx.chatCompletionSettings.bind_preset_to_connection = !enabled;
        const checkbox = document.getElementById('bind_preset_to_connection');
        if (checkbox) checkbox.checked = !enabled;
        // Only an initialization marker lives in the vault. The preference itself
        // stays in the native setting, so either UI can change it without a conflict.
        store.options.presetApiProtectionInitialized = true;
        store.save();
        return true;
    },
};

export function initPresetProtection(context) {
    cleanup();
    ctx = context;
    const initialize = () => {
        if (!store.options.presetApiProtectionInitialized) presetProtection.setEnabled(true);
    };
    const onNativeInput = event => {
        if (event.target?.id !== 'bind_preset_to_connection' || !presetProtection.supported) return;
        // The native input handler runs on the target before this document listener.
        store.options.presetApiProtectionInitialized = true;
        store.save();
    };
    const refresh = () => { initialize(); store.notify(); };
    const events = ['APP_READY', 'SETTINGS_LOADED_AFTER']
        .map(name => context.eventTypes?.[name]).filter(Boolean);
    for (const event of events) context.eventSource?.on?.(event, refresh);
    document.addEventListener('input', onNativeInput);
    initialize();
    cleanup = () => {
        for (const event of events) context.eventSource?.removeListener?.(event, refresh);
        document.removeEventListener('input', onNativeInput);
        ctx = null;
    };
    return cleanup;
}
