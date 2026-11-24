// App identity, read from the <meta> tags at the top of index.html.
// APP_ID prefixes everything this app stores in the browser (database, offline copy),
// so other apps on the same web address don't clash with it.

const meta = (name) => globalThis.document?.querySelector(`meta[name="${name}"]`)?.content?.trim();

const id = meta('app-id');
export const APP_ID = id && /^[a-z0-9-]{1,40}$/i.test(id) ? id : 'period-tracker';
export const APP_VERSION = meta('app-version') || 'dev';
