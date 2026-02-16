/* apa-menajera-card.js (HACS dashboard plugin)
 * v1.1.4
 * - background image (responsive, max_width)
 * - overlays (PNG transparent) toggled by entity state, optionally positioned with x/y/w/h in viewbox coords
 * - SVG markers + animated flows
 * - debug mode: click -> show x,y in background coordinates
 */
const CARD_VERSION = "1.2.4";
const CARD_TAG = "apa-menajera-card";
const DEFAULT_VIEWBOX = { w: 2048, h: 1365 };

function fireEvent(node, type, detail = {}, options = {}) {
  const event = new Event(type, {
    bubbles: options.bubbles ?? true,
    cancelable: options.cancelable ?? false,
    composed: options.composed ?? true,
  });
  event.detail = detail;
  node.dispatchEvent(event);
}

function getEntity(hass, entityId) {
  if (!hass || !entityId) return null;
  return hass.states[entityId] || null;
}

function norm(v) {
  return (v ?? "").toString().trim().toLowerCase();
}

function isActiveState(stateObj, activeState) {
  if (!stateObj) return false;
  return norm(stateObj.state) === norm(activeState ?? "on");
}

function fmtState(stateObj) {
  if (!stateObj) return "—";
  const s = stateObj.state;
  if (s === "unknown" || s === "unavailable") return "—";
  const unit = stateObj.attributes?.unit_of_measurement ? stateObj.attributes.unit_of_measurement : "";
  return unit ? `${s} ${unit}` : `${s}`;
}

function numState(stateObj) {
  if (!stateObj) return null;
  const s = stateObj.state;
  if (s === "unknown" || s === "unavailable") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

class ApaMenajeraCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._els = {};
    this._markersUsed = [];
    this._last = { markerText: new Map(), activeFlows: new Map(), bgSrc: null };
    this._warmup = { timer: null, startedAt: 0 };
    this._refs = { markerValueEls: [], markerGroups: [], markerEntityIds: [], flowEls: new Map() };
  }

  static getStubConfig() {
    return {
      type: "custom:apa-menajera-card",
      title: "Apă menajeră",
      background: "/hacsfiles/apa-menajera-card/card.png",
      overlays: [],  // [{entity,state,image,x,y,w,h,opacity,fit,position}]
      markers: [],
      flows: [],
      debug: false,
      image_fit: "contain",
      max_width: "1100px",
    };
  }

  setConfig(config) {
    if (!config) throw new Error("Config invalid");

    // background can be string or object { default, when:[{entity,state,image}] }
    let bgDefault = "/hacsfiles/apa-menajera-card/card.png";
    let bgWhen = [];
    if (typeof config.background === "string") {
      bgDefault = config.background;
    } else if (config.background && typeof config.background === "object") {
      bgDefault = config.background.default ?? bgDefault;
      bgWhen = Array.isArray(config.background.when) ? config.background.when : [];
    }

    this._config = {
      title: config.title ?? "",
      backgroundDefault: bgDefault,
      backgroundWhen: bgWhen,

      overlays: Array.isArray(config.overlays) ? config.overlays : [],

      entities: config.entities ?? {},
      markers: Array.isArray(config.markers) ? config.markers : [],
      flows: Array.isArray(config.flows) ? config.flows : [],
      debug: !!config.debug,
      viewbox: config.viewbox ?? DEFAULT_VIEWBOX,

      imageFit: config.image_fit ?? "contain",            // contain | cover
      imagePosition: config.image_position ?? "center",
      maxWidth: config.max_width ?? "1100px",             // e.g. "900px"
      maxHeight: config.max_height ?? null                // e.g. "70vh"
    };

    this._renderBase();
    this._kickUpdate();
    this._startWarmup();
  }

  getCardSize() { return 5; }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    this._update();
    this._kickUpdate();
    this._startWarmup();
  }

  connectedCallback() {
    if (this._config) this._renderBase();
    if (this._hass) this._update();
    this._kickUpdate();
    this._startWarmup();

    // Refresh when card becomes visible (view/tab/popup navigation can reuse DOM
    // without an immediate hass setter call).
    if (!this._visObserver && typeof IntersectionObserver !== "undefined") {
      this._visObserver = new IntersectionObserver((entries) => {
        const visible = entries.some((e) => e && e.isIntersecting);
        if (!visible) return;
        try {
          if (this._config) this._update();
          this._kickUpdate();
          this._startWarmup();
        } catch (e) {}
      }, { threshold: 0.01 });
    }
    try { this._visObserver?.observe(this); } catch (e) {}

    // Some dashboard containers attach the card before hass propagation.
    // Retry a few times right after mount so initial values render immediately.
    if (this._mountRetryTimer) clearInterval(this._mountRetryTimer);
    let tries = 0;
    this._mountRetryTimer = setInterval(() => {
      tries += 1;
      try { if (this._config && this._els.svg) this._update(); } catch (e) {}
      if (tries >= 10) {
        clearInterval(this._mountRetryTimer);
        this._mountRetryTimer = null;
      }
    }, 250);
  }

  disconnectedCallback() {
    if (this._mountRetryTimer) {
      clearInterval(this._mountRetryTimer);
      this._mountRetryTimer = null;
    }
    if (this._visObserver) {
      try { this._visObserver.unobserve(this); } catch (e) {}
      try { this._visObserver.disconnect(); } catch (e) {}
      this._visObserver = null;
    }
  }


  _kickUpdate() {
    // HA can race: hass/config/render order differs between reloads.
    // We run a few delayed updates so markers/flows always populate.
    if (this._kickTimer) clearTimeout(this._kickTimer);
    if (this._kickTimer2) clearTimeout(this._kickTimer2);
    if (this._kickRaf) cancelAnimationFrame(this._kickRaf);

    const run = () => {
      try { if (this._hass && this._config) this._update(); } catch (e) {}
    };

    // next frame
    this._kickRaf = requestAnimationFrame(run);
    // and shortly after (entities may arrive a bit later)
    this._kickTimer = setTimeout(run, 150);
    this._kickTimer2 = setTimeout(run, 800);
  }


  _collectEntityIds() {
    const c = this._config;
    if (!c) return [];
    const ids = new Set();

    const add = (v) => { if (v && typeof v === "string") ids.add(v); };

    (c.markers || []).forEach((m) => {
      add(m.entity);
      add(m.alert_entity);
    });

    (c.flows || []).forEach((f) => add(f.entity));
    (c.backgroundWhen || []).forEach((r) => add(r.entity));
    (c.overlays || []).forEach((o) => add(o.entity));

    // remove empties
    return [...ids].filter(Boolean);
  }

  _entitiesReady() {
    const hass = this._hass;
    if (!hass) return false;
    const ids = this._collectEntityIds();
    if (!ids.length) return true;

    // ready if all exist in hass.states (even if state is unknown)
    return ids.every((id) => !!hass.states[id]);
  }


  _valuesPopulated() {
    // Returns true if at least one marker has a real value (not placeholder).
    const els = this._refs?.markerValueEls || [];
    for (const el of els) {
      if (!el) continue;
      const t = (el.textContent || "").trim();
      if (t && t !== "—" && t !== "-" && t !== "–") return true;
    }
    return false;
  }

  _startWarmup() {
    // Poll for a short time after load to avoid HA race conditions (states arrive slightly later).
    if (!this._config || !this._hass) return;
    if (this._warmup.timer) return;

    this._warmup.startedAt = Date.now();
    const tick = () => {
      try { this._update(); } catch (e) { console.warn(`[${CARD_TAG}] update error`, e); }

      const elapsed = Date.now() - this._warmup.startedAt;
      if ((this._entitiesReady() && this._valuesPopulated()) || elapsed > 30000) { // 30s max
        this._stopWarmup();
      }
    };

    this._warmup.timer = setInterval(tick, 400);
    // do one immediately
    tick();
  }

  _stopWarmup() {
    if (this._warmup?.timer) {
      clearInterval(this._warmup.timer);
      this._warmup.timer = null;
    }
  }

  _escape(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
  }

  _renderBase() {
    const c = this._config;
    if (!c) return;
    const vb = c.viewbox || DEFAULT_VIEWBOX;

    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; }
        .card {
          position: relative;
          border-radius: 16px;
          overflow: hidden;
          background: var(--ha-card-background, var(--card-background-color, #111));
          box-shadow: var(--ha-card-box-shadow, 0 2px 8px rgba(0,0,0,.25));
        }
        .header {
          position: absolute;
          top: 10px; left: 12px; right: 12px;
          display:flex; align-items:center; justify-content:space-between;
          pointer-events:none;
          z-index: 6;
        }
        .title {
          padding: 6px 10px;
          border-radius: 12px;
          backdrop-filter: blur(8px);
          background: rgba(0,0,0,.35);
          color: var(--primary-text-color, #fff);
          font-weight: 600;
          font-size: 14px;
        }
        .badge {
          padding: 6px 10px;
          border-radius: 12px;
          backdrop-filter: blur(8px);
          background: rgba(0,0,0,.35);
          color: var(--secondary-text-color, #d7d7d7);
          font-size: 12px;
          border: 1px solid rgba(255,255,255,.12);
        }
        .wrap {
          position: relative;
          width: 100%;
          aspect-ratio: ${vb.w} / ${vb.h};
        }
        img.bg {
          position:absolute;
          inset:0;
          width:100%;
          height:100%;
          object-fit: contain;
          object-position: center;
          user-select:none;
          -webkit-user-drag:none;
        }

        /* overlay images stacked above bg */
        #ovls { position:absolute; inset:0; z-index:2; pointer-events:none; }
        img.ovl {
          position:absolute;
          left: 0;
          top: 0;
          width: 100%;
          height: 100%;
          object-fit: contain;
          object-position: center;
          opacity: 1;
          display:none;
        }

        svg.overlay {
          position:absolute;
          inset:0;
          width:100%;
          height:100%;
          z-index:3;
          pointer-events:none;
        }

        /* Flow styling */
        .flow {
          fill:none;
          stroke-linecap:round;
          stroke-linejoin:round;
          stroke-width:10;
          opacity:0;
          transition: opacity .25s ease;
        }
        .flow.active { opacity:.9; }
        .flow.hot {
          stroke: var(--apa-hot-color, #ff1744);
          filter: drop-shadow(0 0 var(--apa-glow-size, 10px) var(--apa-hot-glow, rgba(255, 23, 69, 0.4)));
        }
        .flow.cold {
          stroke: var(--apa-cold-color, #00e5ff);
          filter: drop-shadow(0 0 var(--apa-glow-size, 10px) var(--apa-cold-glow, rgba(0, 229, 255, .4)));
        }
        .flow.neutral {
          stroke: var(--apa-neutral-color, #00e5ff);
          filter: drop-shadow(0 0 var(--apa-glow-size, 10px) var(--apa-neutral-glow, rgba(0, 229, 255, .75)));
        }
        .flow.active.animated {
          stroke-dasharray: 30 26;
          animation: dash 1.1s linear infinite;
        }
        @keyframes dash { to { stroke-dashoffset: -56; } }

        /* Marker styling */
        .marker { pointer-events:auto; cursor:pointer; }
        .m-bg {
          fill: rgba(0,0,0,.40);
          stroke: rgba(255,255,255,.15);
          stroke-width: 1;
          rx: 10; ry: 10;
          transition: fill .2s ease, stroke .2s ease;
        }
        .marker.alert .m-bg {
          fill: rgba(255, 60, 45, .40);
          stroke: rgba(255, 160, 150, .35);
        }
        .m-sub { font-size:18px; fill: rgba(255,255,255,.65); font-weight:500; }
        .m-value { font-size:22px; fill: rgba(255,255,255,.95); font-weight:750; }

        /* Debug */
        .dbg { pointer-events:auto; }
        .dbg-dot { fill: rgba(255,255,255,.9); stroke: rgba(0,0,0,.6); stroke-width: 2; }
        .dbg-tip { fill: rgba(0,0,0,.55); stroke: rgba(255,255,255,.2); stroke-width: 1; rx: 10; ry: 10; }
        .dbg-text { font-size:20px; fill: rgba(255,255,255,.95); font-weight:700; }
      </style>

      <ha-card class="card">
        <div class="wrap" id="wrap">
          <div class="header">
            <div class="title">${c.title ? this._escape(c.title) : ""}</div>
            <div class="badge">v${CARD_VERSION}</div>
          </div>
          <img class="bg" id="bg" alt="background" />
          <div id="ovls"></div>
          <svg class="overlay" id="svg" viewBox="0 0 ${vb.w} ${vb.h}" preserveAspectRatio="xMidYMid meet"></svg>
        </div>
      </ha-card>
    `;

    this._els.wrap = this.shadowRoot.getElementById("wrap");
    this._els.bg = this.shadowRoot.getElementById("bg");
    this._els.ovls = this.shadowRoot.getElementById("ovls");
    this._els.svg = this.shadowRoot.getElementById("svg");

    // constrain width on desktop
    const haCard = this.shadowRoot.querySelector("ha-card");
    if (haCard) {
      haCard.style.width = "100%";
      if (c.maxWidth) haCard.style.maxWidth = (typeof c.maxWidth === "number") ? `${c.maxWidth}px` : String(c.maxWidth);
      haCard.style.margin = "0 auto";
    }
    if (c.maxHeight && this._els.wrap) {
      this._els.wrap.style.maxHeight = (typeof c.maxHeight === "number") ? `${c.maxHeight}px` : String(c.maxHeight);
    }

    // apply image fit/position
    this._els.bg.style.objectFit = c.imageFit || "contain";
    this._els.bg.style.objectPosition = c.imagePosition || "center";
    this._els.bg.src = c.backgroundDefault;
    this._last.bgSrc = c.backgroundDefault;

    this._renderOverlays();
    this._buildSvgStatic();
    this._wireDebug();

    // Important: on page refresh HA may set hass BEFORE config.
    // Trigger a first update so markers/flows reflect current states immediately.
    if (this._hass) this._update();
    this._kickUpdate();
    this._startWarmup();
  }

  _renderOverlays() {
    const c = this._config;
    const ovls = this._els.ovls;
    if (!c || !ovls) return;

    ovls.innerHTML = "";
    (c.overlays || []).forEach((o, idx) => {
      if (!o || !o.entity || !o.image) return;

      const img = document.createElement("img");
      img.className = "ovl";
      img.id = `ovl-${idx}`;
      img.src = o.image;

      // fit/position/opacity
      img.style.objectFit = (o.fit ?? c.imageFit ?? "contain");
      img.style.objectPosition = (o.position ?? c.imagePosition ?? "center");
      if (o.opacity != null) img.style.opacity = String(o.opacity);

      // IMPORTANT: if your PNG is only a cutout (pump only), set x/y/w/h to place it.
      // x/y/w/h are in the SAME coordinates shown by debug mode (viewbox units).
      const vb = c.viewbox ?? DEFAULT_VIEWBOX;
      if (o.x != null && o.y != null && o.w != null && o.h != null) {
        const leftPct = (Number(o.x) / vb.w) * 100;
        const topPct  = (Number(o.y) / vb.h) * 100;
        const wPct    = (Number(o.w) / vb.w) * 100;
        const hPct    = (Number(o.h) / vb.h) * 100;
        img.style.left = `${leftPct}%`;
        img.style.top = `${topPct}%`;
        img.style.width = `${wPct}%`;
        img.style.height = `${hPct}%`;
      } else {
        img.style.left = "0%";
        img.style.top = "0%";
        img.style.width = "100%";
        img.style.height = "100%";
      }

      ovls.appendChild(img);
    });
  }

  _updateOverlays() {
    const c = this._config;
    const hass = this._hass;
    const ovls = this._els.ovls;
    if (!c || !hass || !ovls) return;

    (c.overlays || []).forEach((o, idx) => {
      const img = ovls.querySelector(`#ovl-${idx}`);
      if (!img) return;
      const st = getEntity(hass, o.entity);
      const active = isActiveState(st, o.state ?? "on");
      img.style.display = active ? "block" : "none";
    });
  }

  _buildSvgStatic() {
    const svg = this._els.svg;
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // DOM for markers/flows is recreated, so cached rendered values must be reset
    // to force first update to paint current HA states on the new elements.
    this._last.markerText = new Map();
    this._last.activeFlows = new Map();

    // clear element refs
    if (this._refs) {
      this._refs.markerValueEls = [];
      this._refs.markerGroups = [];
      this._refs.markerEntityIds = [];
      this._refs.flowEls = new Map();
    }

    const gFlows = document.createElementNS("http://www.w3.org/2000/svg", "g");
    gFlows.setAttribute("id", "flows");
    svg.appendChild(gFlows);

    const gMarkers = document.createElementNS("http://www.w3.org/2000/svg", "g");
    gMarkers.setAttribute("id", "markers");
    svg.appendChild(gMarkers);

    const gDbg = document.createElementNS("http://www.w3.org/2000/svg", "g");
    gDbg.setAttribute("id", "debug");
    svg.appendChild(gDbg);

    (this._config.flows || []).forEach((f) => {
      if (!f || !f.path || !f.id || !f.entity) return;
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", f.path);
      p.setAttribute("class", `flow ${f.class || "hot"} ${(f.animated !== false) ? "animated" : ""}`);
      p.dataset.flowId = f.id;
      p.id = `flow-${f.id}`;
      this._refs.flowEls.set(f.id, p);
      gFlows.appendChild(p);
    });

    const markers = (this._config.markers && this._config.markers.length) ? this._config.markers : [];
    this._markersUsed = markers;

    markers.forEach((m, idx) => {
      if (!m || !m.entity || typeof m.x !== "number" || typeof m.y !== "number") return;

      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", "marker");
      g.dataset.entity = m.entity;
      g.dataset.markerIdx = String(idx);
      if (this._refs) { this._refs.markerGroups[idx] = g; this._refs.markerEntityIds[idx] = m.entity; }

      const w = m.w ?? 300;
      const h = m.h ?? 88;

      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("class", "m-bg");
      rect.setAttribute("x", String(m.x));
      rect.setAttribute("y", String(m.y));
      rect.setAttribute("width", String(w));
      rect.setAttribute("height", String(h));
      g.appendChild(rect);

      const tLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
      tLabel.setAttribute("class", "m-sub");
      tLabel.setAttribute("x", String(m.x + 16));
      tLabel.setAttribute("y", String(m.y + 30));
      tLabel.textContent = m.label || "";
      g.appendChild(tLabel);

      const tVal = document.createElementNS("http://www.w3.org/2000/svg", "text");
      tVal.setAttribute("class", "m-value");
      tVal.setAttribute("x", String(m.x + 16));
      tVal.setAttribute("y", String(m.y + 64));
      tVal.textContent = "—";
      tVal.dataset.value = "1";
      tVal.id = `mval-${idx}`;
      this._refs.markerValueEls[idx] = tVal;
      g.appendChild(tVal);

      gMarkers.appendChild(g);

      g.addEventListener("click", () => {
        fireEvent(this, "hass-more-info", { entityId: m.entity });
      });
    });
  }

  _wireDebug() {
    const c = this._config;
    const wrap = this._els.wrap;
    if (!wrap) return;

    if (this._dbgHandler) wrap.removeEventListener("click", this._dbgHandler);

    this._dbgHandler = (ev) => {
      if (!c.debug) return;
      const rect = wrap.getBoundingClientRect();
      const xRel = (ev.clientX - rect.left) / rect.width;
      const yRel = (ev.clientY - rect.top) / rect.height;

      const vb = c.viewbox || DEFAULT_VIEWBOX;
      const x = Math.round(xRel * vb.w);
      const y = Math.round(yRel * vb.h);

      this._showDebugPoint(x, y);
      console.info(`[${CARD_TAG}] click @ x=${x}, y=${y}`);
    };

    wrap.addEventListener("click", this._dbgHandler);
  }

  _showDebugPoint(x, y) {
    const gDbg = this._els.svg?.querySelector("#debug");
    if (!gDbg) return;

    while (gDbg.firstChild) gDbg.removeChild(gDbg.firstChild);

    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("class", "dbg dbg-dot");
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", String(y));
    dot.setAttribute("r", "8");
    gDbg.appendChild(dot);

    const vbw = this._config.viewbox?.w || DEFAULT_VIEWBOX.w;
    const tipW = 240, tipH = 52;
    const tx = Math.min(x + 14, vbw - tipW - 10);
    const ty = Math.max(y - 60, 10);

    const tip = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    tip.setAttribute("class", "dbg dbg-tip");
    tip.setAttribute("x", String(tx));
    tip.setAttribute("y", String(ty));
    tip.setAttribute("width", String(tipW));
    tip.setAttribute("height", String(tipH));
    gDbg.appendChild(tip);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("class", "dbg dbg-text");
    text.setAttribute("x", String(tx + 14));
    text.setAttribute("y", String(ty + 34));
    text.textContent = `x=${x}  y=${y}`;
    gDbg.appendChild(text);
  }

  _applyBackgroundRules() {
    const c = this._config;
    const hass = this._hass;
    if (!c || !hass || !this._els.bg) return;

    let next = c.backgroundDefault;
    for (const rule of (c.backgroundWhen || [])) {
      if (!rule || !rule.entity || !rule.image) continue;
      const st = getEntity(hass, rule.entity);
      if (!st) continue;
      if (isActiveState(st, rule.state ?? "on")) { next = rule.image; break; }
    }

    if (this._last.bgSrc !== next) {
      this._els.bg.src = next;
      this._last.bgSrc = next;
    }
  }

  _markerIsAlert(markerCfg, stateObj) {
    if (!markerCfg) return false;

    if (markerCfg.alert_entity) {
      const st = getEntity(this._hass, markerCfg.alert_entity);
      if (st && isActiveState(st, markerCfg.alert_state ?? "on")) return true;
    }
    if (markerCfg.alert_state != null && stateObj) {
      if (isActiveState(stateObj, markerCfg.alert_state)) return true;
    }
    const n = numState(stateObj);
    if (n != null) {
      if (markerCfg.alert_below != null && n < Number(markerCfg.alert_below)) return true;
      if (markerCfg.alert_above != null && n > Number(markerCfg.alert_above)) return true;
    }
    return false;
  }

  _update() {
    const hass = this._hass;
    const c = this._config;
    if (!hass || !c || !this._els.svg) return;

    this._applyBackgroundRules();
    this._updateOverlays();

    if (c.debug) {
      const ids = this._collectEntityIds();
      const missing = ids.filter((id) => !hass.states[id]);
      if (missing.length) console.warn(`[${CARD_TAG}] Missing entities:`, missing);
    }

    const mgs = (this._refs && this._refs.markerGroups) ? this._refs.markerGroups : [];
    mgs.forEach((g, idx) => {
      if (!g) return;

      const entityId = (this._refs && this._refs.markerEntityIds) ? this._refs.markerEntityIds[idx] : (g.dataset.entity || '');
      const cfg = this._markersUsed?.[idx] || null;

      const st = getEntity(hass, entityId);
      if (!st && c.debug) console.warn(`[${CARD_TAG}] Missing entity in hass.states: ${entityId}`);
      const valueText = fmtState(st);

      const tVal = (this._refs && this._refs.markerValueEls) ? this._refs.markerValueEls[idx] : null;
      if (!tVal && c.debug) console.warn(`[${CARD_TAG}] Missing marker value element for idx=${idx}, entity=${entityId}`);
      if (tVal) {
        tVal.textContent = valueText;
        this._last.markerText.set(entityId, valueText);
      }

      const alert = this._markerIsAlert(cfg, st);
      g.classList.toggle("alert", alert);
    });

    (c.flows || []).forEach((f) => {
      const p = (this._refs && this._refs.flowEls) ? this._refs.flowEls.get(f.id) : null;
      if (!p) return;
      const st = getEntity(hass, f.entity);
      const active = isActiveState(st, f.active_state);
      p.classList.toggle("active", active);
      p.classList.remove("hot","cold","neutral");
      p.classList.add(f.class || "hot");
      p.classList.toggle("animated", f.animated !== false);
      this._last.activeFlows.set(f.id, active);
    });
  }
}

customElements.define(CARD_TAG, ApaMenajeraCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: "Card Apă Menajeră",
  description: "Imagine + overlay-uri (PNG) + marker-e + trasee animate (solar/electric).",
  preview: true
});

console.info(`[${CARD_TAG}] loaded v${CARD_VERSION}`);
