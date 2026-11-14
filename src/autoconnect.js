// Reconnects to the last working API after a reload.
// ST's own auto-connect (RossAscends-mods.js RA_autoconnect) only runs when its "自动连接" box is ticked,
// tries once at startup and has its retry commented out, so one slow first request leaves the API
// disconnected until the user presses 连接 by hand. This remembers the API that last connected on this
// device and, after a reload, presses the same Connect button ST would, retrying a few times.
import { store } from './store.js';

const MEMO = 'avm_last_connection';
const BUTTONS = {
    openai: '#api_button_openai',
    kobold: '#api_button',
    novel: '#api_button_novel',
    textgenerationwebui: '#api_button_textgenerationwebui',
};
// First check leaves ST's own attempt time to finish; later ones back off.
const DELAYS = [4000, 8000, 15000];
const WAIT_RESULT = 12000;

let ctx = null;
let attempt = 0;
let timer = 0;
let started = false;
let stopped = false;

const live = () => globalThis.SillyTavern?.getContext?.() || ctx;
const storage = () => ctx?.accountStorage || globalThis.localStorage;

/** What is connected right now, in the terms the Connect button needs. */
function current() {
    const c = live();
    const api = c?.mainApi;
    if (!api) return null;
    const source = api === 'openai' ? c.chatCompletionSettings?.chat_completion_source || '' : '';
    return { api, source };
}

function readMemo() {
    try {
        const m = JSON.parse(storage()?.getItem(MEMO) || 'null');
        return m && typeof m.api === 'string' ? m : null;
    } catch {
        return null;
    }
}

function writeMemo(value) {
    try {
        storage()?.setItem(MEMO, JSON.stringify(value));
    } catch { /* storage full or blocked: nothing to remember then */ }
}

const isOnline = status => !!status && status !== 'no_connection';
// ST disables every .api_button while a status check is running.
const isChecking = () => !!document.querySelector('.api_button.disabled');

function stop() {
    stopped = true;
    clearTimeout(timer);
}

function next() {
    if (stopped || attempt >= DELAYS.length) return;
    timer = setTimeout(tryConnect, DELAYS[attempt]);
}

function tryConnect() {
    if (stopped || !store.options.autoConnect) return;
    const c = live();
    if (isOnline(c?.onlineStatus)) return stop();
    const memo = readMemo();
    const now = current();
    // Only the same API and source as last time: never connect to something the user switched away from.
    if (!memo || !now || memo.api !== now.api || (memo.source || '') !== now.source) return stop();
    const button = BUTTONS[now.api] && document.querySelector(BUTTONS[now.api]);
    if (!button) return stop();
    attempt++;
    if (isChecking()) {
        // ST (or the user) is already connecting; look again later instead of stacking a second request.
        timer = setTimeout(tryConnect, WAIT_RESULT);
        return;
    }
    const $ = globalThis.jQuery;
    if ($) $(button).trigger('click');
    else button.click();
    next();
}

export function initAutoConnect(context) {
    ctx = context;
    const { eventSource, eventTypes } = context;
    if (eventTypes?.ONLINE_STATUS_CHANGED) {
        eventSource.on(eventTypes.ONLINE_STATUS_CHANGED, status => {
            if (!isOnline(status)) return;
            const now = current();
            if (now) writeMemo({ ...now, at: Date.now() });
            // Connected, by us, by ST or by hand: the startup job is done.
            stop();
        });
    }
    const start = () => {
        if (started) return;
        started = true;
        next();
    };
    // APP_READY fires once ST has loaded settings and run its own auto-connect; older builds lack it.
    if (eventTypes?.APP_READY) eventSource.on(eventTypes.APP_READY, start);
    setTimeout(start, 6000);
}
