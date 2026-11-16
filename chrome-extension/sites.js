/* Shared by the service worker, toolbar popup, and content scripts. */
globalThis.LocalTextNotesSites = (() => {
  const noteKeyPrefix = "notes:";

  function parseUrl(value) {
    try {
      return new URL(value);
    } catch {
      return null;
    }
  }

  function siteFor(value) {
    const url = parseUrl(value);
    if (!url) return null;
    if (url.protocol === "file:") {
      return { id: "file:///", pattern: "file:///*", label: "Local HTML files" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.hostname === "chromewebstore.google.com") return null;
    return {
      id: url.origin,
      pattern: `${url.protocol}//${url.hostname}/*`,
      label: url.host
    };
  }

  function pageUrl(value) {
    const url = parseUrl(value);
    if (!url || !siteFor(value)) return null;
    url.username = "";
    url.password = "";
    url.hash = /^#(?:\/|!)/u.test(url.hash) ? url.hash.split(":~:", 1)[0] : "";
    return url.href;
  }

  function noteKey(url) {
    return `${noteKeyPrefix}${url}`;
  }

  function noteRecord(value) {
    return value || { revision: 0, notes: [] };
  }

  function isNoteKey(key) {
    return key.startsWith(noteKeyPrefix);
  }

  async function storedNoteRecords() {
    const stored = await chrome.storage.local.get(null);
    return Object.entries(stored).filter(([key]) => isNoteKey(key));
  }

  async function savedPages() {
    const pages = new Map();
    for (const [key, record] of await storedNoteRecords()) {
      if (!Array.isArray(record?.notes) || !record.notes.length) continue;
      const storedUrl = key.slice(noteKeyPrefix.length);
      const url = pageUrl(storedUrl);
      if (!url || (pages.has(url) && storedUrl !== url)) continue;
      const title = typeof record.title === "string" ? record.title.trim() : "";
      pages.set(url, { url, title, count: record.notes.length });
    }
    return [...pages.values()].sort((a, b) => a.url.localeCompare(b.url));
  }

  async function notesForSite(site) {
    const pages = [];
    for (const [key, record] of await storedNoteRecords()) {
      if (!Array.isArray(record?.notes) || !record.notes.length) continue;
      const url = key.slice(noteKeyPrefix.length);
      if (siteFor(url)?.id === site.id) pages.push({ url, notes: record.notes });
    }
    pages.sort((a, b) => a.url.localeCompare(b.url));
    return { site: site.id, pages };
  }

  async function removeNotesForSite(site) {
    const keys = (await storedNoteRecords()).map(([key]) => key)
      .filter(key => siteFor(key.slice(noteKeyPrefix.length))?.id === site.id);
    if (keys.length) await chrome.storage.local.remove(keys);
  }

  return { siteFor, pageUrl, noteKey, isNoteKey, noteRecord, savedPages, notesForSite, removeNotesForSite, siteKey: "enabledSites" };
})();
