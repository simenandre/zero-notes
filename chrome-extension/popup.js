const { isNoteKey, notesForSite, pageUrl, savedPages, siteFor, siteKey } = LocalTextNotesSites;
const search = document.querySelector("#search");
const list = document.querySelector("#pages");
const pageTemplate = document.querySelector("#page-row");
const pagesStatus = document.querySelector("#pages-status");
const currentSiteRow = document.querySelector("#current-site");
const siteLabel = document.querySelector("#site");
const status = document.querySelector("#status");
const siteToggle = document.querySelector("#site-toggle");
const downloadButton = document.querySelector("#download");
const cliButton = document.querySelector("#cli");
const deleteButton = document.querySelector("#delete-site");
const deleteConfirm = document.querySelector("#delete-confirm");
const deletePrompt = document.querySelector("#delete-prompt");
const cancelDelete = document.querySelector("#cancel-delete");
const confirmDelete = document.querySelector("#confirm-delete");
let pages = [];
let pagesLoaded = false;
let pagesVersion = 0;
let currentPage;
let site;
let enabled = false;

function setStatus(message = "") {
  status.textContent = message;
  status.hidden = !message;
}

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result) throw new Error("Could not reach Zero Notes. Try again.");
  if (result.error) throw new Error(result.error);
  return result;
}

function displayURL(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function pageTitle(page) {
  if (page.title) return page.title;
  const address = new URL(page.url);
  const route = address.hash ? address.hash.slice(1) : address.pathname;
  return displayURL(route.split("/").filter(Boolean).at(-1) || address.host || address.pathname);
}

function searchText(value) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim().replace(/\s+/gu, " ");
}

function searchWords(value) {
  return value.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function typoDistance(term, word) {
  const limit = term.length < 3 ? 0 : term.length < 6 ? 1 : 2;
  if (!limit || Math.abs(term.length - word.length) > limit) return Infinity;
  let previous = Array.from({ length: word.length + 1 }, (_, i) => i);
  let beforePrevious;
  for (let i = 1; i <= term.length; i++) {
    const row = [i];
    for (let j = 1; j <= word.length; j++) {
      const substitution = previous[j - 1] + Number(term[i - 1] !== word[j - 1]);
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, substitution);
      if (i > 1 && j > 1 && term[i - 1] === word[j - 2] && term[i - 2] === word[j - 1]) {
        row[j] = Math.min(row[j], beforePrevious[j - 2] + 1);
      }
    }
    beforePrevious = previous;
    previous = row;
  }
  return previous[word.length] <= limit ? previous[word.length] : Infinity;
}

function wordScore(term, words) {
  if (words.includes(term)) return 0;
  if (words.some(word => word.startsWith(term))) return 1;
  if (words.some(word => word.includes(term))) return 2;
  return 2 + Math.min(...words.map(word => typoDistance(term, word)));
}

function pageScore(page, query, terms) {
  if (page.searchFields.includes(query)) return 0;
  if (page.searchFields.some(field => field.startsWith(query))) return 1;
  if (page.searchFields.some(field => field.includes(query))) return 2;
  if (!terms.length) return Infinity;
  return 3 + terms.reduce((score, term) => score + wordScore(term, page.words), 0);
}

function renderPages() {
  if (!pagesLoaded) return;
  const query = searchText(search.value);
  const terms = searchWords(query);
  const matches = !query ? pages : pages.map(page => ({ page, score: pageScore(page, query, terms) }))
    .filter(match => Number.isFinite(match.score)).sort((a, b) => a.score - b.score).map(match => match.page);
  const rows = document.createDocumentFragment();
  for (const page of matches) {
    const row = pageTemplate.content.cloneNode(true);
    const link = row.querySelector("a");
    link.href = page.url;
    link.title = page.url;
    if (page.url === currentPage) link.setAttribute("aria-current", "page");
    row.querySelector(".page-title").textContent = page.title;
    row.querySelector(".page-url").textContent = page.address;
    row.querySelector(".page-count").textContent = page.count + (page.count === 1 ? " note" : " notes");
    rows.append(row);
  }
  list.replaceChildren(rows);
  list.hidden = !matches.length;
  pagesStatus.hidden = Boolean(matches.length);
  pagesStatus.textContent = pages.length ? "No matching pages." : "No saved pages yet.";
  renderSiteTools();
}

async function refreshPages() {
  const version = ++pagesVersion;
  try {
    const saved = await savedPages();
    if (version !== pagesVersion) return;
    pages = saved.map(page => {
      const title = pageTitle(page);
      const address = displayURL(page.url);
      const shortAddress = address.replace(/^https?:\/\//u, "").replace(/\/$/u, "");
      const searchFields = [title, address, page.url, shortAddress].map(searchText);
      const words = [...new Set(searchFields.flatMap(searchWords))];
      return { ...page, title, address, searchFields, words };
    });
    pagesLoaded = true;
    renderPages();
  } catch {
    if (version !== pagesVersion) return;
    if (pagesLoaded) setStatus("Could not refresh saved pages.");
    else {
      pagesStatus.textContent = "Could not load saved pages.";
      pagesStatus.hidden = false;
    }
  }
}

async function openPage(url) {
  try {
    if (url !== currentPage) await chrome.tabs.create({ url });
    window.close();
  } catch {
    setStatus("Could not open this page.");
  }
}

search.addEventListener("input", renderPages);
list.addEventListener("click", event => {
  const link = event.target.closest("a");
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  void openPage(link.href);
});

function renderSiteTools() {
  const hasNotes = site && pages.some(page => siteFor(page.url)?.id === site.id);
  deleteButton.hidden = !hasNotes;
  if (!hasNotes) deleteConfirm.hidden = true;
}

async function downloadNotes() {
  downloadButton.disabled = true;
  try {
    const json = JSON.stringify(await notesForSite(site), null, 2) + "\n";
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const name = site.id === "file:///" ? "local-files" : site.label.replace(/[^a-z0-9.-]+/gi, "-");
    const link = document.createElement("a");
    link.href = url;
    link.download = "zero-notes-" + name + ".json";
    link.hidden = true;
    document.body.append(link);
    try {
      link.click();
      setStatus("Download started.");
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  } catch {
    setStatus("Could not download notes. Try again.");
  } finally {
    downloadButton.disabled = false;
  }
}

deleteButton.addEventListener("click", () => {
  deletePrompt.textContent = site.id === "file:///"
    ? "Permanently delete saved notes on all local HTML files?"
    : "Permanently delete saved notes on " + site.label + "?";
  deleteConfirm.hidden = false;
  cancelDelete.focus();
});

function cancelSiteDelete() {
  deleteConfirm.hidden = true;
  deleteButton.focus();
}

cancelDelete.addEventListener("click", cancelSiteDelete);
deleteConfirm.addEventListener("keydown", event => {
  if (event.key === "Escape" && !confirmDelete.disabled) {
    event.preventDefault();
    cancelSiteDelete();
  }
});

confirmDelete.addEventListener("click", async () => {
  deleteButton.disabled = confirmDelete.disabled = cancelDelete.disabled = true;
  try {
    await send({ type: "delete-site-notes", site: site.id });
    deleteConfirm.hidden = true;
    setStatus("Site notes deleted.");
    await refreshPages();
    search.focus();
  } catch (error) {
    setStatus(error.message);
  } finally {
    deleteButton.disabled = confirmDelete.disabled = cancelDelete.disabled = false;
  }
});

function renderSiteAccess() {
  siteToggle.textContent = enabled ? "Disable" : "Enable";
  siteToggle.setAttribute("aria-label", (enabled ? "Disable notes on " : "Enable notes on ") + site.label);
  siteToggle.toggleAttribute("data-enable", !enabled);
}

async function refreshSiteAccess() {
  const stored = await chrome.storage.local.get(siteKey);
  enabled = Boolean(stored[siteKey]?.includes(site.id))
    && await chrome.permissions.contains({ origins: [site.pattern] });
  renderSiteAccess();
}

async function enableSite(tabId) {
  const request = { site: site.id, tabId, requestId: crypto.randomUUID() };
  // Send the intent before invoking the prompt, while the button's user gesture is active.
  const intent = send({ type: "prepare-site-enable", ...request });
  try {
    const [prepared, granted] = await Promise.all([intent, chrome.permissions.request({ origins: [site.pattern] })]);
    if (!granted) {
      await send({ type: "cancel-site-enable", ...request });
      return { declined: true };
    }
    return prepared.enabled ? prepared : await send({ type: "finish-site-enable", ...request });
  } catch (error) {
    await intent.then(() => send({ type: "cancel-site-enable", ...request })).catch(() => {});
    throw error;
  }
}

async function startSitePanel() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentPage = pageUrl(tab?.url);
  site = siteFor(tab?.url);
  if (pages.length) renderPages();
  if (!site) {
    setStatus("Open a web page or local HTML file to enable notes.");
    return;
  }

  siteLabel.textContent = site.label;
  siteLabel.title = site.label;
  currentSiteRow.hidden = false;
  downloadButton.hidden = false;
  downloadButton.addEventListener("click", downloadNotes);
  renderSiteTools();
  if (site.id === "file:///" && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    setStatus('Turn on “Allow access to file URLs” in the extension’s browser settings.');
    return;
  }

  await refreshSiteAccess();
  setStatus();
  siteToggle.hidden = false;
  siteToggle.addEventListener("click", async () => {
    const activate = !enabled;
    siteToggle.disabled = true;
    try {
      if (activate) {
        const result = await enableSite(tab.id);
        if (result.declined) {
          setStatus("Access was declined.");
          return;
        }
        enabled = true;
        setStatus(result.reload ? "Enabled. Reload this page to see its notes." : "");
      } else {
        await send({ type: "set-site", site: site.id, enabled: false, tabId: tab.id });
        enabled = false;
        setStatus("Site disabled. Saved notes kept.");
      }
      renderSiteAccess();
    } catch (error) {
      setStatus(error.message);
    } finally {
      siteToggle.disabled = false;
    }
  });
}

function showCLI(connected) {
  cliButton.textContent = connected ? "Disconnect CLI" : "Connect CLI";
  cliButton.dataset.connected = String(connected);
  cliButton.hidden = false;
}

cliButton.addEventListener("click", async () => {
  const connect = cliButton.dataset.connected !== "true";
  cliButton.disabled = true;
  try {
    if (connect && !await chrome.permissions.request({ permissions: ["nativeMessaging"] })) {
      setStatus("Access was declined.");
      return;
    }
    const result = await send({ type: "cli", action: connect ? "connect" : "disconnect" });
    showCLI(result.connected);
    setStatus(result.connected ? "CLI connected." : "CLI disconnected.");
  } catch (error) {
    setStatus(error.message);
  } finally {
    cliButton.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.keys(changes).some(isNoteKey)) void refreshPages();
  if (siteKey in changes && !siteToggle.hidden && !siteToggle.disabled) {
    void refreshSiteAccess().catch(() => {});
  }
});

void refreshPages();
void startSitePanel().catch(() => setStatus("Could not check access for this page."));
void send({ type: "cli", action: "status" }).then(result => showCLI(result.connected)).catch(() => {});
