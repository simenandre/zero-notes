/* Zero Notes. Load as a classic script with defer. */
(() => {
  "use strict";

  const script = document.currentScript;
  const excluded = "script, style, noscript, template, [hidden], local-text-notes, local-text-notes-inline";
  const annotationExcluded = '[data-local-notes-ignore], input, textarea, select, button, [contenteditable]:not([contenteditable="false"])';
  const extensionStateEvent = "local-text-notes-extension-state";
  const extensionSelector = "local-text-notes[data-extension]";
  const wordSegmenter = typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

  function firstIndex(items, test) {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (test(items[mid])) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  // Map normalized, searchable text to DOM offsets without wrapping text nodes.
  function indexText(root, annotating) {
    const parts = [];
    const runs = [];
    const blocks = [];
    let block = null;
    let position = 0;
    let space = false;

    function addText(node) {
      for (const match of node.data.matchAll(/\s+|\S+/gu)) {
        const value = match[0];
        if (/^\s/u.test(value)) {
          space = Boolean(block);
          continue;
        }
        if ((space || !block) && position) {
          parts.push(" ");
          position++;
        }
        if (!block) {
          block = { start: position, end: position };
          blocks.push(block);
        }
        parts.push(value);
        runs.push({ node, offset: match.index, start: position, end: position + value.length });
        position += value.length;
        block.end = position;
        space = false;
      }
    }

    function walk(element) {
      if (element.matches(excluded) || (annotating && element.matches(annotationExcluded))) return;
      const style = getComputedStyle(element);
      if (style.display === "none") return;
      const separates = element.localName === "br"
        || (style.display !== "contents" && !style.display.startsWith("inline"));
      if (separates) block = null;
      const closed = element.localName === "details" && !element.open;
      const summary = closed && Array.from(element.children).find(child => child.localName === "summary");
      for (const child of element.childNodes) {
        if (closed && child !== summary) continue;
        if (child.nodeType === Node.ELEMENT_NODE) walk(child);
        else if (child.nodeType === Node.TEXT_NODE && style.visibility === "visible") addText(child);
      }
      if (separates) block = null;
    }

    walk(root);
    return { text: parts.join(""), runs, blocks };
  }

  function offsetsFor(index, range) {
    const { runs } = index;
    const start = range.cloneRange();
    const end = range.cloneRange();
    start.collapse(true);
    end.collapse(false);
    const first = runs[firstIndex(runs, run => start.comparePoint(run.node, run.offset + run.end - run.start) > 0)];
    const last = runs[firstIndex(runs, run => end.comparePoint(run.node, run.offset) >= 0) - 1];
    if (!first || !last) return null;
    const from = first.start + (range.startContainer === first.node ? Math.max(0, range.startOffset - first.offset) : 0);
    const to = last.end - (range.endContainer === last.node
      ? Math.max(0, last.offset + last.end - last.start - range.endOffset)
      : 0);
    return from < to ? { from, to } : null;
  }

  function rangeFor(index, { from, to }) {
    const first = index.runs[firstIndex(index.runs, run => run.end > from)];
    const last = index.runs[firstIndex(index.runs, run => run.end >= to)];
    const range = document.createRange();
    range.setStart(first.node, first.offset + from - first.start);
    range.setEnd(last.node, last.offset + to - last.start);
    return range;
  }

  function fingerprint(index) {
    if (index.fingerprint === undefined) {
      let hash = 2166136261;
      for (let i = 0; i < index.text.length; i++) {
        hash = Math.imul(hash ^ index.text.charCodeAt(i), 16777619);
      }
      index.fingerprint = `${index.text.length}:${hash >>> 0}`;
    }
    return index.fingerprint;
  }

  function anchorFor(index, { from, to }) {
    const exact = index.text.slice(from, to);
    return {
      exact,
      before: index.text.slice(Math.max(0, from - 72), from),
      after: index.text.slice(to, to + 72),
      position: from,
      repeated: index.text.indexOf(exact) !== from || index.text.indexOf(exact, from + 1) !== -1,
      fingerprint: fingerprint(index)
    };
  }

  function locate(index, anchor) {
    const { text } = index;
    const { exact, position, before, after } = anchor;
    if (fingerprint(index) === anchor.fingerprint && text.startsWith(exact, position)) {
      return { from: position, to: position + exact.length };
    }
    let best = null;
    let bestScore = -1;
    let tied = false;
    for (let from = text.indexOf(exact); from !== -1; from = text.indexOf(exact, from + 1)) {
      const to = from + exact.length;
      let left = 0;
      let right = 0;
      while (left < before.length && before.at(-1 - left) === text[from - 1 - left]) left++;
      while (right < after.length && after[right] === text[to + right]) right++;
      // A remaining copy of a repeated quote may belong to a different passage.
      if (anchor.repeated && left < 12 && right < 12) continue;
      const score = left + right;
      if (score > bestScore) {
        bestScore = score;
        best = { from, to };
        tied = false;
      } else if (score === bestScore) {
        tied = true;
      }
    }
    return tied ? null : best;
  }

  function textDirective(index, selection) {
    const { text, blocks } = index;
    const fromBlock = offset => firstIndex(blocks, block => block.end > offset);
    const startBlock = fromBlock(selection.from);
    const endBlock = fromBlock(selection.to - 1);
    const segmentCache = new Map();

    function wordEdge(offset, side) {
      const blockIndex = fromBlock(offset);
      const block = blocks[blockIndex];
      if (!block || offset < block.start) return offset;
      if (!segmentCache.has(blockIndex)) {
        const value = text.slice(block.start, block.end);
        segmentCache.set(blockIndex, wordSegmenter?.segment(value) || value);
      }
      const segments = segmentCache.get(blockIndex);
      if (typeof segments === "string") {
        const left = segments.slice(0, offset - block.start).match(/[\p{L}\p{M}\p{N}_]+$/u)?.[0] || "";
        const right = segments.slice(offset - block.start).match(/^[\p{L}\p{M}\p{N}_]+/u)?.[0] || "";
        if (!right) return offset;
        return side === "start" ? offset - left.length : offset + right.length;
      }
      const segment = segments.containing(offset - block.start);
      if (!segment?.isWordLike) return offset;
      const start = block.start + segment.index;
      return side === "start" ? start : start + segment.segment.length;
    }

    const from = wordEdge(selection.from, "start");
    const to = Math.max(selection.to, wordEdge(selection.to - 1, "end"));
    const quote = text.slice(from, to);
    const prefixEnd = from - (text[from - 1] === " " ? 1 : 0);
    const suffixStart = to + (text[to] === " " ? 1 : 0);
    const prefixBlock = blocks[fromBlock(prefixEnd - 1)];
    const suffixBlock = blocks[fromBlock(suffixStart)];
    const encode = value => encodeURIComponent(value.toWellFormed?.() ?? value).replace(/-/g, "%2D");
    const terms = new Map();

    function matches(term) {
      if (!terms.has(term)) {
        const literal = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const positions = [];
        for (const match of text.matchAll(new RegExp(`(?=${literal})`, "giu"))) {
          const start = match.index;
          const end = start + term.length;
          const block = blocks[fromBlock(start)];
          if (block && end <= block.end && wordEdge(start, "start") === start
            && wordEdge(end, "start") === end) {
            positions.push(start);
          }
        }
        terms.set(term, positions);
      }
      return terms.get(term);
    }

    function pointsToSelection(start, end, prefix, suffix) {
      const starts = matches(start);
      const ends = end ? matches(end) : null;
      const prefixes = prefix ? new Set(matches(prefix)) : null;
      const suffixes = suffix ? new Set(matches(suffix)) : null;
      let found = false;
      for (const startAt of starts) {
        const before = startAt - (text[startAt - 1] === " " ? 1 : 0);
        if (prefixes && !prefixes.has(before - prefix.length)) continue;
        let endAt = startAt + start.length;
        if (ends) {
          let i = firstIndex(ends, position => position >= endAt);
          while (i < ends.length) {
            endAt = ends[i] + end.length;
            const after = endAt + (text[endAt] === " " ? 1 : 0);
            if (!suffixes || suffixes.has(after)) break;
            i++;
          }
          if (i === ends.length) continue;
        } else {
          const after = endAt + (text[endAt] === " " ? 1 : 0);
          if (suffixes && !suffixes.has(after)) continue;
        }
        if (found || startAt !== from || endAt !== to) return false;
        found = true;
      }
      return found;
    }

    function tryTerms(start, end = "") {
      if (pointsToSelection(start, end, "", "")) return [encode(start), end && encode(end)].filter(Boolean).join(",");
      for (const size of [24, 64, 144]) {
        const prefix = prefixBlock && text.slice(wordEdge(Math.max(prefixBlock.start, prefixEnd - size), "start"), prefixEnd).trim();
        const suffix = suffixBlock && text.slice(suffixStart, wordEdge(Math.min(suffixBlock.end, suffixStart + size), "start")).trim();
        for (const [left, right] of [[prefix, ""], ["", suffix], [prefix, suffix]]) {
          if ((left || right) && pointsToSelection(start, end, left, right)) {
            return [left && `${encode(left)}-`, encode(start), end && encode(end), right && `-${encode(right)}`]
              .filter(Boolean).join(",");
          }
        }
      }
      return null;
    }

    if (startBlock === endBlock && quote.length <= 300) {
      const exact = tryTerms(quote);
      if (exact) return exact;
    }
    for (const size of [24, 64, 144]) {
      const startEnd = Math.min(blocks[startBlock].end, from + size, to);
      const endStart = Math.max(blocks[endBlock].start, to - size, from);
      const start = text.slice(from, Math.max(startEnd, wordEdge(startEnd - 1, "end"))).trimEnd();
      const end = text.slice(wordEdge(endStart, "start"), to).trimStart();
      if (start.length + end.length <= quote.length) {
        const directive = tryTerms(start, end);
        if (directive) return directive;
      }
    }
    return null;
  }

  function element(tag, className, label) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (label) item.textContent = label;
    return item;
  }

  function button(label, action, className = "", key = label) {
    const control = element("button", className, label);
    control.type = "button";
    control.dataset.focusKey = key;
    control.addEventListener("click", action);
    return control;
  }

  const logoSource = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAGKADAAQAAAABAAAAGAAAAADiNXWtAAADkklEQVRIDe1UTWxUVRT+7n3vzUz7OsUG6UixrU3DTyJKYiHEFhJDwASjkQ2JKxNj1IVxZeKCBNkQYkwMC9gRd6yILlgQWBirIaht0oCoiUGkqEzpdAi10+kwb9579/Kd9wrMTJvg0gUneS/33XPu953znXMf8MQeo4B6jP8/ua0d8XC7Yz1CbIKnCwjjK2rw0m9yeFUCOw4X68c6kNNdMJl10HqYzwiUMwCrPcCtc92ANVkgLsA2+mHCfjhRN7iDangTJt6mNk5U3Acp2hu7X0S28z3E3hYotwDoNeTPkyqPLtetlSNc/X0JsCFe2GTgF5hb0CB+xCcmjAFCy7UgqgK87FouHhHA2s/QGe9HjYcMAx88GeDsmXl8fKyIm7cCOY3nns3gi0N9eHN/D9BgbLOlnw6CUGqBlpe1Bx2+BrBYB+okaIRAxMy0wfSf9/DhkVv4eybEru157NqRxz+zEfdmMH2DhO4qKmt4yCqyLxOgXO5gN/JSZYt5Cl+fX0BxNsTWzTmc+3II504NYbg/i2IpxFcXFgDGtJhUkNGKWMOyn1SAhQY1x9OsQvYeWWQx8XONJQK7R3z4fRl8P1llBQ1kCDwpPsasMOLzTK/spwQgm6c6WypgjAksbpcpF9cDGzKo3Ynw6fESBkmkCSI+iVl9FlWiR0qgKY+wtlnI7Or1FKCn28HnJ2bxzDoX77+1lgNkEp/ErDAZEIt52U/HVGnO9IowKHIqpiByfHOpismrtaQP3/1YTdQUn8SsMCHVmJH9tAJjlpKxbIv0CNztaziOYkP/xdsHerD5JR9zdzlhxBCfxLSYfEY2RkOXZD8lgBO06C8eAqisxlB/BkFg8PzGHD75gH3jZbo2zfGkX3wS01J9yhcgpxabCAwj5bPNuLdvLJ/oMF+JMfVrDRfHKxj/qQrN+d87Kr62MySmKYRRknzaA6u6QBkQp96HR9jI1/etwSs7fXz7QxWvvTuduCqLMfYQ/I1X+Tdpv8lCaNlbZRPq5SazB3ZZrYfoXHDQfOp8+vggjp4sYeLyUjJsY7wThz/qhf8UMUIG6abERLE6LqoyigKVsNjro70ch1/Q5fQmP6ykAULAg9QfsZGu1qpL8Zw19k7eVxWSz0RhPEcE3jYdkdlojUArXUTNXFDbp3jNmxS0f4y+bBzzjgrNBhvbKl1/Ef6ajc11F6YE37uLXLSIvql7zKopZYF5Yv9nBe4DI+9lle3hiZ0AAAAASUVORK5CYII=";
  const paths = {
    close: "M4 4l8 8m0-8-8 8",
    chevron: "m6 3.5 4 4.5-4 4.5",
    comment: "M2.5 3.5h11v7H8l-3 2.5v-2.5H2.5z",
    palette: "M8 2.5a5.5 5.5 0 0 0 0 11h1.1a1.3 1.3 0 0 0 .9-2.2 1 1 0 0 1 .7-1.8H12a1.5 1.5 0 0 0 1.5-1.5A5.5 5.5 0 0 0 8 2.5Zm-3 5h.1m1.5-2h.1m2.6-.2h.1m2 1.8h.1",
    resolve: "m5 8 2 2 4-4",
    reopen: "M5.3 7a2.8 2.8 0 1 1 .6 3.2m-.6-5v2h2",
    delete: "m6 6 4 4m0-4-4 4",
    copy: "M5.5 5.5h7v7h-7zm5-2v-1h-8v8h1",
    link: "m6.5 9.5 3-3M6 6 3.5 8.5a2.8 2.8 0 0 0 4 4L10 10M6 6l2.5-2.5a2.8 2.8 0 0 1 4 4L10 10",
    trash: "M3 4.5h10m-6.5 0V3h3v1.5M4.5 5l.7 8h5.6l.7-8m-5 2.3v3.4m3-3.4v3.4"
  };
  const commentDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  const initialSwatches = ["#f2c73e", "#80d6a3", "#7ebbf5", "#c7a0e8", "#f49891"];
  const swatchKeys = initialSwatches.map((_, i) => `swatch-${i + 1}`);
  const initialPalette = Object.fromEntries(swatchKeys.map((key, i) => [key, initialSwatches[i]]));

  function hexColor(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : undefined;
  }

  function savedSwatch(value) {
    return value === null || (Number.isInteger(value) && value >= 0 && value < swatchKeys.length);
  }

  function withSwatch(note, swatch) {
    const next = { ...note, swatch };
    delete next.color;
    return next;
  }

  function icon(name) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.35");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    if (["resolve", "reopen", "delete"].includes(name)) {
      const circle = document.createElementNS(namespace, "circle");
      circle.setAttribute("cx", "8");
      circle.setAttribute("cy", "8");
      circle.setAttribute("r", "6.3");
      svg.append(circle);
    }
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", paths[name]);
    svg.append(path);
    return svg;
  }

  function iconButton(label, glyph, action, key) {
    const control = button("", action, "icon", key || label);
    control.setAttribute("aria-label", label);
    control.title = label;
    control.append(icon(glyph));
    return control;
  }

  function colorButton(label, color, action, key) {
    const control = button("", action, "icon color-button", key);
    control.setAttribute("aria-label", label);
    control.title = label;
    control.style.setProperty("--swatch", color);
    control.append(element("span", "color-dot"));
    return control;
  }

  function colorInput(label, color, onChange) {
    const input = element("input", "color-input");
    input.type = "color";
    input.value = color;
    input.setAttribute("aria-label", label);
    input.title = label;
    input.addEventListener("change", () => onChange(input.value));
    return input;
  }

  function logo(size) {
    const image = element("img", "logo");
    image.width = size;
    image.height = size;
    image.alt = "";
    image.src = logoSource;
    return image;
  }

  function makeStyle(css) {
    const style = element("style");
    if (script?.nonce) style.nonce = script.nonce;
    style.textContent = css;
    return style;
  }

  function pageStorage(key, signal) {
    const read = () => JSON.parse(localStorage.getItem(key) || "[]");
    const modeKey = "local-text-notes:mode";
    const colorPrefix = "local-text-notes:color:";
    return {
      read,
      readMode: () => localStorage.getItem(modeKey),
      writeMode: mode => localStorage.setItem(modeKey, mode),
      readPalette: keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(colorPrefix + key)])),
      writePalettePreference: (key, value) => localStorage.setItem(colorPrefix + key, value),
      resetPaletteSwatches: keys => keys.forEach(key => localStorage.removeItem(colorPrefix + key)),
      subscribePalette(listener) {
        window.addEventListener("storage", event => {
          if (event.key === null || event.key.startsWith(colorPrefix)) listener();
        }, { signal });
      },
      update(transform) {
        const commit = () => {
          signal.throwIfAborted();
          const next = transform(read());
          localStorage.setItem(key, JSON.stringify(next));
          return next;
        };
        if (!navigator.locks) return commit();
        let ran = false;
        return navigator.locks.request(key, { signal }, () => {
          ran = true;
          return commit();
        }).catch(error => {
          if (ran || signal.aborted) throw error;
          return commit();
        });
      },
      subscribe(listener) {
        window.addEventListener("storage", event => {
          if (event.key === key || event.key === null) listener();
        }, { signal });
      }
    };
  }

  function start({ signal = new AbortController().signal, storage: extensionStorage } = {}) {
    if (document.querySelector(extensionStorage ? extensionSelector : "local-text-notes")) return;
    const scope = script?.dataset.scope ? document.querySelector(script.dataset.scope) : document.body;
    if (!scope || signal.aborted) return;
    const storageKey = `local-text-notes:v1:${script?.dataset.pageKey || location.pathname + location.search}`;
    const storage = extensionStorage || pageStorage(storageKey, signal);
    const canHighlight = Boolean(window.CSS?.highlights && window.Highlight);
    const prefix = extensionStorage ? "local-text-notes-extension" : "local-text-notes";
    const commentMark = `${prefix}-comment`;
    const resolvedCommentMark = `${prefix}-resolved-comment`;
    const pendingCommentMark = `${prefix}-pending-comment`;
    const palette = { ...initialPalette };
    const colorOverrides = new Map();
    const registeredHighlights = new Set();
    const compact = matchMedia("(max-width: 760px)");
    const railAttribute = "data-local-text-notes-rail";
    const root = document.documentElement;
    const cards = new Map();
    const drafts = new Map();
    const commentEdits = new Map();
    const markers = new Map();
    const annotations = new Map();
    const host = element("local-text-notes");
    if (extensionStorage) host.setAttribute("data-extension", "");
    const ui = host.attachShadow({ mode: extensionStorage ? "closed" : "open" });
    const inline = element("local-text-notes-inline");
    const inlineRoot = inline.attachShadow({ mode: extensionStorage ? "closed" : "open" });
    const annotationLayer = element("div", "annotations");
    const passageBrackets = [element("span", "passage-bracket"), element("span", "passage-bracket")];
    for (const bracket of passageBrackets) {
      bracket.hidden = true;
      bracket.setAttribute("aria-hidden", "true");
    }
    const panel = element("aside", "panel");
    panel.id = "notes-panel";
    panel.setAttribute("aria-labelledby", "notes-title");
    panel.hidden = true;
    const heading = element("h2", "", "Notes");
    heading.id = "notes-title";
    heading.tabIndex = -1;
    heading.dataset.focusKey = "title";
    const headingCount = element("span", "count");
    const header = element("header");
    const sidebarModes = modeSwitch();
    const paletteButton = iconButton("Highlight palette", "palette", togglePalette, "palette");
    paletteButton.setAttribute("aria-controls", "highlight-palette");
    paletteButton.setAttribute("aria-expanded", "false");
    const copyAllButton = iconButton("Copy notes as Markdown", "copy", copyMarkdown);
    header.append(logo(24), heading, headingCount, sidebarModes, paletteButton, copyAllButton, iconButton("Hide notes", "close", close));
    const palettePanel = element("div", "color-panel");
    palettePanel.id = "highlight-palette";
    palettePanel.hidden = true;
    const swatchRow = element("div", "color-row");
    const swatchLabel = element("div", "swatch-label", "Colors");
    const resetSwatches = button("Reset", resetPaletteSwatches, "color-text-button", "reset-swatches");
    resetSwatches.setAttribute("aria-label", "Reset swatch colors");
    resetSwatches.title = "Restore the original swatch colors";
    swatchLabel.append(resetSwatches);
    const swatchInputs = swatchKeys.map((key, i) => colorInput(`Edit swatch ${i + 1}`, palette[key], color => setPalettePreference(key, color)));
    const swatchGroup = element("div", "color-options");
    swatchGroup.append(...swatchInputs);
    swatchRow.append(swatchLabel, swatchGroup);
    palettePanel.append(swatchRow);
    const notice = element("div");
    const railViewport = element("div", "rail-scroll");
    const track = element("div", "rail-track");
    railViewport.append(track);
    panel.append(header, palettePanel, notice, railViewport);
    const indicators = element("nav", "indicators");
    indicators.setAttribute("aria-label", "Comment locations");
    indicators.hidden = true;
    const viewportMarker = element("span", "viewport-marker");
    viewportMarker.setAttribute("aria-hidden", "true");
    indicators.append(viewportMarker);
    const toolbar = element("div", "toolbar");
    toolbar.setAttribute("role", "group");
    toolbar.setAttribute("aria-label", "Mark up selected text");
    toolbar.hidden = true;
    const toolbarSwatches = swatchKeys.map((key, i) =>
      colorButton("", palette[key], () => saveHighlight(i), `highlight-${key}`));
    const status = element("div", "status");
    status.setAttribute("role", "status");
    status.hidden = true;
    const launcherLabel = element("span", "", "Show notes");
    const launcher = button("", () => open ? close() : show("all"), "launcher");
    launcher.append(logo(20), launcherLabel);
    launcher.setAttribute("aria-controls", panel.id);
    launcher.setAttribute("aria-expanded", "false");
    let notes = [];
    let orderedNotes = [];
    let noteNumbers = new Map();
    let persistent = true;
    let index = null;
    let attached = new Map();
    let view = "all";
    let pending = null;
    let open = false;
    let mode = "inline";
    let modeChosen = false;
    let resolved = false;
    let layoutFrame = 0;
    let revealFrame = 0;
    let lastScroll;
    let armedDelete;
    let busy = false;
    let readVersion = 0;
    let refreshPending = false;
    let selecting = false;
    let selectionFrame = 0;
    let refreshTimer = 0;
    let statusTimer = 0;
    let selection = null;
    let editingHighlight = null;
    let paletteOpen = false;
    let colorReadVersion = 0;
    let legacyDefaultSwatch = 0;
    let styledColors;
    let activeRange;
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(queueLayout) : null;

    function modeSwitch() {
      const group = element("div", "modes");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "Notes mode");
      for (const [value, label] of [["inline", "Inline"], ["fixed", "Fixed"]]) {
        const option = button(label, () => chooseMode(value), "", `mode-${value}`);
        option.dataset.mode = value;
        group.append(option);
      }
      return group;
    }

    function markMode(group) {
      for (const option of group.children) option.setAttribute("aria-pressed", String(option.dataset.mode === mode));
    }

    async function restoreMode() {
      try {
        if (await storage.readMode?.() === "fixed" && !signal.aborted && !modeChosen) {
          mode = "fixed";
          render(undefined, true);
        }
      } catch {
        // The default still works when the browser blocks storage.
      }
    }

    async function chooseMode(next) {
      modeChosen = true;
      if (mode !== next) {
        mode = next;
        render(`mode-${next}`, true);
      }
      try {
        await storage.writeMode(next);
      } catch {
        if (!signal.aborted && mode === next) announce("Couldn’t remember the notes mode.");
      }
    }

    function togglePalette() {
      paletteOpen = !paletteOpen;
      render("palette");
    }

    function renderPalette() {
      paletteButton.setAttribute("aria-expanded", String(paletteOpen));
      palettePanel.hidden = !paletteOpen;
      swatchInputs.forEach((input, i) => { input.value = palette[swatchKeys[i]]; });
      toolbarSwatches.forEach((control, i) => {
        const color = palette[swatchKeys[i]];
        const label = `Highlight Color ${i + 1}`;
        control.style.setProperty("--swatch", color);
        control.setAttribute("aria-label", label);
        control.title = label;
      });
      markToolbarColor();
    }

    function applyPalette() {
      paintHighlights();
      render();
    }

    async function refreshPalette() {
      if (!storage.readPalette || signal.aborted) return;
      const version = ++colorReadVersion;
      try {
        const saved = await storage.readPalette([...swatchKeys, "default"]);
        if (signal.aborted || version !== colorReadVersion) return;
        // Preserve the chosen slot for notes saved before the default setting was removed.
        legacyDefaultSwatch = Math.max(0, swatchKeys.indexOf(saved.default));
        const values = Object.fromEntries(swatchKeys.map(key => [key,
          colorOverrides.get(key) ?? hexColor(saved[key]) ?? initialPalette[key]]));
        if (swatchKeys.every(key => values[key] === palette[key])) return;
        Object.assign(palette, values);
        applyPalette();
      } catch {
        // Leave the current palette available when storage is blocked.
      }
    }

    function setPalettePreference(key, value) {
      const preference = hexColor(value);
      if (!preference) return;
      return updatePalette({ [key]: preference }, () => storage.writePalettePreference?.(key, preference));
    }

    function resetPaletteSwatches() {
      const values = Object.fromEntries(swatchKeys.map(key => [key, initialPalette[key]]));
      return updatePalette(values, () => storage.resetPaletteSwatches?.(swatchKeys));
    }

    async function updatePalette(values, write) {
      if (signal.aborted) return;
      try {
        await write();
        for (const key of Object.keys(values)) colorOverrides.delete(key);
      } catch {
        if (signal.aborted) return;
        for (const [key, value] of Object.entries(values)) colorOverrides.set(key, value);
        announce("Couldn’t save these palette changes beyond this tab.");
      }
      if (signal.aborted) return;
      Object.assign(palette, values);
      applyPalette();
      void refreshPalette();
    }

    function validNotes(stored) {
      if (!Array.isArray(stored)) throw new Error("Invalid notes");
      return stored.filter(note => typeof note?.id === "string"
        && typeof note.anchor?.exact === "string" && note.anchor.exact
        && typeof note.anchor.before === "string" && typeof note.anchor.after === "string"
        && Array.isArray(note.comments));
    }

    async function refreshNotes() {
      await paletteReady;
      if (!persistent || signal.aborted) return;
      if (busy) {
        refreshPending = true;
        return;
      }
      const version = ++readVersion;
      let next;
      try {
        next = validNotes(await storage.read());
      } catch {
        if (!signal.aborted && version === readVersion) {
          persistent = false;
          render();
        }
        return;
      }
      if (signal.aborted || version !== readVersion) return;
      notes = next;
      const needsSwatch = note => !savedSwatch(note.swatch);
      if (notes.some(needsSwatch)) {
        if (!await change(items => items.map(note => needsSwatch(note) ? withSwatch(note, noteSwatch(note)) : note))) return;
      } else paint();
      render();
    }

    async function change(update) {
      if (busy || signal.aborted) return false;
      busy = true;
      readVersion++;
      let next;
      try {
        if (persistent) {
          try {
            next = await storage.update(items => {
              signal.throwIfAborted();
              next = update(validNotes(items));
              return next;
            });
          } catch {
            if (signal.aborted) return false;
            persistent = false;
            announce("Browser storage is unavailable. Changes will last until you reload.");
          }
        }
        if (signal.aborted) return false;
        notes = next ?? update(notes);
        paint();
        return true;
      } finally {
        busy = false;
        if (refreshPending) {
          refreshPending = false;
          void refreshNotes();
        }
      }
    }

    function paint() {
      attached = new Map();
      if (notes.length) {
        index ??= indexText(scope, true);
        for (const note of notes) {
          const match = locate(index, note.anchor);
          if (!match) continue;
          const range = rangeFor(index, match);
          attached.set(note.id, { ...match, range });
        }
      }
      paintHighlights();
      orderedNotes = notesInPageOrder(notes);
      noteNumbers = new Map(orderedNotes.map((note, i) => [note.id, i + 1]));
      syncAnnotations();
    }

    function paintHighlights() {
      if (!canHighlight) return;
      const layers = new Map();
      for (const note of notes) {
        const range = attached.get(note.id)?.range;
        if (!range) continue;
        const threaded = note.comments.some(comment => !comment.resolved);
        const color = noteColor(note);
        const name = color ? highlightName(color, threaded ? "thread" : "mark")
          : threaded ? commentMark : resolvedCommentMark;
        if (!layers.has(name)) {
          const layer = new Highlight();
          layer.priority = threaded ? 1 : 0;
          layers.set(name, layer);
        }
        layers.get(name).add(range);
      }
      updateHighlightStyles();
      for (const name of registeredHighlights) if (!layers.has(name)) CSS.highlights.delete(name);
      registeredHighlights.clear();
      for (const [name, layer] of layers) {
        CSS.highlights.set(name, layer);
        registeredHighlights.add(name);
      }
    }

    function noteSwatch(note) {
      if (savedSwatch(note.swatch)) return note.swatch;
      if (note.id === "new" || note.comments.length) return null;
      if (note.swatch === "default") return legacyDefaultSwatch;
      const color = hexColor(note.color);
      if (!color) return legacyDefaultSwatch;
      const current = swatchKeys.findIndex(key => palette[key] === color);
      const index = current >= 0 ? current : initialSwatches.indexOf(color);
      return index >= 0 ? index : legacyDefaultSwatch;
    }

    function noteColor(note) {
      const swatch = noteSwatch(note);
      return swatch === null ? undefined : palette[swatchKeys[swatch]];
    }

    function highlightName(color, kind) {
      return `${prefix}-${kind}-${color.slice(1)}`;
    }

    function updateHighlightStyles() {
      const colors = [...new Set(notes.map(noteColor).filter(Boolean))].sort();
      const key = colors.join();
      if (key === styledColors) return;
      styledColors = key;
      function rules(dark) {
        const underline = dark ? "#e2b444" : "#b58a20";
        const resolvedUnderline = dark ? "#918b79" : "#827969";
        const comments = `
          ::highlight(${commentMark}), ::highlight(${pendingCommentMark}) { text-decoration: underline ${underline}; }
          ::highlight(${resolvedCommentMark}) { text-decoration: underline ${resolvedUnderline}; }
        `;
        return comments + colors.map(color => {
          const base = dark && color === initialSwatches[0] ? "#efb833" : color;
          const threadLine = color === initialSwatches[0] ? underline : color;
          return `
            ::highlight(${highlightName(color, "mark")}) { background-color: ${base}${dark ? "50" : "66"}; }
            ::highlight(${highlightName(color, "thread")}) { background-color: ${base}${dark ? "66" : "80"}; text-decoration: underline ${threadLine}; }
          `;
        }).join("");
      }
      setHighlightStyles(`${rules(false)} @media (prefers-color-scheme: dark) { ${rules(true)} }`);
    }

    function announce(message) {
      status.textContent = message;
      status.hidden = false;
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => { status.hidden = true; }, 3400);
    }

    function hideToolbar() {
      toolbar.hidden = true;
      selection = null;
      editingHighlight = null;
    }

    function markToolbarColor() {
      const note = editingHighlight && notes.find(note => note.id === editingHighlight);
      const swatch = note ? noteSwatch(note) : null;
      if (editingHighlight && (swatch === null || !attached.has(editingHighlight))) hideToolbar();
      toolbar.setAttribute("aria-label", editingHighlight ? "Edit highlight" : "Mark up selected text");
      toolbarSwatches.forEach((control, i) => {
        if (editingHighlight) control.setAttribute("aria-pressed", String(i === swatch));
        else control.removeAttribute("aria-pressed");
      });
    }

    function placeToolbar(box, above = box.top, center = (box.left + box.right) / 2) {
      toolbar.hidden = false;
      const width = root.clientWidth;
      const height = innerHeight;
      const left = Math.min(width - toolbar.offsetWidth - 8, center - toolbar.offsetWidth / 2);
      const below = box.bottom + 8;
      const top = below + toolbar.offsetHeight < height - 8 ? below : Math.max(8, above - toolbar.offsetHeight - 8);
      toolbar.style.left = `${Math.max(8, left)}px`;
      toolbar.style.top = `${top}px`;
    }

    function editHighlight(note, box, x) {
      selection = null;
      editingHighlight = note.id;
      markToolbarColor();
      placeToolbar(box, box.top, x);
      toolbarSwatches[noteSwatch(note)]?.focus({ preventScroll: true });
    }

    function updateToolbar() {
      if (selectionFrame) return;
      selectionFrame = requestAnimationFrame(() => {
        selectionFrame = 0;
        const current = document.getSelection();
        if (selecting || !current?.rangeCount || current.isCollapsed || !current.toString().trim()) {
          if (!editingHighlight) hideToolbar();
          return;
        }
        const range = current.getRangeAt(0);
        const parents = [range.startContainer, range.endContainer].map(node =>
          node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
        if (parents.some(parent => !scope.contains(parent) || parent.closest(`${excluded}, ${annotationExcluded}`))) {
          hideToolbar();
          return;
        }
        const width = document.documentElement.clientWidth;
        const height = window.innerHeight;
        const visible = Array.from(range.getClientRects()).filter(rect =>
          rect.width && rect.height && rect.bottom > 0 && rect.top < height && rect.right > 0 && rect.left < width);
        if (!visible.length) {
          hideToolbar();
          return;
        }
        selection = range.cloneRange();
        editingHighlight = null;
        markToolbarColor();
        placeToolbar(visible.at(-1), visible[0].top);
      });
    }

    function selectedAnchor() {
      if (!selection) return null;
      index ??= indexText(scope, true);
      const match = offsetsFor(index, selection);
      if (!match) return null;
      return anchorFor(index, match);
    }

    function id() {
      return globalThis.crypto.randomUUID?.() || Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), n => n.toString(36)).join("-");
    }

    function matchingNote(items, anchor) {
      index ??= indexText(scope, true);
      const target = locate(index, anchor);
      if (!target) return null;
      return items.find(note => {
        const match = locate(index, note.anchor);
        return match?.from === target.from && match.to === target.to;
      });
    }

    async function saveHighlight(swatch) {
      const noteId = editingHighlight;
      const anchor = noteId ? null : selectedAnchor();
      if (!noteId && !anchor) return;
      hideToolbar();
      document.getSelection()?.removeAllRanges();
      const saved = await change(items => {
        const existing = noteId ? items.find(note => note.id === noteId) : matchingNote(items, anchor);
        if (!existing) return anchor ? [{ id: id(), anchor, swatch, comments: [] }, ...items] : items;
        if (noteSwatch(existing) === swatch) return items;
        return items.map(note => note.id === existing.id ? withSwatch(note, swatch) : note);
      });
      if (saved) {
        render();
        announce(persistent ? "Highlight saved." : "Highlight saved for this tab.");
      }
    }

    function startComment() {
      if (editingHighlight) {
        show(editingHighlight, null, "draft");
        return;
      }
      const anchor = selectedAnchor();
      if (!anchor) return;
      const existing = matchingNote(notes, anchor);
      hideToolbar();
      document.getSelection()?.removeAllRanges();
      show(existing?.id || "new", existing ? null : anchor, "draft");
    }

    function show(nextView, anchor = null, focus = "title") {
      if (editingHighlight) hideToolbar();
      if (view !== nextView || anchor) {
        if (nextView === "new") drafts.delete("new");
        resolved = false;
        paletteOpen = false;
      }
      open = true;
      view = nextView;
      pending = anchor;
      render(focus, true);
    }

    function close() {
      if (editingHighlight) hideToolbar();
      view = "all";
      pending = null;
      resolved = false;
      open = false;
      paletteOpen = false;
      drafts.delete("new");
      render();
      launcher.focus({ preventScroll: true });
    }

    function collapse(noteId) {
      if (panel.hidden) {
        close();
        return;
      }
      show("all", null, `note-${noteId}`);
    }

    function jump(note) {
      const match = attached.get(note.id);
      if (!match) return;
      const parent = match.range.startContainer.parentElement;
      parent.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const rect = match.range.getClientRects()[0];
      const bottom = compact.matches && !panel.hidden ? panel.getBoundingClientRect().top : innerHeight;
      if (rect) window.scrollBy({ top: rect.top - bottom / 2, behavior: "instant" });
      queueLayout();
    }

    function openAtPassage(note) {
      // Open first so a sidebar reflow or inline thread is included in the scroll geometry.
      show(note.id, null, `note-${note.id}`);
      jump(note);
    }

    async function copyLink(note) {
      const match = attached.get(note.id);
      if (!match) return;
      const pageIndex = indexText(document.body, false);
      const offsets = offsetsFor(pageIndex, match.range);
      const directive = offsets && textDirective(pageIndex, offsets);
      if (!directive) {
        announce("A unique text link couldn’t be made for this selection.");
        return;
      }
      const url = new URL(location.href);
      const route = /^#(?:\/|!)/u.test(url.hash) ? url.hash.slice(1).split(":~:", 1)[0] : "";
      url.hash = `${route}:~:text=${directive}`;
      try {
        await navigator.clipboard.writeText(url.href);
        announce("Text link copied.");
      } catch {
        const card = cards.get(note.id);
        if (!card) return;
        card.querySelector(".copy-field")?.remove();
        const field = element("input", "copy-field");
        field.readOnly = true;
        field.value = url.href;
        field.setAttribute("aria-label", "Text link to copy");
        card.querySelector(".note-heading").after(field);
        field.focus();
        field.select();
      }
    }

    function markdown() {
      const url = new URL(location.href);
      url.hash = url.hash.split(":~:", 1)[0];
      const lines = [`# ${document.title.trim() || url.href}`, "", url.href];
      for (const note of orderedNotes) {
        lines.push("", `> ${note.anchor.exact}`);
        if (note.comments.length) lines.push("");
        for (const comment of note.comments) {
          const body = comment.body.replace(/\n/gu, "\n  ");
          lines.push(`- ${comment.resolved ? "~~" + body + "~~" : body}`);
        }
      }
      return lines.join("\n") + "\n";
    }

    async function copyMarkdown() {
      const text = markdown();
      try {
        await navigator.clipboard.writeText(text);
        announce("Notes copied as Markdown.");
      } catch {
        notice.querySelector(".copy-field")?.remove();
        const field = element("textarea", "copy-field");
        field.readOnly = true;
        field.rows = 6;
        field.value = text;
        field.setAttribute("aria-label", "Notes as Markdown to copy");
        notice.append(field);
        field.focus();
        field.select();
      }
    }

    async function postComment(event) {
      event.preventDefault();
      const active = view;
      const draft = drafts.get(active);
      const body = draft?.trim();
      if (!body) return;
      const anchor = pending;
      const comment = { id: id(), body, resolved: false, createdAt: new Date().toISOString() };
      let noteId;
      const saved = await change(items => {
        const note = anchor ? matchingNote(items, anchor) : items.find(item => item.id === active);
        noteId = note?.id;
        if (!note && !anchor) return items;
        if (!note) {
          noteId = id();
          return [{ id: noteId, anchor, swatch: null, comments: [comment] }, ...items];
        }
        return items.map(item => item.id === noteId ? { ...item, comments: [...item.comments, comment] } : item);
      });
      if (!saved) return;
      if (drafts.get(active) === draft) drafts.delete(active);
      if (open && active === view && anchor === pending && noteId) {
        pending = null;
        view = noteId;
        resolved = false;
        render("draft");
        const list = cards.get(noteId)?.querySelector(".comment-list");
        if (list) list.scrollTop = list.scrollHeight;
      } else render();
    }

    function changeComments(noteId, update) {
      return change(items => items.flatMap(note => {
        if (note.id !== noteId) return [note];
        const comments = update(note.comments);
        return comments.length || noteSwatch(note) !== null ? [{ ...note, comments }] : [];
      }));
    }

    async function updateComment(noteId, commentId, action, nextId) {
      const saved = await changeComments(noteId, comments => action === "delete"
        ? comments.filter(comment => comment.id !== commentId)
        : comments.map(comment => comment.id === commentId ? { ...comment, resolved: !comment.resolved } : comment));
      if (!saved) return;
      if (action === "delete") commentEdits.delete(commentId);
      if (!notes.some(note => note.id === noteId)) renderAfterRemovingNote(noteId);
      else render(view === noteId && open ? nextId ? `${action}-${nextId}` : "draft" : undefined);
    }

    function renderAfterRemovingNote(noteId) {
      drafts.delete(noteId);
      if (open && view === noteId) {
        if (panel.hidden) close();
        else show("all");
      } else render();
    }

    function passage(id) {
      if (id !== "new") return attached.get(id);
      index ??= indexText(scope, true);
      const match = pending && locate(index, pending);
      if (match) return { ...match, range: rangeFor(index, match) };
    }

    function notesInPageOrder(items) {
      return [...items].sort((a, b) => (passage(a.id)?.from ?? Infinity) - (passage(b.id)?.from ?? Infinity) || 0);
    }

    function inlineTarget(match) {
      if (mode === "fixed" || !compact.matches || !match) return null;
      const end = match.range.endContainer;
      const parent = end.nodeType === Node.ELEMENT_NODE ? end : end.parentElement;
      const block = parent?.closest("p, h1, h2, h3, h4, h5, h6, blockquote, pre");
      if (!block || !scope.contains(block) || block.closest("table, [contenteditable]")) return null;
      const container = block.parentElement;
      if (container && /^(block|flow-root|list-item)$/u.test(getComputedStyle(container).display)) return block;
      return null;
    }

    function render(focus, reveal = false) {
      armedDelete?.cancel();
      launcherLabel.textContent = notes.length ? `Show notes · ${notes.length}` : "Show notes";
      const focused = inlineRoot.activeElement || ui.activeElement;
      focus ??= focused?.dataset.focusKey;
      const previous = cards.get(view);
      const commentScroll = previous?.querySelector(".comment-list")?.scrollTop || 0;
      const sidebarScroll = railViewport.scrollTop;
      const wasFixed = panel.dataset.mode === "fixed";
      const caret = focused?.tagName === "TEXTAREA" ? [focused.selectionStart, focused.selectionEnd] : null;
      const current = notes.find(note => note.id === view);
      const selected = current || (pending && { id: "new", anchor: pending, comments: [] });
      const match = open && selected ? passage(selected.id) : null;
      const target = inlineTarget(match);
      markPassage(match, selected?.id === "new");
      for (const card of cards.values()) resizeObserver?.unobserve(card);
      cards.clear();
      inlineRoot.querySelector(".note")?.remove();
      if (target) {
        if (target.nextElementSibling !== inline) target.after(inline);
      } else inline.remove();
      panel.hidden = !open || Boolean(target);
      panel.dataset.mode = mode;
      indicators.dataset.sidebar = panel.hidden ? "closed" : "open";
      markMode(sidebarModes);
      root.toggleAttribute(railAttribute, !panel.hidden && !compact.matches);
      if (panel.hidden || mode === "fixed" || compact.matches) {
        lastScroll = undefined;
        track.style.height = "";
      }
      launcher.hidden = open;
      launcher.setAttribute("aria-expanded", String(open));
      renderPalette();
      notice.replaceChildren();
      track.replaceChildren();
      queueLayout();
      if (!open) return;

      if (!persistent) notice.append(element("p", "notice", "Changes last until you reload."));
      if (!canHighlight) notice.append(element("p", "notice", "This browser can save notes but can’t paint highlights."));
      headingCount.textContent = notes.length || "";
      copyAllButton.hidden = !notes.length;
      if (target) {
        inlineRoot.append(noteCard(selected, true));
      } else {
        const ordered = selected?.id === "new" ? notesInPageOrder([...notes, selected]) : orderedNotes;
        if (!ordered.length) track.append(element("p", "notice", "Select text on the page to add a highlight or comment."));
        for (const note of ordered) track.append(noteCard(note, note.id === view));
        if (mode === "fixed") railViewport.scrollTop = wasFixed ? sidebarScroll : 0;
      }
      const list = cards.get(view)?.querySelector(".comment-list");
      if (list) list.scrollTop = commentScroll;
      const surface = target ? inlineRoot : panel;
      const control = Array.from(surface.querySelectorAll("[data-focus-key]"))
        .find(item => item.dataset.focusKey === focus)
        || (target ? cards.get(view).querySelector(".disclosure") : focus && heading);
      control?.focus({ preventScroll: true });
      if (control?.tagName === "TEXTAREA" && caret && focused.dataset.focusKey === control.dataset.focusKey) {
        control.setSelectionRange(...caret);
      }
      if (reveal) {
        cancelAnimationFrame(revealFrame);
        revealFrame = requestAnimationFrame(() => {
          const card = cards.get(view);
          if (target) control?.scrollIntoView({ block: "nearest" });
          else if (card) {
            const visiblePart = Math.min(card.offsetHeight, railViewport.clientHeight);
            if (card.offsetTop < railViewport.scrollTop || card.offsetTop + visiblePart > railViewport.scrollTop + railViewport.clientHeight) {
              railViewport.scrollTop = card.offsetTop;
            }
          }
        });
      }
    }

    function markPassage(match, isPending) {
      activeRange = match?.range;
      if (!activeRange) for (const bracket of passageBrackets) bracket.hidden = true;
      if (!canHighlight) return;
      if (isPending && activeRange) {
        const highlight = new Highlight(activeRange);
        highlight.priority = 1;
        CSS.highlights.set(pendingCommentMark, highlight);
      } else CSS.highlights.delete(pendingCommentMark);
    }

    function noteCard(note, expanded) {
      const card = element("section", "note");
      cards.set(note.id, card);
      const match = passage(note.id);
      if (!match) card.dataset.detached = "";
      if (expanded) card.dataset.open = "";
      const saved = note.id !== "new";
      const threadId = `thread-${cards.size}`;
      const heading = element("h3", "note-heading");
      heading.id = `note-heading-${cards.size}`;
      const number = noteNumbers.get(note.id);
      if (number) {
        const badge = element("span", "note-number", String(number));
        badge.setAttribute("aria-hidden", "true");
        heading.append(badge);
      }
      const excerpt = saved
        ? button(note.anchor.exact, () => openAtPassage(note), "excerpt", `jump-${note.id}`)
        : element("span", "excerpt", note.anchor.exact);
      excerpt.title = note.anchor.exact;
      if (saved) excerpt.setAttribute("aria-description", match ? "Open note and jump to passage" : "Open note");
      heading.append(excerpt);

      const tools = element("div", "note-tools thread-actions");
      const label = `${expanded ? "Collapse" : "Expand"} note${number ? ` ${number}` : ""}`;
      const disclosure = iconButton(label, "chevron",
        () => expanded ? collapse(note.id) : show(note.id, null, `note-${note.id}`), `note-${note.id}`);
      disclosure.classList.add("disclosure");
      disclosure.setAttribute("aria-expanded", String(expanded));
      disclosure.setAttribute("aria-controls", threadId);
      disclosure.setAttribute("aria-describedby", heading.id);
      const copy = iconButton("Copy text link", "link", () => copyLink(note), `copy-${note.id}`);
      copy.disabled = !saved || !match;
      const count = element("span", "count");
      const total = note.comments.length;
      count.append(icon("comment"), document.createTextNode(total));
      count.setAttribute("aria-label", `${total} ${total === 1 ? "comment" : "comments"}`);
      const remove = deleteButton(note.comments.length ? "Delete note and comments" : "Delete highlight", "trash", async () => {
        if (!await change(items => items.filter(item => item.id !== note.id))) return;
        for (const comment of note.comments) commentEdits.delete(comment.id);
        renderAfterRemovingNote(note.id);
      }, `remove-${note.id}`);
      remove.disabled = !saved;
      tools.append(disclosure, copy, count, remove);
      card.append(tools, heading);
      const thread = element("div", "thread");
      thread.id = threadId;
      thread.hidden = !expanded;
      if (expanded) renderThread(thread, note);
      card.append(thread);
      resizeObserver?.observe(card);
      return card;
    }

    function deleteButton(label, glyph, action, key) {
      const prompt = `Activate again to ${label.toLowerCase()}`;
      let timer;
      const cancel = () => {
        clearTimeout(timer);
        control.removeAttribute("data-confirm-delete");
        control.setAttribute("aria-label", label);
        control.title = label;
        armedDelete = undefined;
      };
      const control = iconButton(label, glyph, () => {
        if (busy) return;
        if (armedDelete?.control === control && performance.now() < armedDelete.until) {
          cancel();
          void action();
          return;
        }
        armedDelete?.cancel();
        const timeout = 3000;
        armedDelete = { control, cancel, until: performance.now() + timeout };
        control.setAttribute("data-confirm-delete", "");
        control.setAttribute("aria-label", prompt);
        control.title = prompt;
        timer = setTimeout(cancel, timeout);
      }, key);
      control.addEventListener("keydown", event => {
        if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
      });
      control.addEventListener("blur", () => {
        if (armedDelete?.control === control) cancel();
      });
      return control;
    }

    function commentBody(noteId, comment) {
      const key = `edit-${comment.id}`;
      const fieldKey = `edit-field-${comment.id}`;
      const edit = commentEdits.get(comment.id);
      if (!edit) {
        const text = button(comment.body, () => {
          commentEdits.set(comment.id, { body: comment.body });
          render(fieldKey);
          const focused = inlineRoot.activeElement || ui.activeElement;
          focused?.closest(".comment-editor")?.scrollIntoView({ block: "nearest" });
        }, "comment-body", key);
        text.title = "Edit comment";
        return text;
      }

      const form = element("form", "comment-editor");
      const input = element("textarea");
      input.setAttribute("aria-label", "Edit comment");
      input.dataset.focusKey = fieldKey;
      input.rows = 1;
      input.required = true;
      input.value = edit.body;
      const cancel = () => {
        commentEdits.delete(comment.id);
        render(key);
      };
      const actions = element("div", "edit-actions");
      const save = element("button", "primary", "Save");
      save.type = "submit";
      save.dataset.focusKey = `save-${comment.id}`;
      save.disabled = !edit.body.trim() || edit.body.trim() === comment.body;
      actions.append(button("Cancel", cancel, "", `cancel-${comment.id}`), save);
      input.addEventListener("input", () => {
        edit.body = input.value;
        const body = edit.body.trim();
        save.disabled = !body || body === comment.body;
        queueLayout();
      });
      form.addEventListener("keydown", event => {
        if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
        event.preventDefault();
        cancel();
      });
      form.addEventListener("submit", async event => {
        event.preventDefault();
        const draft = edit.body;
        const body = draft.trim();
        if (!body || body === comment.body) return;
        const saved = await changeComments(noteId, comments => comments.map(item =>
          item.id === comment.id ? { ...item, body } : item));
        if (!saved) return;
        const finished = commentEdits.get(comment.id) === edit && edit.body === draft;
        if (finished) commentEdits.delete(comment.id);
        render(finished && open && view === noteId ? key : undefined);
      });
      form.append(input, actions);
      return form;
    }

    function renderThread(thread, note) {
      const tools = element("div", "thread-tools");
      if (panel.hidden) {
        const modes = modeSwitch();
        markMode(modes);
        tools.append(modes);
      }
      const done = note.comments.filter(comment => comment.resolved).length;
      if (!done) resolved = false;
      if (done) {
        const filters = element("div", "filters");
        filters.setAttribute("role", "group");
        filters.setAttribute("aria-label", "Filter comments");
        for (const isResolved of [false, true]) {
          const key = isResolved ? "resolved" : "open";
          const filter = button(isResolved ? `Resolved ${done}` : `Open ${note.comments.length - done}`, () => {
            resolved = isResolved;
            render(key);
            cards.get(note.id).querySelector(".comment-list").scrollTop = 0;
          }, "filter", key);
          filter.setAttribute("aria-pressed", String(resolved === isResolved));
          filters.append(filter);
        }
        tools.append(filters);
      }
      if (tools.childElementCount) thread.append(tools);
      if (note.id !== "new" && !attached.has(note.id)) thread.append(element("p", "notice", "Text unavailable"));
      const list = element("div", "comment-list");
      const comments = note.comments.filter(comment => Boolean(comment.resolved) === resolved);
      for (const [i, comment] of comments.entries()) {
        const row = element("article", "comment");
        const nextId = (comments[i + 1] || comments[i - 1])?.id;
        const meta = element("footer", "comment-meta");
        const created = typeof comment.createdAt === "string" ? Date.parse(comment.createdAt) : NaN;
        if (Number.isFinite(created)) {
          const timestamp = element("time", "", commentDate.format(created));
          timestamp.dateTime = comment.createdAt;
          meta.append(timestamp);
        }
        const actions = element("div", "thread-actions");
        actions.append(
          iconButton(comment.resolved ? "Reopen comment" : "Resolve comment", comment.resolved ? "reopen" : "resolve",
            () => updateComment(note.id, comment.id, "resolve", nextId), `resolve-${comment.id}`),
          deleteButton("Delete comment", "delete", () => updateComment(note.id, comment.id, "delete", nextId), `delete-${comment.id}`)
        );
        meta.append(actions);
        row.append(commentBody(note.id, comment), meta);
        list.append(row);
      }
      if (!comments.length && done) list.append(element("p", "notice", "No open comments."));
      if (list.childElementCount) {
        list.tabIndex = 0;
        list.setAttribute("aria-label", "Comments");
      } else list.hidden = true;
      thread.append(list);
      const form = element("form", "composer");
      const input = element("textarea");
      input.setAttribute("aria-label", "Add a comment");
      input.placeholder = "Add a comment…";
      input.dataset.focusKey = "draft";
      input.rows = 1;
      input.required = true;
      input.spellcheck = false;
      input.autocomplete = "off";
      input.value = drafts.get(note.id) || "";
      const submit = element("button", "primary", "Post");
      submit.type = "submit";
      submit.dataset.focusKey = "post";
      submit.disabled = !input.value.trim();
      input.addEventListener("input", () => {
        drafts.set(note.id, input.value);
        submit.disabled = !input.value.trim();
        queueLayout();
      });
      form.addEventListener("submit", postComment);
      form.append(input, submit);
      thread.append(form);
    }

    function syncAnnotations() {
      for (const [noteId, { control }] of annotations) {
        if (attached.has(noteId)) continue;
        control.remove();
        annotations.delete(noteId);
      }
      let previous = null;
      for (const { id: noteId } of orderedNotes) {
        const match = attached.get(noteId);
        if (!match) continue;
        let annotation = annotations.get(noteId);
        if (!annotation) {
          const control = button("", () => show(noteId, null, `note-${noteId}`), "annotation");
          control.hidden = true;
          control.removeAttribute("data-focus-key");
          annotation = { control };
          annotations.set(noteId, annotation);
        }
        const { control } = annotation;
        const number = String(noteNumbers.get(noteId));
        const label = `Open note ${number}`;
        control.textContent = number;
        control.setAttribute("aria-label", label);
        control.title = label;
        annotation.width = Math.max(14, number.length * 7 + 4);
        control.style.width = `${annotation.width}px`;
        annotation.end = match.range.cloneRange();
        annotation.end.collapse(false);
        const next = previous ? previous.nextElementSibling : annotationLayer.firstElementChild;
        if (next !== control) annotationLayer.insertBefore(control, next);
        previous = control;
      }
    }

    function annotationVisible(parent, x, y) {
      if (getComputedStyle(parent).visibility !== "visible") return false;
      for (let node = parent; node && node !== root; node = node.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(node);
        if (overflowX === "visible" && overflowY === "visible") continue;
        const bounds = node.getBoundingClientRect();
        if (overflowX !== "visible" && (x < bounds.left || x > bounds.right)) return false;
        if (overflowY !== "visible" && (y < bounds.top || y > bounds.bottom)) return false;
      }
      return true;
    }

    function annotationViewport() {
      const sidebar = !panel.hidden && panel.getBoundingClientRect();
      return {
        right: sidebar && !compact.matches ? sidebar.left : root.clientWidth,
        bottom: sidebar && compact.matches ? sidebar.top : innerHeight
      };
    }

    function layoutPassageBrackets({ right, bottom }) {
      if (!activeRange) return;
      const width = 5;
      for (const [i, bracket] of passageBrackets.entries()) {
        const atStart = i === 0;
        const endpoint = activeRange.cloneRange();
        endpoint.collapse(atStart);
        const rect = endpoint.getBoundingClientRect();
        const x = rect.left;
        const y = rect.top + rect.height / 2;
        const parent = endpoint.startContainer.parentElement;
        const visible = parent && rect.height && x >= 0 && x <= right && y >= 0 && y < bottom
          && annotationVisible(parent, x, y);
        bracket.hidden = !visible;
        if (!visible) continue;
        const leftSide = (getComputedStyle(parent).direction !== "rtl") === atStart;
        const height = Math.min(15, Math.max(6, rect.height - 7));
        const left = Math.max(0, Math.min(right - width, leftSide ? x - width - 1 : x + 1));
        const top = Math.max(0, Math.min(bottom - height, rect.bottom - height - 1));
        bracket.dataset.side = leftSide ? "left" : "right";
        bracket.style.left = `${left}px`;
        bracket.style.top = `${top}px`;
        bracket.style.height = `${height}px`;
      }
    }

    function layoutAnnotations({ right, bottom }) {
      const placed = [];
      const height = 14;
      for (const [noteId, { control, end, width }] of annotations) {
        const rect = end.getBoundingClientRect();
        const x = rect.left;
        const y = rect.top + rect.height / 2;
        const parent = end.endContainer.parentElement;
        const visible = parent && rect.height && x >= 0 && x <= right && y >= 0 && y < bottom
          && annotationVisible(parent, x, y);
        control.hidden = !visible;
        if (!visible) continue;
        const direction = getComputedStyle(parent).direction;
        const start = Math.max(0, Math.min(right - width, direction === "rtl" ? x - width - 1 : x + 1));
        let left = start;
        let top = Math.max(0, Math.min(bottom - height, rect.top - 8));
        for (const box of placed) {
          if (left >= box.right || left + width <= box.left || Math.abs(top - box.top) >= height) continue;
          const next = direction === "rtl" ? box.left - width - 2 : box.right + 2;
          if (next >= 0 && next + width <= right) left = next;
          else {
            left = start;
            top = top >= height + 2 ? top - height - 2 : top + height + 2;
          }
        }
        placed.push({ left, right: left + width, top });
        control.style.left = `${left}px`;
        control.style.top = `${top}px`;
        if (open && view === noteId) control.setAttribute("aria-current", "true");
        else control.removeAttribute("aria-current");
      }
    }

    function layoutIndicators(pageHeight, pageScroll) {
      const threads = notes.filter(note => note.comments.length && attached.has(note.id));
      indicators.hidden = !threads.length || pageHeight <= innerHeight;
      if (indicators.hidden) return;

      const buckets = new Map();
      const step = 24;
      const slots = Math.max(1, Math.floor(indicators.clientHeight / step));
      for (const note of threads) {
        const match = attached.get(note.id);
        const rect = Array.from(match.range.getClientRects()).find(rect => rect.width && rect.height);
        if (!rect) continue;
        const fraction = Math.min(1, Math.max(0, (rect.top + pageScroll) / pageHeight));
        const slot = Math.min(slots - 1, Math.floor(fraction * slots));
        if (!buckets.has(slot)) buckets.set(slot, []);
        buckets.get(slot).push({ note, offset: match.from });
      }
      for (const [slot, marker] of markers) {
        if (buckets.has(slot)) continue;
        marker.remove();
        markers.delete(slot);
      }
      let previous = viewportMarker;
      for (const slot of [...buckets.keys()].sort((a, b) => a - b)) {
        const group = buckets.get(slot);
        group.sort((a, b) => a.offset - b.offset);
        const active = group.findIndex(({ note }) => note.id === view);
        const { note } = group[(active + 1) % group.length];
        const quote = note.anchor.exact.length > 80 ? `${note.anchor.exact.slice(0, 80)}…` : note.anchor.exact;
        const label = group.length === 1 ? `Jump to comment on “${quote}”`
          : `${group.length} nearby threads. Jump to “${quote}”`;
        let marker = markers.get(slot);
        if (!marker) {
          marker = button("", () => {
            const selected = notes.find(note => note.id === marker.dataset.note);
            if (selected) openAtPassage(selected);
          }, "indicator");
          marker.removeAttribute("data-focus-key");
          markers.set(slot, marker);
        }
        marker.dataset.note = note.id;
        marker.toggleAttribute("data-group", group.length > 1);
        if (active !== -1) marker.setAttribute("aria-current", "true");
        else marker.removeAttribute("aria-current");
        marker.setAttribute("aria-label", label);
        marker.title = label;
        marker.style.top = `${100 * (slot + 0.5) / slots}%`;
        if (previous.nextElementSibling !== marker) previous.after(marker);
        previous = marker;
      }
      indicators.hidden = !buckets.size;
      viewportMarker.style.top = `${100 * pageScroll / pageHeight}%`;
      viewportMarker.style.height = `${100 * innerHeight / pageHeight}%`;
    }

    function queueLayout() {
      if (layoutFrame) return;
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0;
        const pageScroll = window.scrollY;
        const pageHeight = document.scrollingElement?.scrollHeight ?? root.scrollHeight;
        if (activeRange || annotations.size) {
          const viewport = annotationViewport();
          layoutPassageBrackets(viewport);
          layoutAnnotations(viewport);
        }
        layoutIndicators(pageHeight, pageScroll);
        if (panel.hidden || mode === "fixed" || compact.matches) return;
        const headerBottom = railViewport.getBoundingClientRect().top;
        const entries = [];
        for (const [id, card] of cards) {
          const range = passage(id)?.range;
          const first = Array.from(range?.getClientRects() || []).find(rect => rect.width && rect.height);
          const heading = card.querySelector(".note-heading");
          const headingCenter = heading.offsetTop + heading.offsetHeight / 2;
          const start = first ? Math.round(first.top + first.height / 2 + pageScroll - headerBottom - headingCenter) : 0;
          entries.push({ id, card, start, height: card.offsetHeight });
        }
        let nextTop = 8;
        let minimumTop = nextTop;
        const gap = 6;
        for (const [i, entry] of entries.entries()) {
          entry.top = Math.max(entry.start, nextTop);
          if (entry.id === view && entry.start) {
            entry.top = Math.max(entry.start, minimumTop);
            let previousBottom = entry.top;
            for (let j = i - 1; j >= 0; j--) {
              const previous = entries[j];
              previous.top = Math.min(previous.top, previousBottom - previous.height - gap);
              previousBottom = previous.top;
            }
          }
          nextTop = entry.top + entry.height + gap;
          minimumTop += entry.height + gap;
        }
        for (const {card, top} of entries) card.style.top = `${top}px`;
        track.style.height = `${Math.max(nextTop, pageHeight - innerHeight + railViewport.clientHeight)}px`;
        if (lastScroll !== pageScroll) railViewport.scrollTop = pageScroll;
        lastScroll = pageScroll;
      });
    }

    function installStyle(root, css) {
      if (extensionStorage) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        root.adoptedStyleSheets.push(sheet);
        signal.addEventListener("abort", () => {
          const index = root.adoptedStyleSheets.indexOf(sheet);
          if (index !== -1) root.adoptedStyleSheets.splice(index, 1);
        }, { once: true });
        return css => sheet.replaceSync(css);
      } else {
        const style = makeStyle(css);
        (root.head || root).append(style);
        signal.addEventListener("abort", () => style.remove(), { once: true });
        return css => { style.textContent = css; };
      }
    }

    toolbar.append(...toolbarSwatches, iconButton("Comment", "comment", startComment));
    toolbar.addEventListener("mousedown", event => { event.preventDefault(); });
    ui.addEventListener("pointerdown", event => {
      if (editingHighlight && !event.composedPath().includes(toolbar)) hideToolbar();
    });
    renderPalette();
    installStyle(ui, UI_CSS);
    installStyle(inlineRoot, UI_CSS);
    installStyle(document, `
      :root[${railAttribute}] { padding-right: clamp(305px, 32vw, 410px) !important; }
    `);
    ui.append(...passageBrackets, annotationLayer, toolbar, indicators, panel, status, launcher);
    document.body.append(host);
    if (extensionStorage) document.dispatchEvent(new Event(extensionStateEvent));
    const setHighlightStyles = canHighlight ? installStyle(document, "") : null;
    if (canHighlight) updateHighlightStyles();
    const paletteReady = refreshPalette();
    storage.subscribe(refreshNotes);
    storage.subscribePalette?.(refreshPalette);
    markMode(sidebarModes);
    void restoreMode();
    void refreshNotes();
    updateToolbar();

    document.addEventListener("selectionchange", updateToolbar, { signal });
    document.fonts?.addEventListener("loadingdone", queueLayout, { signal });
    compact.addEventListener("change", () => render(), { signal });
    window.addEventListener("resize", () => {
      if (editingHighlight) hideToolbar();
      updateToolbar();
      queueLayout();
    }, { passive: true, signal });
    window.addEventListener("scroll", event => {
      if (event.composedPath().some(node => node === host || node === inline)) return;
      if (editingHighlight) hideToolbar();
      updateToolbar();
      queueLayout();
    }, { passive: true, capture: true, signal });
    resizeObserver?.observe(root);
    resizeObserver?.observe(scope);
    resizeObserver?.observe(railViewport);
    document.addEventListener("pointerdown", event => {
      if (event.composedPath().includes(host)) return;
      if (event.pointerType === "mouse" && event.button === 0) {
        selecting = true;
        hideToolbar();
      } else if (editingHighlight && event.isPrimary) hideToolbar();
    }, { passive: true, signal });
    function endSelection() {
      selecting = false;
      updateToolbar();
    }
    window.addEventListener("pointerup", endSelection, { passive: true, signal });
    window.addEventListener("pointercancel", endSelection, { passive: true, signal });
    window.addEventListener("blur", () => { selecting = false; hideToolbar(); }, { signal });
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!toolbar.hidden) {
        hideToolbar();
        return;
      }
      const path = event.composedPath();
      if (open && (path.includes(host) || path.includes(inline))) {
        if (armedDelete) armedDelete.cancel();
        else if (paletteOpen) togglePalette();
        else if (view === "all") close();
        else collapse(view);
      }
    }, { signal });
    document.addEventListener("click", event => {
      if (event.defaultPrevented || event.detail !== 1 || !attached.size || !scope.contains(event.target)
        || event.composedPath().some(node => node === host || node === inline) || !document.getSelection()?.isCollapsed
        || event.target.closest("a, button, input, label, textarea, select, summary, [role], [contenteditable]")) return;
      const point = document.caretPositionFromPoint?.(event.clientX, event.clientY)
        || document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (!point) return;
      const node = point.offsetNode || point.startContainer;
      if (!scope.contains(node)) return;
      const offset = point.offset ?? point.startOffset;
      for (const [noteId, { range }] of attached) {
        if (range.comparePoint(node, offset) !== 0) continue;
        const box = Array.from(range.getClientRects()).find(rect => event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom);
        if (!box) continue;
        const note = notes.find(note => note.id === noteId);
        if (!note) continue;
        if (noteSwatch(note) === null) show(noteId, null, `note-${noteId}`);
        else editHighlight(note, box, event.clientX);
        return;
      }
    }, { signal });
    const observer = new MutationObserver(records => {
      if (records.every(record => record.type === "childList" && [...record.addedNodes, ...record.removedNodes]
        .every(node => node === inline || node === host))) return;
      index = null;
      clearTimeout(refreshTimer);
      if (!notes.length && !pending) return;
      refreshTimer = setTimeout(() => {
        const previous = attached;
        const previousNumbers = noteNumbers;
        paint();
        if (previous.size !== attached.size || Array.from(previous.keys()).some(key => !attached.has(key))
          || orderedNotes.some(note => previousNumbers.get(note.id) !== noteNumbers.get(note.id))) render();
        else {
          markPassage(open ? passage(view) : null, view === "new");
          queueLayout();
        }
      }, 150);
    });
    observer.observe(scope, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open", "contenteditable", "data-local-notes-ignore"]
    });
    signal.addEventListener("abort", () => {
      observer.disconnect();
      resizeObserver?.disconnect();
      cancelAnimationFrame(selectionFrame);
      cancelAnimationFrame(layoutFrame);
      cancelAnimationFrame(revealFrame);
      root.removeAttribute(railAttribute);
      inline.remove();
      clearTimeout(refreshTimer);
      clearTimeout(statusTimer);
      armedDelete?.cancel();
      if (canHighlight) {
        for (const name of registeredHighlights) CSS.highlights.delete(name);
        CSS.highlights.delete(pendingCommentMark);
      }
      host.remove();
      if (extensionStorage) document.dispatchEvent(new Event(extensionStateEvent));
    }, { once: true });
  }

  const UI_CSS = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      color-scheme: light dark;
      --paper: #fbfaf7;
      --rail: #f3f1eb;
      --ink: #24231f;
      --swatch-ring: #000;
      --muted: #635f55;
      --line: #dedbd0;
      --hover: #eeebe1;
      --rule: #ab771d;
      --accent: #efcf6a;
      --accent-ink: #282112;
      --danger: #a12d26;
      --rail-width: clamp(305px, 32vw, 410px);
      --shadow: 0 4px 16px #25211226;
      color: var(--ink);
      font: 14px/1.45 Inter, system-ui, sans-serif;
      direction: ltr;
      text-align: left;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --paper: #262722;
        --rail: #20211e;
        --ink: #f0ede3;
        --swatch-ring: #fff;
        --muted: #b8b4a6;
        --line: #3d3e36;
        --hover: #30312a;
        --rule: #d4ad58;
        --danger: #ff9b91;
        --shadow: 0 4px 16px #0007;
      }
    }
    :host(local-text-notes-inline) {
      position: relative;
      inset: auto;
      z-index: auto;
      display: block;
      margin: 0 0 12px;
      pointer-events: auto;
    }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button, textarea, input { font: inherit; color: inherit; }
    button {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 6px;
      min-height: 32px;
      padding: 4px 9px;
      cursor: pointer;
    }
    button:hover { background: var(--hover); }
    button:disabled { cursor: default; }
    :focus-visible { outline: 2px solid var(--rule); outline-offset: -2px; }
    svg { display: block; width: 16px; height: 16px; flex: none; }
    .color-dot {
      width: 13px;
      height: 13px;
      border: 1px solid #80808085;
      border-radius: 50%;
      background: var(--swatch);
    }
    .color-panel {
      display: grid;
      gap: 4px;
      padding: 6px 10px;
      border-block-end: 1px solid var(--line);
      background: var(--paper);
      font-size: 12px;
    }
    .color-row { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
    .swatch-label { display: flex; align-items: center; gap: 4px; }
    .color-text-button {
      min-height: 24px;
      padding: 2px 4px;
      border: 0;
      color: var(--muted);
      background: transparent;
      font-size: 11px;
    }
    .color-text-button:hover { color: var(--ink); background: transparent; text-decoration: underline; }
    .color-options { display: flex; align-items: center; gap: 3px; }
    .color-input { width: 24px; height: 24px; padding: 0; border: 0; background: transparent; cursor: pointer; }
    .color-input::-webkit-color-swatch-wrapper { padding: 4px; }
    .color-input::-webkit-color-swatch { border: 1px solid #80808085; }
    .color-input::-moz-color-swatch { border: 1px solid #80808085; }
    .toolbar, .panel, .status, .launcher { position: absolute; background: var(--paper); }
    .annotations { position: absolute; inset: 0; }
    .passage-bracket {
      position: absolute;
      width: 5px;
      border-block: 1px solid var(--rule);
      pointer-events: none;
    }
    .passage-bracket[data-side="left"] { border-left: 1px solid var(--rule); }
    .passage-bracket[data-side="right"] { border-right: 1px solid var(--rule); }
    .annotation, .note-number {
      display: grid;
      place-items: center;
      flex: none;
      min-width: 14px;
      height: 14px;
      border-radius: 0;
      background: var(--accent);
      color: var(--accent-ink);
      font-size: 10px;
      font-weight: 650;
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }
    .annotation {
      position: absolute;
      pointer-events: auto;
      min-height: 0;
      padding: 0;
      border: 0;
    }
    .annotation:hover { background: #f6db8b; }
    .toolbar, .status, .launcher { border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
    .toolbar, .panel, .launcher { pointer-events: auto; }
    .toolbar { display: flex; gap: 2px; padding: 4px; z-index: 2; }
    .toolbar [aria-pressed="true"] .color-dot { outline: 1px solid var(--swatch-ring); outline-offset: 2px; }
    .toolbar .color-button:focus-visible { outline: none; }
    .toolbar .color-button:focus-visible .color-dot { outline: 2px solid var(--swatch-ring); outline-offset: 2px; }
    .toolbar .icon:last-child { margin-inline-start: 4px; }
    .launcher { display: flex; align-items: center; gap: 6px; bottom: max(12px, env(safe-area-inset-bottom)); right: max(12px, env(safe-area-inset-right)); }
    .logo { object-fit: contain; flex: none; }
    .panel {
      inset: 0 0 0 auto;
      width: var(--rail-width);
      display: flex;
      flex-direction: column;
      background: var(--rail);
      border-inline-start: 1px solid var(--line);
    }
    header { display: flex; align-items: center; gap: 5px; padding: 7px 8px; border-bottom: 1px solid var(--line); }
    h2 { margin: 0; font-size: 14px; }
    header .count { margin-inline-end: auto; }
    header .icon { flex: none; width: 26px; }
    .modes { display: flex; flex: none; gap: 2px; padding: 2px; border: 1px solid var(--line); border-radius: 6px; }
    .modes button { min-height: 24px; padding: 2px 7px; border: 0; border-radius: 4px; background: transparent; color: var(--muted); font-size: 12px; }
    .modes button:hover, .modes [aria-pressed="true"] { background: var(--hover); color: var(--ink); }
    .indicators { position: absolute; inset: 18px max(0px, env(safe-area-inset-right)) 60px auto; width: 24px; z-index: 1; }
    .indicators[data-sidebar="open"] { right: var(--rail-width); }
    .indicators::before, .viewport-marker {
      position: absolute;
      inset-inline-start: 10px;
      width: 4px;
      border-radius: 3px;
      pointer-events: none;
    }
    .indicators::before { content: ""; inset-block: 0; background: var(--line); }
    .viewport-marker { background: var(--muted); opacity: .6; }
    .indicator {
      position: absolute;
      inset-inline-start: 0;
      width: 24px;
      height: 24px;
      min-height: 0;
      padding: 0;
      border: 0;
      background: transparent;
      pointer-events: auto;
      transform: translateY(-50%);
    }
    .indicator::before { content: ""; display: block; margin: auto; width: 10px; height: 3px; border-radius: 3px; background: var(--rule); }
    .indicator:hover { background: transparent; }
    .indicator:hover::before, .indicator[aria-current="true"]::before { width: 14px; height: 5px; }
    .indicator[data-group]::before { box-shadow: 0 4px var(--rule); }
    .rail-scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; }
    .rail-track { position: relative; }
    .rail-track .note { position: absolute; inset-inline: 0; }
    .panel[data-mode="fixed"] .note { position: static; }
    .note { overflow: hidden; background: var(--paper); border-block: 1px solid var(--line); }
    :host(local-text-notes-inline) .note { border: 1px solid var(--line); }
    .note[data-open] { border-color: var(--rule); }
    .note-tools {
      gap: 8px;
      padding: 2px 8px 2px 5px;
      border-block-end: 1px solid var(--line);
      background: var(--rail);
    }
    .note-tools .count { white-space: nowrap; }
    .note-tools > .icon:last-child { margin-inline-start: auto; }
    .note-tools .icon:disabled { opacity: .45; color: var(--muted); }
    .note[data-open] .disclosure svg { transform: rotate(90deg); color: var(--rule); }
    .note-heading { display: flex; align-items: center; margin: 0; }
    .note-number { margin-inline-start: 10px; padding-inline: 3px; }
    .excerpt {
      display: block;
      width: 100%;
      min-width: 0;
      min-height: 32px;
      padding: 5px 10px;
      border: 0;
      text-align: start;
      font-size: 14px;
      font-weight: 400;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .note-number + .excerpt { padding-inline-start: 7px; }
    .count { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
    .count svg { width: 14px; height: 14px; }
    .icon { display: grid; place-items: center; width: 30px; min-height: 30px; padding: 0; background: transparent; color: var(--muted); border: 0; }
    .icon:hover { color: var(--ink); }
    .thread { border-top: 1px solid var(--line); }
    .thread-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 3px 8px 0; }
    .filters { display: flex; align-items: center; gap: 2px; }
    .thread-actions { display: flex; align-items: center; margin-inline-start: auto; }
    .thread-actions .icon { width: 24px; min-height: 24px; }
    .thread-actions .icon:hover { background: transparent; }
    .thread-actions .icon[data-confirm-delete] { color: var(--danger); }
    .thread-actions .icon[data-confirm-delete] svg { stroke-width: 2; }
    .filter { min-height: 27px; padding: 2px 6px; border-color: transparent; background: transparent; color: var(--muted); font-size: 12px; }
    .filter[aria-pressed="true"] { border-color: var(--line); background: var(--hover); color: var(--ink); }
    .notice { margin: 0; padding: 6px 10px; color: var(--muted); font-size: 12px; }
    .comment-list { max-height: min(240px, 32dvh); overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; }
    .comment { padding: 4px 8px 3px 10px; font-size: 13px; }
    .comment + .comment { border-top: 1px solid var(--line); }
    .comment-body {
      display: block;
      width: 100%;
      min-height: 0;
      padding: 2px 0;
      border: 0;
      background: transparent;
      text-align: start;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      cursor: text;
    }
    .comment-meta { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; }
    .comment-editor { display: grid; gap: 4px; }
    .comment-editor textarea { width: 100%; }
    .edit-actions { display: flex; justify-content: flex-end; gap: 4px; }
    .edit-actions button { min-height: 28px; }
    .composer { display: flex; align-items: flex-end; gap: 5px; padding: 6px 8px; border-top: 1px solid var(--line); }
    textarea, .copy-field {
      min-width: 0;
      border-radius: 5px;
      border: 1px solid var(--line);
      background: var(--rail);
      padding: 6px 7px;
      font-size: 13px;
    }
    .composer textarea, .comment-editor textarea {
      min-height: 32px;
      max-height: min(280px, 30dvh);
      resize: vertical;
      field-sizing: content;
    }
    .composer textarea { flex: 1; }
    textarea::placeholder { color: var(--muted); }
    .copy-field { display: block; width: calc(100% - 16px); margin: 4px 8px; }
    .note button, .note textarea, .note .copy-field, .note .modes { border-radius: 0; }
    .primary { background: var(--accent); color: var(--accent-ink); font-size: 13px; font-weight: 650; }
    .primary:hover { background: #f6db8b; }
    .primary:disabled { background: transparent; color: var(--muted); }
    .status { bottom: 52px; right: 12px; max-width: calc(100vw - 24px); padding: 6px 10px; font-size: 13px; z-index: 3; }
    @media (max-width: 760px) {
      .panel { inset: auto 0 0; width: auto; max-height: 55dvh; border-inline-start: 0; border-top: 1px solid var(--line); }
      .indicators[data-sidebar="open"] { right: max(0px, env(safe-area-inset-right)); bottom: calc(55dvh + 12px); }
      .rail-track .note { position: static; }
      .thread-actions .icon { min-height: 30px; }
    }
  `;

  function initialize() {
    if (globalThis.startLocalTextNotesExtension) {
      globalThis.startLocalTextNotesExtension(start);
      return;
    }
    if (document.querySelector("local-text-notes:not([data-extension])")) return;
    let controller = null;
    function update() {
      if (document.querySelector(extensionSelector)) {
        controller?.abort();
        controller = null;
      } else if (!controller) {
        controller = new AbortController();
        start({ signal: controller.signal });
      }
    }
    document.addEventListener(extensionStateEvent, update);
    update();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
