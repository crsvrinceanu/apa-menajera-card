# Apa Menajeră Card — Custom Lovelace Card for Home Assistant

`apa-menajera-card` is a custom Lovelace card for Home Assistant designed to visualize a domestic hot water / plumbing setup (boiler, recirculation, filters, sensors) on top of a background image, with **sensor markers**, **animated SVG flow paths**, and **PNG overlays** controlled by entity states.

---

## Features

- **Responsive background image** with optional `max_width`
- **Dynamic background switching** based on entity rules (e.g., “Electric” / “Solar” modes)
- **Transparent PNG overlays** (pump ON/OFF, valves, icons, warnings) shown conditionally:
  - by exact `state` (e.g., `on`)
  - or by numeric rules (`lt/lte/gt/gte`, `below/above`)
  - optional precise placement using `x/y/w/h` (viewBox coordinates)
- **Sensor markers** (label + value), auto-sized, with tap → `more-info` (or custom `tap_action`)
- **SVG flow paths** (pipes) with `hot/cold/neutral` styles and optional dashed animation when active
- **Debug mode**: click on the card to display `x,y` coordinates (perfect for placing overlays/markers)
- **Vertical “Salt level” bar** (percent) with low-threshold alert coloring
- **Filter “RESET” button**: set an `input_number` to a desired value when it drops below a threshold
- **Flood alert**: pop-up/dialog when `input_boolean.inundatie` turns `on`

---

## Installation

### Recommended (HACS)
1. Add this repository as a **Custom Repository** in HACS (Category: *Lovelace*).
2. Install it.
3. Add the resource in Home Assistant:
   - **Settings → Dashboards → Resources → Add Resource**
   - URL: `/hacsfiles/apa-menajera-card/apa-menajera-card.js`
   - Type: **JavaScript Module**

### Manual
1. Copy `apa-menajera-card.js` into your `/config/www/...` folder.
2. Add it as a Lovelace resource (same menu as above), pointing to `/local/...`.

---

## Basic configuration

```yaml
type: custom:apa-menajera-card
title: "Domestic Hot Water"
background: "/hacsfiles/apa-menajera-card/card.png"

markers:
  - entity: sensor.t1
    label: "Collector"
    x: 420
    y: 120

  - entity: sensor.t2
    label: "Boiler (bottom)"
    x: 420
    y: 240

flows: []
overlays: []
```

---

## Dynamic background (based on entity state)

```yaml
type: custom:apa-menajera-card
background:
  default: "/hacsfiles/apa-menajera-card/card.png"
  when:
    - entity: input_select.vana_3_cai_mode
      state: "Electric"
      image: "/hacsfiles/apa-menajera-card/card_electric.png"
```

---

## Overlays (conditional PNG layers)

### Simple ON/OFF overlay
```yaml
overlays:
  - entity: binary_sensor.pompa_1
    state: "on"
    image: "/hacsfiles/apa-menajera-card/elemente/pompa_on.png"
    opacity: 1
```

### Positioned overlay (x/y/w/h in viewBox coordinates)
```yaml
overlays:
  - entity: binary_sensor.pompa_1
    state: "on"
    image: "/hacsfiles/apa-menajera-card/elemente/pompa_on.png"
    x: 980
    y: 640
    w: 220
    h: 220
```

### Numeric rule (example: filter days = 0 → show red overlay)
```yaml
overlays:
  - entity: input_number.filtru_zile_ramase
    lte: 0
    image: "/hacsfiles/apa-menajera-card/elemente/filtru_red.png"
```

---

## Animated flows (SVG “pipes”)

```yaml
flows:
  - id: solar-pipe
    entity: binary_sensor.pompa_1
    active_state: "on"
    class: hot
    animated: true
    path: |
      M 850 575 L 780 575 L 780 268 L 600 268
```

Available classes: `hot`, `cold`, `neutral` (different glow/styling).

---

## Salt level bar (percent)

```yaml
salt_level:
  entity: sensor.ama_nivel_sare
  x: 1310
  y: 790
  w: 26
  h: 420
  low_threshold: 20
  show_value: true
```

---

## Filter reset button

```yaml
filter_reset_entity: input_number.filtru_zile_ramase
filter_reset_value: 30
filter_reset_button: true
filter_reset_show_below: 3
```

---

## Debug mode (get coordinates)

```yaml
debug: true
```

Click anywhere on the card to display `x/y` and log them in the console. Useful for placing markers and overlays precisely.

---

## Notes / Tips

- Use `debug: true` first, click on the image to get accurate coordinates, then place markers/overlays with those values.
- Prefer PNG overlays with transparent backgrounds for best visual results.

---

## License

Add your preferred license here (MIT recommended).
