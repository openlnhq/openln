export class PluginRegistry {
    plugins = new Map();
    register(p) { if (!/^[a-z][a-z0-9-]{1,62}$/.test(p.id))
        throw new Error(`Invalid plugin id: ${p.id}`); if (this.plugins.has(p.id))
        throw new Error(`Plugin already registered: ${p.id}`); this.plugins.set(p.id, p); }
    list() { return [...this.plugins.values()]; }
    get(id) { return this.plugins.get(id); }
}
