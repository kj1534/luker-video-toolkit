/** Server-owned worker URLs; clients select IDs only. Jobs pin their worker at creation. */
export function createImportWorkers(config) {
    const entries = new Map();
    for (const item of config.import_workers) {
        if (!/^[a-z0-9-]+$/.test(item.id) || entries.has(item.id)) throw new Error('Invalid or duplicate import worker ID');
        const url = new URL(item.url);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid configured import worker URL');
        entries.set(item.id, { ...item, url: item.url.replace(/\/$/, '') });
    }
    if (!entries.has(config.default_import_worker)) throw new Error('Missing default import worker');
    return {
        publicList: [...entries.values()].map(({ id, label, web_imports }) => ({ id, label, web_imports: Boolean(web_imports) })),
        get(id = config.default_import_worker) {
            const worker = entries.get(id);
            if (!worker) throw new Error('Unknown import worker');
            return worker;
        },
    };
}
