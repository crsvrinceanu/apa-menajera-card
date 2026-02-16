# Card Apă Menajeră (Home Assistant)

Custom Lovelace card (HACS plugin) care folosește o imagine de fundal + overlay (SVG) pentru:
- valori (temperaturi / presiune / stare pompă etc.)
- animație de „flux” pe trasee când o entitate e ON
- mod `debug` pentru a afla coordonate (click pe imagine -> coordonatele apar)

## Instalare (HACS)
1. În HACS → **Frontend** → **Custom repositories**
2. Adaugi repo-ul (GitHub) ca **Dashboard**
3. Instalezi
4. În Lovelace → Resources (de obicei HACS o adaugă; dacă nu):
   - URL: `/hacsfiles/apa-menajera-card/apa-menajera-card.js`
   - Type: `module`

> Fișierele sunt servite din `/hacsfiles/<repo>/...`

## Exemplu YAML
```yaml
type: custom:apa-menajera-card
title: Apă menajeră
background: /hacsfiles/apa-menajera-card/card.png
entities:
  pump: binary_sensor.pompa_1
  collector_temp: sensor.t1
  boiler_bottom: sensor.t2
  boiler_top: sensor.t3
  pressure: sensor.apa_presiune_apa
  inlet_temp: sensor.apa_temperatura_apa

# opțional: marker-e (în coordonate din imagine: 2048x1365)
markers:
  - entity: sensor.t1
    label: Colector
    x: 430
    y: 300
  - entity: sensor.t2
    label: Boiler jos
    x: 940
    y: 520
  - entity: sensor.t3
    label: Boiler sus
    x: 940
    y: 360
  - entity: sensor.apa_presiune_apa
    label: Presiune
    x: 990
    y: 1240

# opțional: trasee animate (SVG path)
flows:
  - id: solar_loop
    entity: binary_sensor.pompa_1
    active_state: "on"
    path: "M 190 350 L 730 350 L 730 260 L 845 260 L 845 290"
  - id: dhw_to_house
    entity: binary_sensor.pompa_1
    active_state: "on"
    path: "M 1450 540 L 1785 540 L 1785 420"

debug: false
```

## Debug coordonate (ajustare rapidă)
Setează `debug: true` și apoi:
- click pe imagine → apare un mic tooltip cu `x,y` (în coordonate 2048x1365)
- folosești coordonatele în `markers` sau `flows`

## Update automat (HACS)
Ca Home Assistant să îți arate „Update available”:
1. crești versiunea (ex. `v1.0.1`)
2. publici un **GitHub Release** (Latest release)
HACS se bazează pe release-uri ca să detecteze versiunea nouă.

