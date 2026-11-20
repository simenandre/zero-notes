(() => {
  if (globalThis.startLocalTextNotesExtension) return;
  const { siteFor, pageUrl, notesInFrame, noteKey, noteRecord, siteKey, embeddedKey } = LocalTextNotesSites;
  const isTop = window === window.top;
  const modeKey = "notesMode";
  const colorPrefix = "highlightColor:";

  function storageFor(url, frame, signal) {
    const key = noteKey(url);
    const read = async () => noteRecord((await chrome.storage.local.get(key))[key]);
    const scoped = record => ({ ...record, notes: notesInFrame(record.notes, frame) });
    function subscribe(listener, matches) {
      const changed = (changes, area) => {
        if (area === "local" && matches(changes)) listener();
      };
      chrome.storage.onChanged.addListener(changed);
      signal.addEventListener("abort", () => chrome.storage.onChanged.removeListener(changed), { once: true });
    }
    return {
      async read() {
        return scoped(await read()).notes;
      },
      async readMode() {
        return (await chrome.storage.local.get(modeKey))[modeKey];
      },
      writeMode(mode) {
        return chrome.storage.local.set({ [modeKey]: mode });
      },
      async readPalette(keys) {
        const saved = await chrome.storage.local.get(keys.map(key => colorPrefix + key));
        return Object.fromEntries(keys.map(key => [key, saved[colorPrefix + key]]));
      },
      writePalettePreference(key, value) {
        return chrome.storage.local.set({ [colorPrefix + key]: value });
      },
      resetPaletteSwatches(keys) {
        return chrome.storage.local.remove(keys.map(key => colorPrefix + key));
      },
      subscribePalette(listener) {
        subscribe(listener, changes => Object.keys(changes).some(key => key.startsWith(colorPrefix)));
      },
      async update(transform) {
        let current = scoped(await read());
        for (let attempt = 0; attempt < 8; attempt++) {
          signal.throwIfAborted();
          const notes = transform(current.notes);
          const result = await chrome.runtime.sendMessage({
            type: "write-notes", url, title: document.title, revision: current.revision, notes
          });
          if (result?.saved) return notes;
          if (!result?.current) throw new Error(result?.error || "Could not save notes.");
          current = scoped(noteRecord(result.current));
        }
        throw new Error("Notes changed too quickly to save.");
      },
      subscribe(listener) {
        subscribe(listener, changes => key in changes);
      }
    };
  }

  let listening = false;
  globalThis.startLocalTextNotesExtension = start => {
    if (listening || document.contentType !== "text/html") return;
    const site = siteFor(location.href);
    if (!site) return;
    listening = true;
    let enabledSites = null;
    let embedded = {};
    let receivedChange = false;
    let activePage = null;
    let controller = null;
    let version = 0;

    function hostsEmbeddedFrame() {
      const patterns = embedded[site.id];
      return Boolean(patterns?.length) && [...document.querySelectorAll("iframe")]
        .some(frame => patterns.includes(siteFor(frame.src)?.pattern));
    }

    // Top frames resolve their own page. Embedded frames get theirs from the extension, which
    // knows the tab's address even when the frame's origin can't read it.
    async function resolvePage() {
      if (!isTop) {
        const context = await chrome.runtime.sendMessage({ type: "frame-context" });
        return context?.url ? context : null;
      }
      const url = enabledSites?.includes(site.id) ? pageUrl(location.href) : null;
      if (!url || !hostsEmbeddedFrame()) return url && { url, frame: null };
      // An enabled embedded frame carries the notes UI, unless this page already has notes of its own.
      const record = noteRecord((await chrome.storage.local.get(noteKey(url)))[noteKey(url)]);
      return notesInFrame(record.notes, null).length ? { url, frame: null } : null;
    }

    async function refreshPage() {
      const run = ++version;
      const page = await resolvePage().catch(() => null);
      if (run !== version) return;
      const id = page && `${page.url}\n${page.frame ?? ""}`;
      if (id === activePage) return;
      controller?.abort();
      controller = null;
      activePage = id;
      if (!page) return;
      controller = new AbortController();
      start({ signal: controller.signal, storage: storageFor(page.url, page.frame, controller.signal) });
    }

    function applyStored(items) {
      if (siteKey in items) enabledSites = items[siteKey] ?? [];
      if (embeddedKey in items) embedded = items[embeddedKey] ?? {};
      void refreshPage();
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !(siteKey in changes || embeddedKey in changes)) return;
      receivedChange = true;
      applyStored(Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.newValue])));
    });
    void chrome.storage.local.get([siteKey, embeddedKey]).then(items => {
      if (!receivedChange) applyStored({ [siteKey]: items[siteKey], [embeddedKey]: items[embeddedKey] });
    }).catch(() => {});
    if (isTop) {
      let pending = 0;
      new MutationObserver(() => {
        if (pending || !embedded[site.id]?.length) return;
        pending = setTimeout(() => {
          pending = 0;
          void refreshPage();
        }, 250);
      }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    }
    window.navigation?.addEventListener("currententrychange", refreshPage);
    window.addEventListener("pageshow", refreshPage);
    window.addEventListener("popstate", refreshPage);
    window.addEventListener("hashchange", refreshPage);
  };
})();
