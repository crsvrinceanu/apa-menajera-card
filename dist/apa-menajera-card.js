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

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function colorWithOpacity(color, opacity, fallback = "rgba(255, 255, 255, .8)") {
  const c = String(color ?? "").trim();
  const a = clamp(Number(opacity), 0, 1);
  if (!c || !Number.isFinite(a)) return fallback;

  if (/^#([0-9a-f]{3})$/i.test(c)) {
    const hex = c.slice(1);
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  if (/^#([0-9a-f]{6})$/i.test(c)) {
    const hex = c.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  const rgb = c.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgb) {
    const r = clamp(Number(rgb[1]), 0, 255);
    const g = clamp(Number(rgb[2]), 0, 255);
    const b = clamp(Number(rgb[3]), 0, 255);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  const rgba = c.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/i);
  if (rgba) {
    const r = clamp(Number(rgba[1]), 0, 255);
    const g = clamp(Number(rgba[2]), 0, 255);
    const b = clamp(Number(rgba[3]), 0, 255);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return fallback;
}

function isActiveState(stateObj, activeState) {
  if (!stateObj) return false;
  return norm(stateObj.state) === norm(activeState ?? "on");
}

function fmtState(stateObj) {
  if (!stateObj) return "â€”";
  const s = stateObj.state;
  if (s === "unknown" || s === "unavailable") return "â€”";
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

function matchOverlayCondition(stateObj, cfg) {
  if (!stateObj || !cfg) return false;

  const n = numState(stateObj);
  const hasNumericRule =
    cfg.lt != null || cfg.lte != null || cfg.gt != null || cfg.gte != null ||
    cfg.below != null || cfg.above != null;

  if (hasNumericRule && n != null) {
    if (cfg.lt != null && !(n < Number(cfg.lt))) return false;
    if (cfg.lte != null && !(n <= Number(cfg.lte))) return false;
    if (cfg.gt != null && !(n > Number(cfg.gt))) return false;
    if (cfg.gte != null && !(n >= Number(cfg.gte))) return false;
    if (cfg.below != null && !(n < Number(cfg.below))) return false;
    if (cfg.above != null && !(n > Number(cfg.above))) return false;
    return true;
  }

  return isActiveState(stateObj, cfg.state ?? "on");
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
      title: "ApÄƒ menajerÄƒ",
      background: "/hacsfiles/apa-menajera-card/card.png",
      overlays: [],  // [{entity,state,image,x,y,w,h,opacity,fit,position}]
      markers: [],
      flows: [],
      debug: false,
      image_fit: "contain",
      max_width: "1100px",
      marker_label_bg_color: "#ffffff",
      marker_label_bg_opacity: 0.8,
      marker_label_text_color: "#ff9933",
    };
  }

  static getConfigElement() {
    return document.createElement("apa-menajera-card-editor");
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
      maxHeight: config.max_height ?? null,               // e.g. "70vh"
      markerLabelBgColor: config.marker_label_bg_color ?? "#ffffff",
      markerLabelBgOpacity: Number.isFinite(Number(config.marker_label_bg_opacity)) ? Number(config.marker_label_bg_opacity) : 0.8,
      markerLabelTextColor: config.marker_label_text_color ?? "#ff9933"
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
      if (t && t !== "â€”" && t !== "-" && t !== "â€“") return true;
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
        #ovls { position:absolute; inset:0; z-index:2; pointer-events:auto; }
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
          pointer-events:none;
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
          stroke-width:7;
          opacity:0;
          transition: opacity .25s ease;
        }
        .flow.active { opacity:.55; }
        .flow.hot {
          stroke: var(--apa-hot-color, #ff1744);
          filter: drop-shadow(0 0 var(--apa-glow-size, 10px) var(--apa-hot-glow, rgba(255, 23, 69, 0.9)));
        }
        .flow.cold {
          stroke: var(--apa-cold-color, #00e5ff);
          filter: drop-shadow(0 0 var(--apa-glow-size, 10px) var(--apa-cold-glow, rgba(0, 229, 255, .9)));
        }
        .flow.neutral {
          stroke: var(--apa-neutral-color, #00e5ff);
          filter: drop-shadow(0 0 var(--apa-glow-size, 10px) var(--apa-neutral-glow, rgba(0, 229, 255, .75)));
        }
        .flow.active.animated {
          stroke-dasharray: 16 24;
          animation: dash 1.35s linear infinite;
        }
        @keyframes dash { to { stroke-dashoffset: -40; } }

        /* Marker styling */
        .marker { pointer-events:auto; cursor:pointer; }
        .m-bg {
          fill: var(--apa-marker-bg, rgba(255, 255, 255, .80));
          stroke: rgba(150, 215, 255, .98);
          stroke-width: 1.2;
          filter: drop-shadow(0 0 8px rgba(95, 185, 255, .82));
          rx: 10; ry: 10;
          transition: fill .2s ease, stroke .2s ease;
        }
        .marker.alert .m-bg {
          fill: rgba(255, 65, 50, .52);
          stroke: rgba(255, 180, 170, .96);
          filter: drop-shadow(0 0 9px rgba(255, 90, 80, .8));
        }
        .m-sub { font-size:15px; fill: var(--apa-marker-text, #ff9933); font-weight:550; text-anchor: middle; }
        .m-value { font-size:18px; fill: var(--apa-marker-text, #ff9933); font-weight:730; text-anchor: middle; }

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
    this._applyMarkerThemeVars();

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

      if (o.tap_action) {
        img.style.pointerEvents = "auto";
        img.style.cursor = "pointer";
        img.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this._handleOverlayTap(o);
        });
      }

      ovls.appendChild(img);
    });
  }

  _handleOverlayTap(overlayCfg) {
    const ta = overlayCfg?.tap_action;
    if (!ta || typeof ta !== "object") return;

    const msg = ta.confirm || ta.confirmation || "";
    if (msg) {
      const ok = window.confirm(String(msg));
      if (!ok) return;
    }

    if (ta.action === "set_value") {
      const entityId = ta.entity || overlayCfg.entity;
      const value = ta.value;
      if (!entityId || value == null) return;

      const domain = String(entityId).split(".")[0];
      const serviceDomain = (domain === "number") ? "number" : "input_number";
      const service = "set_value";
      const serviceData = { entity_id: entityId, value: Number(value) };

      if (this._hass?.callService) {
        this._hass.callService(serviceDomain, service, serviceData);
      } else {
        fireEvent(this, "hass-call-service", { domain: serviceDomain, service, serviceData });
      }
      return;
    }

    if (ta.action === "call-service") {
      const service = String(ta.service || "");
      if (!service.includes(".")) return;
      const [domain, serviceName] = service.split(".");
      const serviceData = { ...(ta.service_data || ta.data || {}) };
      if (ta.entity) serviceData.entity_id = ta.entity;
      if (this._hass?.callService) {
        this._hass.callService(domain, serviceName, serviceData);
      } else {
        fireEvent(this, "hass-call-service", { domain, service: serviceName, serviceData });
      }
      return;
    }

    if (ta.action === "more-info") {
      const entityId = ta.entity || overlayCfg.entity;
      if (entityId) fireEvent(this, "hass-more-info", { entityId });
    }
  }

  _applyMarkerThemeVars() {
    const c = this._config;
    if (!c) return;
    const bg = colorWithOpacity(c.markerLabelBgColor, c.markerLabelBgOpacity, "rgba(255, 255, 255, .8)");
    const text = String(c.markerLabelTextColor || "#ff9933");
    this.style.setProperty("--apa-marker-bg", bg);
    this.style.setProperty("--apa-marker-text", text);
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
      const active = matchOverlayCondition(st, o);
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
      tVal.textContent = "â€”";
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

        // Auto-size marker box to fit current text content (label + value).
        const labelEl = g.querySelector(".m-sub");
        const bgEl = g.querySelector(".m-bg");
        if (labelEl && bgEl) {
          const padX = 8;
          const padTop = 8;
          const gap = 4;
          const padBottom = 9;
          const minW = 100;
          const minH = 50;

          let labelW = 0, labelH = 0, valueW = 0, valueH = 0;
          try {
            const lb = labelEl.getBBox();
            labelW = lb.width || 0;
            labelH = lb.height || 0;
          } catch (e) {}
          try {
            const vb = tVal.getBBox();
            valueW = vb.width || 0;
            valueH = vb.height || 0;
          } catch (e) {}

          const boxW = Math.max(minW, Math.ceil(Math.max(labelW, valueW) + (padX * 2)));
          const boxH = Math.max(minH, Math.ceil(labelH + gap + valueH + padTop + padBottom));

          bgEl.setAttribute("width", String(boxW));
          bgEl.setAttribute("height", String(boxH));

          const baseX = Number(bgEl.getAttribute("x") || "0");
          const baseY = Number(bgEl.getAttribute("y") || "0");
          const cx = baseX + (boxW / 2);
          labelEl.setAttribute("x", String(cx));
          labelEl.setAttribute("y", String(baseY + padTop + 14));
          tVal.setAttribute("x", String(cx));
          tVal.setAttribute("y", String(baseY + boxH - padBottom + 1));
        }
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

class ApaMenajeraCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._openMarkerIdx = -1;
  }

  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  connectedCallback() {
    this._render();
  }

  _emitConfig(config) {
    fireEvent(this, "config-changed", { config });
  }

  _onTitleChange(ev) {
    const next = { ...(this._config || {}), title: ev.target.value };
    this._config = next;
    this._emitConfig(next);
  }

  _onBackgroundChange(ev) {
    const raw = ev.target.value.trim();
    const next = { ...(this._config || {}) };
    if (!raw) {
      delete next.background;
    } else {
      next.background = raw;
    }
    this._config = next;
    this._emitConfig(next);
  }

  _onMarkerBgColorChange(ev) {
    const next = { ...(this._config || {}), marker_label_bg_color: ev.target.value || "#ffffff" };
    this._config = next;
    this._emitConfig(next);
  }

  _onMarkerBgOpacityChange(ev) {
    const raw = ev.target.value;
    const n = clamp(Number(raw), 0, 1);
    const next = { ...(this._config || {}), marker_label_bg_opacity: Number.isFinite(n) ? n : 0.8 };
    this._config = next;
    this._emitConfig(next);
  }

  _onMarkerTextColorChange(ev) {
    const next = { ...(this._config || {}), marker_label_text_color: ev.target.value || "#ff9933" };
    this._config = next;
    this._emitConfig(next);
  }

  _updateMarkers(nextMarkers) {
    const markers = Array.isArray(nextMarkers) ? nextMarkers : [];
    const next = { ...(this._config || {}), markers };
    this._config = next;
    this._emitConfig(next);
  }

  _onMarkerFieldChange(idx, field, rawValue) {
    const markers = Array.isArray(this._config?.markers) ? [...this._config.markers] : [];
    if (!markers[idx]) return;
    const nextMarker = { ...markers[idx] };

    if (field === "x" || field === "y") {
      const n = Number(rawValue);
      if (rawValue === "") {
        delete nextMarker[field];
      } else if (Number.isFinite(n)) {
        nextMarker[field] = n;
      } else {
        return;
      }
    } else {
      nextMarker[field] = rawValue;
    }

    markers[idx] = nextMarker;
    this._updateMarkers(markers);
  }

  _addMarker() {
    const markers = Array.isArray(this._config?.markers) ? [...this._config.markers] : [];
    markers.push({
      entity: "",
      label: "",
      x: 100,
      y: 100,
    });
    this._updateMarkers(markers);
    this._openMarkerIdx = markers.length - 1;
    this._render();
  }

  _removeMarker(idx) {
    const markers = Array.isArray(this._config?.markers) ? [...this._config.markers] : [];
    if (!markers[idx]) return;
    markers.splice(idx, 1);
    this._updateMarkers(markers);
    if (this._openMarkerIdx === idx) this._openMarkerIdx = -1;
    if (this._openMarkerIdx > idx) this._openMarkerIdx -= 1;
    this._render();
  }

  _toggleMarker(idx) {
    this._openMarkerIdx = (this._openMarkerIdx === idx) ? -1 : idx;
    this._render();
  }

  _render() {
    const c = this._config || {};
    const markers = Array.isArray(c.markers) ? c.markers : [];
    const bg = (typeof c.background === "string") ? c.background : "";
    const markerBgColor = c.marker_label_bg_color || "#ffffff";
    const markerBgOpacity = Number.isFinite(Number(c.marker_label_bg_opacity)) ? Number(c.marker_label_bg_opacity) : 0.8;
    const markerTextColor = c.marker_label_text_color || "#ff9933";

    const rows = markers.length
      ? markers.map((m, idx) => `
          <div class="row">
            <button class="row-toggle" data-toggle-idx="${idx}" type="button">
              <span class="row-title">${this._escape(m?.label || `Marker ${idx + 1}`)}</span>
              <span class="row-sub">${this._escape(m?.entity || "fara entity")} | x:${(m?.x != null) ? String(m.x) : "-"} y:${(m?.y != null) ? String(m.y) : "-"}</span>
            </button>
            <div class="row-body ${this._openMarkerIdx === idx ? "open" : ""}">
              <div class="grid">
                <input
                  data-marker-idx="${idx}"
                  data-field="entity"
                  type="text"
                  value="${this._escape(m?.entity || "")}"
                  placeholder="sensor.exemplu"
                />
                <input
                  data-marker-idx="${idx}"
                  data-field="label"
                  type="text"
                  value="${this._escape(m?.label || "")}"
                  placeholder="Nume senzor"
                />
                <input
                  data-marker-idx="${idx}"
                  data-field="x"
                  type="number"
                  step="1"
                  value="${(m?.x != null) ? String(m.x) : ""}"
                  placeholder="x"
                />
                <input
                  data-marker-idx="${idx}"
                  data-field="y"
                  type="number"
                  step="1"
                  value="${(m?.y != null) ? String(m.y) : ""}"
                  placeholder="y"
                />
              </div>
              <div class="row-actions">
                <button class="btn danger" data-remove-idx="${idx}" type="button">Sterge</button>
              </div>
            </div>
          </div>
        `).join("")
      : `<div class="empty">Nu ai markere configurate. Adauga primul marker din buton.</div>`;

    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; }
        .wrap { padding: 12px; }
        .card {
          border: 1px solid rgba(127,127,127,.35);
          border-radius: 12px;
          padding: 12px;
          background: rgba(127,127,127,.08);
        }
        h3 {
          margin: 0 0 10px 0;
          font-size: 14px;
          font-weight: 700;
        }
        .field { margin: 0 0 10px 0; }
        .field label {
          display:block;
          font-size: 12px;
          opacity: .8;
          margin-bottom: 4px;
        }
        input {
          width: 100%;
          box-sizing: border-box;
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid rgba(127,127,127,.45);
          background: transparent;
          color: inherit;
          font-size: 13px;
        }
        .btn {
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid rgba(127,127,127,.45);
          background: transparent;
          color: inherit;
          cursor: pointer;
          font-size: 12px;
        }
        .btn.danger {
          border-color: rgba(255,80,80,.5);
          color: rgba(255,80,80,.95);
        }
        .btn.primary {
          border-color: rgba(90,170,255,.55);
          color: rgba(90,170,255,.95);
        }
        .rows { display: grid; gap: 8px; }
        .row {
          border: 1px solid rgba(127,127,127,.35);
          border-radius: 10px;
          overflow: hidden;
          background: rgba(127,127,127,.05);
        }
        .row-toggle {
          width: 100%;
          text-align: left;
          background: transparent;
          border: 0;
          color: inherit;
          cursor: pointer;
          padding: 8px 10px;
          display: grid;
          gap: 3px;
        }
        .row-title {
          font-size: 13px;
          font-weight: 700;
          line-height: 1.2;
        }
        .row-sub {
          font-size: 11px;
          opacity: .75;
          line-height: 1.2;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        .row-body {
          display: none;
          padding: 8px 10px 10px;
          border-top: 1px solid rgba(127,127,127,.25);
        }
        .row-body.open { display: block; }
        .grid {
          display: grid;
          grid-template-columns: 1fr 1fr 88px 88px;
          gap: 8px;
        }
        .row-actions {
          margin-top: 8px;
        }
        .empty {
          font-size: 12px;
          opacity: .75;
          padding: 8px 0;
        }
        @media (max-width: 620px) {
          .grid { grid-template-columns: 1fr 1fr; }
        }
      </style>
      <div class="wrap">
        <div class="card">
          <h3>Setari Card</h3>
          <div class="field">
            <label>Titlu</label>
            <input id="title" type="text" value="${this._escape(c.title || "")}" placeholder="Apa menajera" />
          </div>
          <div class="field">
            <label>Imagine fundal (URL)</label>
            <input id="background" type="text" value="${this._escape(bg)}" placeholder="/hacsfiles/apa-menajera-card/card.png" />
          </div>
          <div class="field">
            <label>Culoare fundal etichete</label>
            <input id="marker-bg-color" type="color" value="${this._escape(markerBgColor)}" />
          </div>
          <div class="field">
            <label>Opacitate fundal etichete (0-1)</label>
            <input id="marker-bg-opacity" type="number" min="0" max="1" step="0.05" value="${String(markerBgOpacity)}" />
          </div>
          <div class="field">
            <label>Culoare text etichete</label>
            <input id="marker-text-color" type="color" value="${this._escape(markerTextColor)}" />
          </div>
          <h3>Senzori (Markers)</h3>
          <div class="rows">${rows}</div>
          <div style="margin-top:8px;">
            <button id="add-marker" class="btn primary" type="button">Adauga marker</button>
          </div>
        </div>
      </div>
    `;

    const titleEl = this.shadowRoot.getElementById("title");
    const bgEl = this.shadowRoot.getElementById("background");
    const markerBgColorEl = this.shadowRoot.getElementById("marker-bg-color");
    const markerBgOpacityEl = this.shadowRoot.getElementById("marker-bg-opacity");
    const markerTextColorEl = this.shadowRoot.getElementById("marker-text-color");
    if (titleEl) {
      titleEl.addEventListener("input", (ev) => this._onTitleChange(ev));
    }
    if (bgEl) {
      bgEl.addEventListener("input", (ev) => this._onBackgroundChange(ev));
    }
    if (markerBgColorEl) {
      markerBgColorEl.addEventListener("input", (ev) => this._onMarkerBgColorChange(ev));
    }
    if (markerBgOpacityEl) {
      markerBgOpacityEl.addEventListener("input", (ev) => this._onMarkerBgOpacityChange(ev));
    }
    if (markerTextColorEl) {
      markerTextColorEl.addEventListener("input", (ev) => this._onMarkerTextColorChange(ev));
    }

    const addBtn = this.shadowRoot.getElementById("add-marker");
    if (addBtn) {
      addBtn.addEventListener("click", () => this._addMarker());
    }

    this.shadowRoot.querySelectorAll("input[data-marker-idx]").forEach((el) => {
      const idx = Number(el.getAttribute("data-marker-idx"));
      const field = el.getAttribute("data-field");
      el.addEventListener("input", (ev) => this._onMarkerFieldChange(idx, field, ev.target.value));
    });

    this.shadowRoot.querySelectorAll("button[data-remove-idx]").forEach((el) => {
      const idx = Number(el.getAttribute("data-remove-idx"));
      el.addEventListener("click", () => this._removeMarker(idx));
    });

    this.shadowRoot.querySelectorAll("button[data-toggle-idx]").forEach((el) => {
      const idx = Number(el.getAttribute("data-toggle-idx"));
      el.addEventListener("click", () => this._toggleMarker(idx));
    });
  }

  _escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
  }
}
customElements.define(CARD_TAG, ApaMenajeraCard);
customElements.define("apa-menajera-card-editor", ApaMenajeraCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: "Card ApÄƒ MenajerÄƒ",
  description: "Imagine + overlay-uri (PNG) + marker-e + trasee animate (solar/electric).",
  preview: true
});

console.info(`[${CARD_TAG}] loaded v${CARD_VERSION}`);

