/* apa-menajera-card.js
 * Home Assistant custom Lovelace card (HACS plugin).
 * Background image + SVG overlay markers + animated flows.
 * Features:
 * - markers with optional alert rules (turn red on conditions / thresholds)
 * - multiple flows toggled by any entity state (on/off or select value)
 * - optional background switching rules (e.g. electric boiler ON -> alternative image)
 * - debug mode: click -> shows x,y in native background coordinates
 */
const CARD_VERSION = "1.1.2";
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

function fmtState(stateObj) {
  if (!stateObj) return "—";
  const s = stateObj.state;
  if (s === "unknown" || s === "unavailable") return "—";
  const unit = stateObj.attributes?.unit_of_measurement ? stateObj.attributes.unit_of_measurement : "";
  return unit ? `${s} ${unit}` : `${s}`;
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
    this._last = {
      markerText: new Map(),
      activeFlows: new Map(),
      bgSrc: null,
    };
    this._markersUsed = [];
  }

  static getStubConfig() {
    return {
      type: "custom:apa-menajera-card",
      title: "Apă menajeră",
      background: "/hacsfiles/apa-menajera-card/card.png",
      entities: {},
      markers: [],
      flows: [],
      debug: false
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
      entities: config.entities ?? {},
      markers: Array.isArray(config.markers) ? config.markers : [],
      flows: Array.isArray(config.flows) ? config.flows : [],
      debug: !!config.debug,
      viewbox: config.viewbox ?? DEFAULT_VIEWBOX,
      imageFit: config.image_fit ?? "cover",          // cover | contain
      imagePosition: config.image_position ?? "center", // e.g. center, top, bottom
      maxWidth: config.max_width ?? "1100px",          // constrain card width on wide screens (e.g. 900px, 70rem)
      maxHeight: config.max_height ?? null             // optional, e.g. 70vh
    };
    this._renderBase();
  }

  getCardSize() { return 5; }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    this._update();
  }

  connectedCallback() {
    if (this._config) this._renderBase();
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
          z-index: 3;
        }
        .title {
          pointer-events:none;
          font-weight: 600;
          letter-spacing: .2px;
          padding: 6px 10px;
          border-radius: 12px;
          backdrop-filter: blur(8px);
          background: rgba(0,0,0,.35);
          color: var(--primary-text-color, #fff);
          font-size: 14px;
        }
        .badge {
          pointer-events:none;
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
          object-fit: cover;
          user-select:none;
          -webkit-user-drag:none;
        }
        svg.overlay {
          position:absolute;
          inset:0;
          width:100%;
          height:100%;
          pointer-events: none;
        }

        /* Flow styling */
        .flow {
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 10;
          opacity: .0;
          filter: drop-shadow(0 0 6px rgba(0,255,255,.4));
          transition: opacity .25s ease;
        }
        .flow.active { opacity: .9; }
        .flow.hot { stroke: var(--apa-hot-color, #ff4d3a); }
        .flow.cold { stroke: var(--apa-cold-color, #49b5ff); }
        .flow.neutral { stroke: var(--apa-neutral-color, #00e5ff); }

        .flow.active.animated {
          stroke-dasharray: 30 26;
          animation: dash 1.1s linear infinite;
        }
        @keyframes dash { to { stroke-dashoffset: -56; } }

        /* Marker styling */
        .marker { pointer-events: auto; cursor: pointer; }
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
        .marker.hot .m-bg { fill: rgba(255, 77, 58, .22); }
        .marker.cold .m-bg { fill: rgba(73, 181, 255, .22); }

        .m-value {
          font-size: 22px;
          fill: rgba(255,255,255,.95);
          font-weight: 750;
        }
        .m-sub {
          font-size: 18px;
          fill: rgba(255,255,255,.65);
          font-weight: 500;
        }

        /* Debug */
        .dbg { pointer-events: auto; }
        .dbg-dot { fill: rgba(255,255,255,.9); stroke: rgba(0,0,0,.6); stroke-width: 2; }
        .dbg-tip { fill: rgba(0,0,0,.55); stroke: rgba(255,255,255,.2); stroke-width: 1; rx: 10; ry: 10; }
        .dbg-text { font-size: 20px; fill: rgba(255,255,255,.95); font-weight: 700; }
      </style>

      <ha-card class="card">
        <div class="wrap" id="wrap">
          <div class="header">
            <div class="title">${c.title ? this._escape(c.title) : ""}</div>
            <div class="badge">v${CARD_VERSION}</div>
          </div>
          <img class="bg" id="bg" alt="background" />
          <svg class="overlay" id="svg" viewBox="0 0 ${vb.w} ${vb.h}" preserveAspectRatio="xMidYMid meet"></svg>
        </div>
      </ha-card>
    `;

    this._els.wrap = this.shadowRoot.getElementById("wrap");
    this._els.bg = this.shadowRoot.getElementById("bg");
    this._els.svg = this.shadowRoot.getElementById("svg");


    // Apply sizing constraints (responsive)
    const haCard = this.shadowRoot.querySelector("ha-card");
    if (haCard) {
      haCard.style.width = "100%";
      if (c.maxWidth) haCard.style.maxWidth = (typeof c.maxWidth === "number") ? `${c.maxWidth}px` : String(c.maxWidth);
      haCard.style.margin = "0 auto";
    }
    if (c.maxHeight) {
      const wrap = this.shadowRoot.getElementById("wrap");
      if (wrap) {
        wrap.style.maxHeight = (typeof c.maxHeight === "number") ? `${c.maxHeight}px` : String(c.maxHeight);
      }
    }


    this._els.bg.src = c.backgroundDefault;
    this._els.bg.style.objectFit = c.imageFit || 'cover';
    this._els.bg.style.objectPosition = c.imagePosition || 'center';
    this._last.bgSrc = c.backgroundDefault;

    this._buildSvgStatic();
    this._wireDebug();
  }

  _escape(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
  }

  _buildSvgStatic() {
    const svg = this._els.svg;
    if (!svg) return;

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const gFlows = document.createElementNS("http://www.w3.org/2000/svg", "g");
    gFlows.setAttribute("id", "flows");
    svg.appendChild(gFlows);

    const gMarkers = document.createElementNS("http://www.w3.org/2000/svg", "g");
    gMarkers.setAttribute("id", "markers");
    svg.appendChild(gMarkers);

    const gDbg = document.createElementNS("http://www.w3.org/2000/svg", "g");
    gDbg.setAttribute("id", "debug");
    svg.appendChild(gDbg);

    // Build flows
    (this._config.flows || []).forEach((f) => {
      if (!f || !f.path || !f.id || !f.entity) return;
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", f.path);
      p.setAttribute("class", `flow ${f.class || "hot"} ${f.animated !== false ? "animated" : ""}`);
      p.dataset.flowId = f.id;
      gFlows.appendChild(p);
    });

    // Build markers
    const markers = (this._config.markers && this._config.markers.length)
      ? this._config.markers
      : this._defaultMarkers();

    this._markersUsed = markers;

    markers.forEach((m, idx) => {
      if (!m || !m.entity || typeof m.x !== "number" || typeof m.y !== "number") return;

      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", `marker ${m.tone || ""}`.trim());
      g.dataset.entity = m.entity;
      g.dataset.markerIdx = String(idx);

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
      g.appendChild(tVal);

      gMarkers.appendChild(g);

      g.addEventListener("click", () => {
        fireEvent(this, "hass-more-info", { entityId: m.entity });
      });
    });
  }

  _defaultMarkers() {
    return [
      { entity: this._config.entities?.collector_temp || "sensor.t1", label: "Colector T1", x: 260, y: 210, tone: "hot" },
      { entity: this._config.entities?.boiler_top || "sensor.t3", label: "Boiler sus T3", x: 820, y: 250, tone: "hot" },
      { entity: this._config.entities?.boiler_mid || "sensor.t21", label: "Boiler mijloc T21", x: 820, y: 405, tone: "hot" },
      { entity: this._config.entities?.inlet_temp || "sensor.tapa", label: "Temp. apă Tapa", x: 760, y: 1180, w: 320, tone: "cold" },
      { entity: this._config.entities?.pressure || "sensor.papa", label: "Presiune Papa", x: 1100, y: 1180, w: 320 },
      { entity: this._config.entities?.flow || "sensor.debit", label: "Debit", x: 1440, y: 1180, w: 280 },
    ];
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
      const wanted = rule.state ?? "on";
      if (isActiveState(st, wanted)) {
        next = rule.image;
        break;
      }
    }

    if (this._last.bgSrc !== next) {
      this._els.bg.src = next;
      this._last.bgSrc = next;
    }
  }

  _markerIsAlert(markerCfg, stateObj) {
    if (!markerCfg) return false;

    // 1) alert_entity/alert_state (explicit)
    if (markerCfg.alert_entity) {
      const st = getEntity(this._hass, markerCfg.alert_entity);
      if (st && isActiveState(st, markerCfg.alert_state ?? "on")) return true;
    }

    // 2) alert_state on same entity
    if (markerCfg.alert_state != null && stateObj) {
      if (isActiveState(stateObj, markerCfg.alert_state)) return true;
    }

    // 3) thresholds on numeric state
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

    // Update marker values + alert class
    const markerNodes = this._els.svg.querySelectorAll("g.marker");
    markerNodes.forEach((g) => {
      const entityId = g.dataset.entity;
      const idx = Number(g.dataset.markerIdx);
      const cfg = this._markersUsed?.[idx] || null;

      const st = getEntity(hass, entityId);
      const valueText = fmtState(st);

      const tVal = g.querySelector("text[data-value='1']");
      if (tVal) {
        const key = entityId;
        if (this._last.markerText.get(key) !== valueText) {
          tVal.textContent = valueText;
          this._last.markerText.set(key, valueText);
        }
      }

      const alert = this._markerIsAlert(cfg, st);
      g.classList.toggle("alert", alert);
    });

    // Update flows active/inactive
    (c.flows || []).forEach((f) => {
      const p = this._els.svg.querySelector(`path.flow[data-flow-id="${CSS.escape(f.id)}"]`);
      if (!p) return;

      const st = getEntity(hass, f.entity);
      const active = isActiveState(st, f.active_state);

      const was = this._last.activeFlows.get(f.id);
      if (was !== active) {
        p.classList.toggle("active", active);
        if (f.class) {
          p.classList.remove("hot", "cold", "neutral");
          p.classList.add(f.class);
        }
        p.classList.toggle("animated", f.animated !== false);
        this._last.activeFlows.set(f.id, active);
      }
    });

    // Optional visual hint based on pump
    if (c.entities?.pump) {
      const pumpState = getEntity(hass, c.entities.pump);
      const active = isActiveState(pumpState, "on");
      const badge = this.shadowRoot.querySelector(".badge");
      if (badge) {
        badge.style.border = active ? "1px solid rgba(255,77,58,.7)" : "1px solid rgba(255,255,255,.12)";
      }
    }
  }
}

customElements.define(CARD_TAG, ApaMenajeraCard);

// Card picker entry
window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: "Card Apă Menajeră",
  description: "Imagine + marker-e + trasee animate (flux) pentru sistem de apă menajeră (solar/electric).",
  preview: true
});

console.info(`[${CARD_TAG}] loaded v${CARD_VERSION}`);
