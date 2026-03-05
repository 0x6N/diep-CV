# diep-CV

## Tampermonkey script

A ready-to-install userscript is available at:

- `scripts/diep-shape-tracker.user.js`

### What it does

- Tracks canvas-rendered entities every frame.
- Stores data in `window.__diepShapeState`.
- Differentiates entities by color + geometry:
  - `#FC7677` → triangle
  - `#768DFC` → pentagon
  - `#FFE869` → square
  - `#00B2E1` → `playerSelf` / `bulletSelf` (radius-based)
  - `#F14E54` → `playerEnemy` / `bulletEnemy` (radius-based)
  - `#999999` → cannon

### Console API

- `diepShapes.getState()`
- `diepShapes.getShapes()`
- `diepShapes.getEntities()`
- `diepShapes.getPlayers()`
- `diepShapes.getBullets()`
- `diepShapes.byType('playerSelf')`
- `diepShapes.enable()` / `diepShapes.disable()` / `diepShapes.clear()`

### Install

1. Install Tampermonkey in your browser.
2. Create a new script.
3. Paste the contents of `scripts/diep-shape-tracker.user.js`.
4. Save and open `https://diep.io/`.
5. Open devtools console and run `diepShapes.getState()`.
