/* eslint-disable */
// @ts-nocheck
//
// Stela embed bridge — runs INSIDE the sandboxed artifact iframe (opaque origin, allow-scripts).
// Injected at serve time on the portal-embed path ONLY (/raw?embed=1); the standalone artifact never
// carries it. Its sole job: report which "view" of a multi-page artifact is currently showing, so the
// portal's comment overlay can scope pins to the page they were placed on.
//
// It NEVER weakens the sandbox: it runs in the opaque-origin iframe and only postMessages a small,
// non-sensitive {viewKey, label} out to the parent. The parent gains no DOM access to the artifact.
//
// Detection is grammar-based, not convention-based: a "view group" is a set of same-tag sibling
// containers where exactly ONE is rendered and the rest are not (the show/hide-one-of-N pattern). The
// most content-heavy such group wins (so real page sections beat a sidebar menu's show/hide groups).
// The view's key/label come from the artifact's OWN identifiers, best-signal-first:
//   data-stela-view (our optional contract) > a data-* shared across the group with distinct values
//   (e.g. data-screen) > id > heading text > positional index.
// If nothing clears the bar, it reports null and pins stay page-global — failing safe to today.
(function () {
  if (window.__stelaBridge) return;
  window.__stelaBridge = true;

  // Tags that never form a page-level view — skipped to cut scan cost and false candidates.
  var DENY = {
    SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, HEAD: 1, TEMPLATE: 1, BR: 1, HR: 1, COL: 1, COLGROUP: 1,
    SOURCE: 1, TRACK: 1, PARAM: 1, OPTION: 1, OPTGROUP: 1, LI: 1, DT: 1, DD: 1, TR: 1, TD: 1, TH: 1,
    THEAD: 1, TBODY: 1, TFOOT: 1, CAPTION: 1
  };

  function isRendered(el) {
    if (el.hasAttribute("hidden")) return false;
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    // Deliberately NOT keying on opacity: a fading-in view (opacity 0->1) is still "the active view".
    return el.getClientRects().length > 0;
  }
  function area(el) {
    var r = el.getBoundingClientRect();
    return Math.max(0, r.width) * Math.max(0, r.height);
  }
  function textLen(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim().length;
  }
  function contentWeight(el) {
    return area(el) + textLen(el) * 40;
  }
  function headingText(el) {
    var h = el.querySelector("h1,h2,h3,h4,h5,h6,[role=heading]");
    return h ? (h.textContent || "").replace(/\s+/g, " ").trim() : "";
  }
  function humanize(k) {
    return String(k)
      .replace(/[-_\/]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // Return the single rendered member, or null unless EXACTLY one is rendered. Short-circuits at the
  // second rendered member so big all-visible groups (table rows, lists) cost ~2 reads, not N.
  function oneRendered(members) {
    var found = null, n = 0;
    for (var i = 0; i < members.length; i++) {
      if (isRendered(members[i])) {
        n++;
        if (n > 1) return null;
        found = members[i];
      }
    }
    return n === 1 ? found : null;
  }

  // The routing attribute = the attribute name present on ALL members whose values most distinguish
  // them. data-stela-view always wins; "id" qualifies (present on all, distinct values).
  function routingAttr(members) {
    var shared = null;
    for (var i = 0; i < members.length; i++) {
      var m = members[i], here = {};
      for (var j = 0; j < m.attributes.length; j++) {
        var a = m.attributes[j];
        if (a.name === "class" || a.name === "style") continue;
        here[a.name] = 1;
      }
      if (shared === null) shared = here;
      else for (var k in shared) if (!(k in here)) delete shared[k];
    }
    var names = shared ? Object.keys(shared) : [];
    if (names.indexOf("data-stela-view") !== -1) return "data-stela-view";
    var best = null, bestN = 0;
    for (var x = 0; x < names.length; x++) {
      var n = names[x];
      if (n.indexOf("data-") !== 0 && n !== "id") continue;
      var seen = {}, distinct = 0;
      for (var y = 0; y < members.length; y++) {
        var v = members[y].getAttribute(n);
        if (v != null && !(v in seen)) { seen[v] = 1; distinct++; }
      }
      if (distinct > bestN) { bestN = distinct; best = n; }
    }
    return bestN >= 2 ? best : null;
  }

  function viewOf(active, members) {
    var attr = routingAttr(members);
    var key =
      active.getAttribute("data-stela-view") ||
      (attr ? active.getAttribute(attr) : null) ||
      active.id ||
      headingText(active) ||
      null;
    if (!key) key = "view-" + (Array.prototype.indexOf.call(members, active) + 1);
    key = String(key).trim().slice(0, 512);
    var label =
      active.getAttribute("data-stela-view-label") ||
      active.getAttribute("aria-label") ||
      headingText(active) ||
      humanize(key);
    label = label ? String(label).replace(/\s+/g, " ").trim().slice(0, 200) : "";
    return { key: key, label: label, count: members.length };
  }

  function detect() {
    var best = null, bestW = -1;
    var all = document.body ? document.body.getElementsByTagName("*") : [];
    for (var i = 0; i < all.length; i++) {
      var parent = all[i];
      var first = parent.firstElementChild;
      if (!first || !first.nextElementSibling) continue; // need >= 2 children
      var groups = {};
      for (var c = first; c; c = c.nextElementSibling) {
        if (DENY[c.tagName]) continue;
        (groups[c.tagName] || (groups[c.tagName] = [])).push(c);
      }
      for (var tag in groups) {
        var members = groups[tag];
        if (members.length < 2) continue;
        var active = oneRendered(members);
        if (!active) continue;
        var w = contentWeight(active);
        if (w > bestW) { bestW = w; best = { active: active, members: members }; }
      }
    }
    if (!best) return null;
    // Conservative gate: the active view must occupy a meaningful slice of the viewport, so we don't
    // engage page-filtering on a small collapsible/toggle that merely looks like a one-of-N group.
    var vp = (window.innerWidth || 1) * (window.innerHeight || 1);
    if (area(best.active) < 0.12 * vp) return null;
    return viewOf(best.active, best.members);
  }

  // ---- emit: report to the parent on change only (force on load / on host hello) ----
  var lastKey = undefined;
  function send(v) {
    try {
      window.parent.postMessage(
        { source: "stela-bridge", type: "view", key: v ? v.key : null, label: v ? v.label : null, count: v ? v.count : 0 },
        "*"
      );
    } catch (e) {}
  }
  function commit(v) {
    var key = v ? v.key : null;
    if (key === lastKey) return;
    lastKey = key;
    send(v);
  }
  function emit(force) {
    var v = detect();
    if (force) { lastKey = v ? v.key : null; send(v); return; }
    if (v) { commit(v); return; }
    // detect() === null may be a transient mid-transition (a crossfade where two views overlap for a
    // beat). Re-check once after the transition settles before committing to "no view".
    setTimeout(function () { commit(detect()); }, 220);
  }

  // Coalesce bursts of DOM mutations (a nav click flips classes on several nodes) into one detect.
  var t = null;
  function schedule() {
    if (t) clearTimeout(t);
    t = setTimeout(function () { t = null; emit(false); }, 90);
  }

  // ---- navigation: drive the artifact to a requested view (round-2 jump-to-pin) ----
  function cssEscape(s) {
    if (window.CSS && CSS.escape) {
      try { return CSS.escape(s); } catch (e) {}
    }
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }
  function looksLikeContainer(el) {
    // A large, content-heavy block is a view itself, not a control to click.
    var r = el.getBoundingClientRect();
    return r.height > 240 && (el.textContent || "").length > 200;
  }
  // Find a clickable control that routes to `key`. We drive the artifact's OWN nav (a real click /
  // hash change) rather than forcing its DOM, so its router stays consistent. Common routing attributes
  // and hash links first, then any clickable whose attribute value equals the key.
  function findTrigger(key) {
    var esc = cssEscape(key);
    var sels = [
      '[data-stela-nav="' + esc + '"]',
      '[data-go="' + esc + '"]',
      '[data-target="' + esc + '"]',
      '[data-tab="' + esc + '"]',
      '[data-route="' + esc + '"]',
      'a[href="#' + esc + '"]',
      'a[href$="#' + esc + '"]'
    ];
    for (var i = 0; i < sels.length; i++) {
      var el = null;
      try { el = document.querySelector(sels[i]); } catch (e) {}
      if (el && !looksLikeContainer(el)) return el;
    }
    var clickable = document.querySelectorAll('a,button,[role="button"],[onclick],.nav-item,[tabindex]');
    for (var j = 0; j < clickable.length; j++) {
      var c = clickable[j];
      if (looksLikeContainer(c)) continue;
      for (var k = 0; k < c.attributes.length; k++) {
        var a = c.attributes[k];
        if (a.name === "class" || a.name === "style" || a.name === "id") continue;
        if (a.value === key) return c;
      }
    }
    return null;
  }
  function navigate(key) {
    if (!key) return;
    var t = findTrigger(key);
    if (t) {
      try { t.click(); } catch (e) {}
    } else {
      try { if (location.hash.slice(1) !== key) location.hash = "#" + key; } catch (e) {}
    }
    // Re-report once the artifact's handler + any transition settles, so the host learns the new view.
    setTimeout(function () { emit(true); }, 70);
    setTimeout(function () { emit(true); }, 320);
  }

  // ============================================================================
  // DOM anchoring: describe a clicked point as an element + offset, resolve it back, and stream
  // live pin positions so a pin tracks the content as it scrolls / reflows — not the viewport.
  // ============================================================================
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + cssEscape(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 8) {
      if (node.id) { parts.unshift("#" + cssEscape(node.id)); break; }
      var sel = node.tagName.toLowerCase();
      var n = 1, sib = node;
      while ((sib = sib.previousElementSibling)) { if (sib.tagName === node.tagName) n++; }
      sel += ":nth-of-type(" + n + ")";
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }
  function textQuote(el) {
    var tx = (el.textContent || "").replace(/\s+/g, " ").trim();
    return tx ? { exact: tx.slice(0, 400) } : undefined;
  }
  // Build a durable descriptor for the element at (x,y) in the iframe viewport.
  function describe(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || el === document.documentElement || el === document.body) return null;
    var r = el.getBoundingClientRect();
    return {
      selector: cssPath(el),
      text: textQuote(el),
      offsetX: r.width ? clamp01((x - r.left) / r.width) : 0.5,
      offsetY: r.height ? clamp01((y - r.top) / r.height) : 0.5,
      tag: el.tagName.toLowerCase()
    };
  }
  // Resolve a descriptor to an element: selector first, then a (tag-filtered) text quote.
  function resolveDom(dom) {
    if (!dom) return null;
    if (dom.selector) {
      try { var el = document.querySelector(dom.selector); if (el) return el; } catch (e) {}
    }
    if (dom.text && dom.text.exact) {
      var want = dom.text.exact;
      var nodes = document.getElementsByTagName(dom.tag ? dom.tag : "*");
      var startsWith = null;
      for (var i = 0; i < nodes.length; i++) {
        var tx = (nodes[i].textContent || "").replace(/\s+/g, " ").trim();
        if (tx === want) return nodes[i];
        if (!startsWith && want.length > 8 && tx.indexOf(want) === 0) startsWith = nodes[i];
      }
      if (startsWith) return startsWith;
    }
    return null;
  }

  // Pins the host wants positioned: [{id, dom}]. Resolved elements are cached until the DOM mutates.
  var tracked = [];
  var resolvedCache = {};
  function setTracked(pins) {
    tracked = pins && pins.length ? pins : [];
    resolvedCache = {};
    streamPositions();
  }
  function positionFor(pin) {
    var el = resolvedCache[pin.id];
    if (el === undefined) { el = resolveDom(pin.dom); resolvedCache[pin.id] = el; }
    if (!el) return { id: pin.id, resolved: false, visible: false }; // can't resolve → host falls back to coords
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return { id: pin.id, resolved: true, visible: false }; // hidden / off-page
    var ox = pin.dom && typeof pin.dom.offsetX === "number" ? pin.dom.offsetX : 0.5;
    var oy = pin.dom && typeof pin.dom.offsetY === "number" ? pin.dom.offsetY : 0.5;
    var w = window.innerWidth || 1, h = window.innerHeight || 1;
    var x = r.left + ox * r.width, y = r.top + oy * r.height;
    return { id: pin.id, resolved: true, xNorm: x / w, yNorm: y / h, visible: x >= 0 && x <= w && y >= 0 && y <= h };
  }
  function streamPositions() {
    var out = [];
    for (var i = 0; i < tracked.length; i++) out.push(positionFor(tracked[i]));
    try { window.parent.postMessage({ source: "stela-bridge", type: "positions", pins: out }, "*"); } catch (e) {}
  }
  var posScheduled = false;
  function schedulePositions() {
    if (!tracked.length || posScheduled) return;
    posScheduled = true;
    requestAnimationFrame(function () { posScheduled = false; streamPositions(); });
  }

  function start() {
    emit(true);
    try {
      new MutationObserver(function () {
        schedule();          // re-detect the active view
        resolvedCache = {};  // elements may have been re-created → drop the resolve cache
        schedulePositions(); // and re-position tracked pins
      }).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "data-stela-view", "data-stela-view-label"]
      });
    } catch (e) {}
    window.addEventListener("message", function (e) {
      var d = e.data;
      if (!d || d.source !== "stela-host") return;
      if (d.type === "hello") { emit(true); streamPositions(); }
      else if (d.type === "navigate") navigate(d.key);
      else if (d.type === "track") setTracked(d.pins);
      else if (d.type === "probe") {
        var dom = describe((d.xNorm || 0) * (window.innerWidth || 1), (d.yNorm || 0) * (window.innerHeight || 1));
        try { window.parent.postMessage({ source: "stela-bridge", type: "probed", reqId: d.reqId, dom: dom }, "*"); } catch (e2) {}
      }
    });
    // :target / hash routers swap content without a DOM mutation the observer would see.
    window.addEventListener("hashchange", function () { emit(true); });
    // Stream pin positions as the artifact scrolls (capture catches inner scrollers) or resizes.
    window.addEventListener("scroll", schedulePositions, true);
    window.addEventListener("resize", schedulePositions);
    // Announce readiness so the host can (re)send its track list without racing our init.
    try { window.parent.postMessage({ source: "stela-bridge", type: "ready" }, "*"); } catch (e) {}
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
