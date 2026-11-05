// Settings persistence on top of SillyTavern's extension_settings.
import { MODULE, migrate, createProfile, hashKey } from './vault.js';

let ctx = null;
const listeners = new Set();

export const store = {
    init(context) {
        ctx = context;
        ctx.extensionSettings[MODULE] = migrate(ctx.extensionSettings[MODULE]);
    },

    get settings() {
        return ctx.extensionSettings[MODULE];
    },

    get profiles() {
        return this.settings.profiles;
    },

    get options() {
        return this.settings.options;
    },

    save() {
        ctx.saveSettingsDebounced();
        this.notify();
    },

    /** Re-renders listeners without writing settings, for runtime-only changes like ST's active key. */
    notify() {
        for (const fn of listeners) {
            try {
                fn();
            } catch (err) {
                console.error('[API Vault] listener failed', err);
            }
        }
    },

    onChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },

    get(id) {
        return this.profiles.find(p => p.id === id) || null;
    },

    upsert(data) {
        const existing = data.id ? this.get(data.id) : null;
        const changed = existing && (
            ['url', 'key', 'stMissing'].some(k => k in data && data[k] !== existing[k])
            || ('stRef' in data && JSON.stringify(data.stRef) !== JSON.stringify(existing.stRef))
        );
        // Credential edits invalidate cached tests; a newly tested draft may supply fresh results.
        const reset = changed ? { health: null, models: [], modelsAt: 0 } : {};
        // Remember the replaced key, so plugin fields that still show it can be told apart from hand edits.
        if (existing?.key && 'key' in data && data.key && data.key !== existing.key) {
            const old = hashKey(existing.key);
            reset.prevKeys = [...(existing.prevKeys || []).filter(h => h !== old), old].slice(-10);
        }
        const profile = createProfile({ ...existing, ...reset, ...data, updatedAt: Date.now() });
        if (existing) Object.assign(existing, profile);
        else this.profiles.push(profile);
        this.save();
        return existing || profile;
    },

    remove(id) {
        const s = this.settings;
        s.profiles = s.profiles.filter(p => p.id !== id);
        for (const [fp, b] of Object.entries(s.bindings)) if (b.profileId === id) delete s.bindings[fp];
        this.save();
    },

    /** Drops every profile and binding. Seen refs go too, so a later scan offers everything again. */
    clearAll() {
        const s = this.settings;
        s.profiles = [];
        s.bindings = {};
        s.seenRefs = [];
        this.save();
    },

    touch(id) {
        const p = this.get(id);
        if (!p) return;
        p.usedAt = Date.now();
        p.useCount += 1;
        this.save();
    },

    markSynced(id, stRef) {
        const p = this.get(id);
        if (!p) return;
        this.upsert({ id, stRef, syncedHash: hashKey(p.key) });
    },

    isOutOfSync(p) {
        return !!p.syncTarget && !!p.key && (p.syncedHash !== hashKey(p.key) || p.stRef?.key !== p.syncTarget);
    },

    binding(fp) {
        const b = this.settings.bindings[fp];
        return b && this.get(b.profileId) ? b : null;
    },

    bind(fp, data) {
        this.settings.bindings[fp] = { ...data, at: Date.now() };
        this.save();
    },

    /** @param {[string, object][]} entries fingerprint -> binding data */
    bindMany(entries) {
        const at = Date.now();
        for (const [fp, data] of entries) {
            // A refill that could not tell which plugin it is in keeps the place recorded before.
            const prev = this.settings.bindings[fp];
            const keep = prev?.place?.plugin && !data.place?.plugin ? { place: prev.place } : {};
            this.settings.bindings[fp] = { ...data, ...keep, at };
        }
        this.save();
    },

    /** Patches one binding, e.g. the hash of the value last written into the field. */
    updateBinding(fp, patch) {
        const b = this.settings.bindings[fp];
        if (!b) return;
        Object.assign(b, patch);
        this.save();
    },

    unbind(fp) {
        delete this.settings.bindings[fp];
        this.save();
    },

    bindingsFor(id) {
        return Object.entries(this.settings.bindings).filter(([, b]) => b.profileId === id);
    },

    setOption(name, value) {
        this.options[name] = value;
        this.save();
    },
};
