// Firefox runs this as an event page with sites.js loaded first, where importScripts is undefined.
if (typeof importScripts === "function") importScripts("sites.js");

const { siteFor, pageUrl, noteKey, noteRecord, notesForSite, removeNotesForSite, siteKey } = LocalTextNotesSites;
const scriptId = "local-text-notes";
const contentFiles = ["sites.js", "content.js", "local-text-notes.js"];
const pendingAccess = chrome.storage.session ?? chrome.storage.local;
const enableRequestPrefix = "enable-request:";
let queue = Promise.resolve();
let cliPort = null;
let cliReady = false;

function serialize(task) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

async function enabledSites() {
  return (await chrome.storage.local.get(siteKey))[siteKey] || [];
}

async function hasAccess(site) {
  if (site.id === "file:///" && !(await chrome.extension.isAllowedFileSchemeAccess())) return false;
  return chrome.permissions.contains({ origins: [site.pattern] });
}

function matchPatterns(sites) {
  return [...new Set(sites.map(id => siteFor(id).pattern))];
}

async function registerFor(sites) {
  const matches = matchPatterns(sites);
  const [registered] = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] });
  if (!matches.length) {
    if (registered) await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
    return;
  }

  const script = {
    id: scriptId,
    js: contentFiles,
    matches,
    runAt: "document_idle",
    persistAcrossSessions: true
  };
  if (registered) {
    if (registered.matches.join() !== matches.join() || registered.js.join() !== contentFiles.join()) {
      await chrome.scripting.updateContentScripts([script]);
    }
  } else {
    await chrome.scripting.registerContentScripts([script]);
  }
}

async function injectOpenTabs(sites) {
  if (!sites.length) return [];
  const tabs = await chrome.tabs.query({ url: matchPatterns(sites) });
  const eligible = tabs.filter(tab => !tab.discarded && sites.includes(siteFor(tab.url)?.id));
  return Promise.all(eligible.map(async tab => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: contentFiles,
        injectImmediately: true
      });
      return tab.id;
    } catch {
      // Chrome may restrict the page, or the tab may have navigated or closed.
      return null;
    }
  }));
}

async function restoreRegistration(activateOpenTabs) {
  const stored = await enabledSites();
  const accessible = await Promise.all(stored.map(async id => {
    const site = siteFor(id);
    return site && await hasAccess(site) ? id : null;
  }));
  const sites = accessible.filter(Boolean);
  if (sites.length !== stored.length) await chrome.storage.local.set({ [siteKey]: sites });
  await registerFor(sites);
  if (activateOpenTabs) await injectOpenTabs(sites);
}

function reconcile(activateOpenTabs) {
  void serialize(() => restoreRegistration(activateOpenTabs)).catch(error => console.error("Zero Notes:", error));
}

chrome.runtime.onInstalled.addListener(() => reconcile(true));
chrome.runtime.onStartup.addListener(() => reconcile(true));
chrome.permissions.onRemoved.addListener(permissions => {
  if (permissions.permissions?.includes("nativeMessaging")) controlCLI("disconnect");
  if (permissions.origins?.length) reconcile(false);
});
chrome.permissions.onAdded.addListener(permissions => {
  if (permissions.origins?.length) {
    void serialize(enableGrantedSites).catch(error => console.error("Zero Notes:", error));
  }
});

async function changeSite(message) {
  const site = siteFor(message.site);
  if (!site || site.id !== message.site) throw new Error("This page cannot be enabled.");
  const stored = await enabledSites();
  if (!message.enabled) {
    await pendingAccess.remove(enableRequestPrefix + site.id);
    const remaining = stored.filter(id => id !== site.id);
    await chrome.storage.local.set({ [siteKey]: remaining });
    try {
      await registerFor(remaining);
    } finally {
      if (!remaining.some(id => siteFor(id).pattern === site.pattern)) {
        await chrome.permissions.remove({ origins: [site.pattern] }).catch(error => {
          console.warn("Zero Notes could not release site access:", error.message);
        });
      }
    }
    return {};
  }

  if (!(await hasAccess(site))) throw new Error("Chrome hasn’t granted access to this site.");
  const next = [...new Set([...stored, site.id])];
  await registerFor(next);
  try {
    await chrome.storage.local.set({ [siteKey]: next });
  } catch (error) {
    await registerFor(stored);
    throw error;
  }

  const activated = await injectOpenTabs([site.id]);
  return { reload: !activated.includes(message.tabId) };
}

async function enableGrantedSites() {
  const requests = await pendingAccess.get(null);
  for (const [key, request] of Object.entries(requests)) {
    if (!key.startsWith(enableRequestPrefix)) continue;
    const site = siteFor(request?.site);
    if (!site || key !== enableRequestPrefix + site.id || !(request.expires > Date.now())) {
      await pendingAccess.remove(key);
    } else if (!request.result && await hasAccess(site)) {
      const result = await changeSite({ ...request, enabled: true });
      await pendingAccess.set({ [key]: { ...request, result } });
    }
  }
}

async function requestSiteEnable(message) {
  const site = siteFor(message.site);
  if (!site || site.id !== message.site || typeof message.requestId !== "string") {
    throw new Error("Could not identify the site.");
  }
  const key = enableRequestPrefix + site.id;
  if (message.type === "prepare-site-enable") {
    if (await hasAccess(site)) return { ...await changeSite({ ...message, enabled: true }), enabled: true };
    const request = { site: site.id, tabId: message.tabId, requestId: message.requestId, expires: Date.now() + 5 * 60_000 };
    await pendingAccess.set({ [key]: request });
    return { pending: true };
  }

  const request = (await pendingAccess.get(key))[key];
  if (message.type === "cancel-site-enable") {
    if (request?.requestId === message.requestId && !request.result) await pendingAccess.remove(key);
    return {};
  }
  const result = request?.requestId === message.requestId ? request.result : undefined;
  const activated = result ?? await changeSite({ ...message, enabled: true });
  if (request?.requestId === message.requestId) await pendingAccess.remove(key);
  return { ...activated, enabled: true };
}

async function writeNotes(message, sender) {
  const site = siteFor(sender.url);
  const url = pageUrl(message.url);
  if (!site || !url || sender.frameId !== 0 || siteFor(url)?.id !== site.id
    || !(await enabledSites()).includes(site.id)) {
    throw new Error("Zero Notes is disabled here.");
  }
  if (!Number.isSafeInteger(message.revision) || !Array.isArray(message.notes)) {
    throw new Error("Invalid notes update.");
  }

  const key = noteKey(url);
  const current = noteRecord((await chrome.storage.local.get(key))[key]);
  if (current.revision !== message.revision) return { current };
  const record = { revision: current.revision + 1, notes: message.notes };
  const title = (typeof message.title === "string" ? message.title.trim().slice(0, 250) : "")
    || (typeof current.title === "string" ? current.title : "");
  if (record.notes.length && title) record.title = title;
  await chrome.storage.local.set({ [key]: record });
  return { saved: true };
}

async function deleteSiteNotes(message) {
  const site = siteFor(message.site);
  if (!site || site.id !== message.site) throw new Error("Could not identify the site.");
  await removeNotesForSite(site);
  return {};
}

function controlCLI(action) {
  if (action === "disconnect") {
    cliPort?.disconnect();
    cliPort = null;
    cliReady = false;
  }
  if (action !== "connect" || cliPort) return { connected: cliReady };

  return new Promise(resolve => {
    const port = chrome.runtime.connectNative("com.madsolame.zero_notes");
    cliPort = port;
    const timer = setTimeout(() => fail("CLI host timed out. Check the installation and try again."), 5000);

    function fail(error) {
      clearTimeout(timer);
      if (cliPort === port) {
        cliPort = null;
        cliReady = false;
      }
      port.disconnect();
      resolve({ error });
    }

    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message;
      fail(error?.includes("not found")
        ? "Native host not found. Run zero-notes install with this Chrome extension ID. See the README."
        : error || "CLI host disconnected.");
    });
    port.onMessage.addListener(async message => {
      if (cliPort !== port) return;
      if (!cliReady) {
        if (message?.ready !== true) {
          fail(message?.error || "Could not start the CLI host.");
          return;
        }
        clearTimeout(timer);
        cliReady = true;
        resolve({ connected: true });
        return;
      }
      const site = siteFor(message?.site);
      let reply = { error: "Use an HTTP(S) site URL or file:///." };
      if (site) {
        try {
          reply = { data: await notesForSite(site) };
        } catch {
          reply = { error: "Could not read saved notes." };
        }
      }
      if (cliPort === port) port.postMessage(reply);
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const fromPopup = sender.url === chrome.runtime.getURL("popup.html");
  if (message?.type === "cli" && fromPopup) {
    Promise.resolve().then(() => controlCLI(message.action)).then(
      respond,
      error => respond({ error: error.message })
    );
    return true;
  }
  let task;
  if (message?.type === "set-site" && fromPopup) {
    task = () => changeSite(message);
  } else if (fromPopup && ["prepare-site-enable", "finish-site-enable", "cancel-site-enable"].includes(message?.type)) {
    task = () => requestSiteEnable(message);
  } else if (message?.type === "delete-site-notes" && fromPopup) {
    task = () => deleteSiteNotes(message);
  } else if (message?.type === "write-notes" && sender.tab) {
    task = () => writeNotes(message, sender);
  } else {
    return false;
  }
  serialize(task).then(
    result => respond(result),
    error => respond({ error: error.message })
  );
  return true;
});
