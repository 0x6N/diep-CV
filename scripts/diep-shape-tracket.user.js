// ==UserScript==
// @name         Diep.io Shape Tracker
// @namespace    https://diep.io/
// @version      1.6.0
// @description  Capture rendered entities (shapes, players, bullets, cannons) and expose them in the browser console.
// @author       codex
// @match        https://diep.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const inject = () => {
    const trackerBootstrap = () => {
      if (window.__diepShapeTrackerInstalled) return;
      window.__diepShapeTrackerInstalled = true;

      const ENTITY_COLORS = {
        triangle: '#fc7677',
        pentagon: '#768dfc',
        square: '#ffe869',
        self: '#00b2e1',
        enemy: '#f14e54',
        cannon: '#999999',
      };

      const BACKGROUND_RECT_BASE_SCALE = 0.7120758295059204;

      const trackerState = {
        enabled: true,
        frame: 0,
        timestamp: 0,
        canvasSize: { width: 0, height: 0 },
        entities: [],
        shapes: [],
        players: [],
        bullets: [],
        labels: [],
        zoom: { current: 1, samples: [], fallbackSamples: [], method: 'setTransform-dominant-scale', sourceScale: null, baseScale: BACKGROUND_RECT_BASE_SCALE },
        counts: {
          total: 0,
          players: 0,
          bullets: 0,
          triangles: 0,
          pentagons: 0,
          squares: 0,
          cannons: 0,
          circles: 0,
          polygons: 0,
          rectangles: 0,
          text: 0,
          paths: 0,
        },
      };

      const frameShapes = [];
      const frameTransformEvents = [];

      const wasmState = {
        instance: null,
        exports: null,
        zoomProbe: null,
      };


      const installWasmHooks = () => {
        if (window.__diepShapeTrackerWasmHookInstalled) return;
        window.__diepShapeTrackerWasmHookInstalled = true;

        const captureInstance = (instance) => {
          if (!instance || !instance.exports) return;
          wasmState.instance = instance;
          wasmState.exports = instance.exports;
          wasmState.zoomProbe = null;
        };

        const originalInstantiate = WebAssembly.instantiate.bind(WebAssembly);
        WebAssembly.instantiate = async (...args) => {
          const out = await originalInstantiate(...args);
          if (out && out.instance) captureInstance(out.instance);
          else if (out instanceof WebAssembly.Instance) captureInstance(out);
          return out;
        };

        const originalInstantiateStreaming = WebAssembly.instantiateStreaming
          ? WebAssembly.instantiateStreaming.bind(WebAssembly)
          : null;
        if (originalInstantiateStreaming) {
          WebAssembly.instantiateStreaming = async (...args) => {
            const out = await originalInstantiateStreaming(...args);
            if (out && out.instance) captureInstance(out.instance);
            return out;
          };
        }
      };

      const buildWasmZoomProbe = () => {
        const exp = wasmState.exports;
        if (!exp) return null;

        const likely = [];
        for (const [name, value] of Object.entries(exp)) {
          if (!/zoom|camera|fov|scale/i.test(name)) continue;

          if (typeof value === 'function' && value.length === 0) {
            likely.push({ kind: 'fn', name, value });
          } else if (typeof WebAssembly.Global !== 'undefined' && value instanceof WebAssembly.Global) {
            likely.push({ kind: 'global', name, value });
          }
        }

        for (const candidate of likely) {
          try {
            const v = candidate.kind === 'fn' ? candidate.value() : candidate.value.value;
            if (Number.isFinite(v) && v > 0.01 && v < 100) {
              return candidate;
            }
          } catch {}
        }

        return null;
      };

      const zoomFromWasm = () => {
        if (!wasmState.exports) return null;

        if (!wasmState.zoomProbe) {
          wasmState.zoomProbe = buildWasmZoomProbe();
        }

        const probe = wasmState.zoomProbe;
        if (!probe) return null;

        try {
          const value = probe.kind === 'fn' ? probe.value() : probe.value.value;
          if (Number.isFinite(value) && value > 0.01 && value < 100) {
            return {
              value,
              method:
                probe.kind === 'fn'
                  ? `wasm-export-function:${probe.name}`
                  : `wasm-export-global:${probe.name}`,
            };
          }
        } catch {
          wasmState.zoomProbe = null;
        }

        return null;
      };

      const normalizeColor = (value) => {
        if (!value || typeof value !== 'string') return '';
        const raw = value.trim().toLowerCase();

        if (raw.startsWith('#')) {
          if (raw.length === 4) {
            return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
          }
          return raw;
        }

        const rgbMatch = raw.match(/^rgba?\(([^)]+)\)$/);
        if (rgbMatch) {
          const parts = rgbMatch[1].split(',').map((part) => part.trim());
          if (parts.length >= 3) {
            const r = Number(parts[0]);
            const g = Number(parts[1]);
            const b = Number(parts[2]);
            if ([r, g, b].every((n) => Number.isFinite(n))) {
              return `#${[r, g, b]
                .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'))
                .join('')}`;
            }
          }
        }

        return raw;
      };

      const matrixPoint = (matrix, x, y) => ({
        x: matrix.a * x + matrix.c * y + matrix.e,
        y: matrix.b * x + matrix.d * y + matrix.f,
      });

      const shapeBoundsFromPoints = (points) => {
        if (!points.length) return null;
        const xs = points.map((point) => point.x);
        const ys = points.map((point) => point.y);
        return {
          minX: Math.min(...xs),
          maxX: Math.max(...xs),
          minY: Math.min(...ys),
          maxY: Math.max(...ys),
        };
      };

      const transformScale = (matrix) => {
        const sx = Math.hypot(matrix.a, matrix.b);
        const sy = Math.hypot(matrix.c, matrix.d);
        if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return 1;
        return (sx + sy) / 2;
      };

      const dominantZoom = (samples) => {
        if (!samples.length) return trackerState.zoom.current || 1;
        const buckets = new Map();
        for (const sample of samples) {
          if (!Number.isFinite(sample) || sample <= 0) continue;
          const key = Math.round(sample * 100) / 100;
          buckets.set(key, (buckets.get(key) || 0) + 1);
        }
        if (!buckets.size) return trackerState.zoom.current || 1;
        let bestKey = null;
        let bestCount = -1;
        for (const [key, count] of buckets.entries()) {
          if (count > bestCount) {
            bestCount = count;
            bestKey = key;
          }
        }
        return bestKey || trackerState.zoom.current || 1;
      };


      const isObjectLikeFillStyle = (fillStyle) => fillStyle && typeof fillStyle === 'object';

      const zoomFromBackgroundRect = (entities) => {
        const candidates = entities.filter((entity) => {
          if (!entity || entity.kind !== 'rectangle' || entity.drawMode !== 'fill') return false;
          if (!isObjectLikeFillStyle(entity.fillStyle)) return false;
          return Number.isFinite(entity.transformScale) && entity.transformScale > 0.05;
        });

        if (!candidates.length) return null;

        // Keep the largest rectangle, this matches the world/background-like draw call.
        const pick = candidates
          .map((entity) => {
            const b = entity.bounds;
            const area = b ? Math.max(0, (b.maxX - b.minX) * (b.maxY - b.minY)) : 0;
            return { entity, area };
          })
          .sort((a, b) => b.area - a.area)[0]?.entity;

        if (!pick) return null;

        const scale = pick.transformScale;
        if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(BACKGROUND_RECT_BASE_SCALE) || BACKGROUND_RECT_BASE_SCALE <= 0) {
          return null;
        }

        return {
          value: scale / BACKGROUND_RECT_BASE_SCALE,
          method: 'background-rect-transformScale',
          sourceScale: scale,
        };
      };

      const chooseZoom = (entities, transformSamples, entitySamples) => {
        const bgZoom = zoomFromBackgroundRect(entities);
        if (bgZoom && Number.isFinite(bgZoom.value) && bgZoom.value > 0.01 && bgZoom.value < 20) {
          return bgZoom;
        }

        const wasmZoom = zoomFromWasm();
        if (wasmZoom && Number.isFinite(wasmZoom.value) && wasmZoom.value > 0.01) {
          return wasmZoom;
        }

        const transformZoom = dominantZoom(transformSamples);
        if (Number.isFinite(transformZoom) && transformZoom > 0.05 && transformZoom < 20) {
          return { value: transformZoom, method: 'setTransform-dominant-scale' };
        }

        const fallbackZoom = dominantZoom(entitySamples);
        return {
          value: Number.isFinite(fallbackZoom) && fallbackZoom > 0.05 && fallbackZoom < 20 ? fallbackZoom : 1,
          method: 'entity-transform-dominant-scale',
        };
      };

      const classifyPathKind = (commands) => {
        const hasArc = commands.some((command) => command.type === 'arc');
        const hasLine = commands.some((command) => command.type === 'lineTo');
        const hasRect = commands.some((command) => command.type === 'rect');
        if (hasRect) return 'rectangle';
        if (hasArc) return 'circle';
        if (hasLine) return 'polygon';
        return 'path';
      };

      const pointsFromCommand = (command) => {
        if (command.type === 'moveTo' || command.type === 'lineTo') {
          return [{ x: command.tx, y: command.ty }];
        }
        if (command.type === 'rect') {
          return command.points || [];
        }
        if (command.type === 'arc') {
          return command.points || [];
        }
        return [];
      };

      const inferPolygonEdges = (commands) => {
        const vertices = commands.filter((cmd) => cmd.type === 'lineTo').length;
        if (!vertices) return 0;
        return vertices + 1;
      };

      const inferEntityType = (shape, zoomLevel) => {
        const fill = normalizeColor(shape.fillStyle);
        const stroke = normalizeColor(shape.strokeStyle);
        const color = fill || stroke;
        const screenRadius = shape.radius || 0;
        const zoomSafe = Number.isFinite(zoomLevel) && zoomLevel > 0 ? zoomLevel : 1;
        const normalizedRadius = screenRadius / zoomSafe;

        if (color === ENTITY_COLORS.cannon) return 'cannon';

        if (shape.kind === 'polygon') {
          const edges = shape.edges || 0;
          if (color === ENTITY_COLORS.triangle || edges === 3) return 'triangle';
          if (color === ENTITY_COLORS.pentagon || edges === 5) return 'pentagon';
          if (color === ENTITY_COLORS.square || edges === 4) return 'square';
        }

        if (shape.kind === 'rectangle' && color === ENTITY_COLORS.square) return 'square';

        if (shape.kind === 'circle' && color === ENTITY_COLORS.self) {
          return normalizedRadius >= 9 ? 'playerSelf' : 'bulletSelf';
        }

        if (shape.kind === 'circle' && color === ENTITY_COLORS.enemy) {
          return normalizedRadius >= 32.9 ? 'playerEnemy' : 'bulletEnemy';
        }

        if (color === ENTITY_COLORS.self) return 'selfColored';
        if (color === ENTITY_COLORS.enemy) return 'enemyColored';

        return 'unknown';
      };

      const capturePathShape = (ctx, drawMode) => {
        if (!trackerState.enabled || !ctx.__diepPathCommands?.length) return;

        const commands = ctx.__diepPathCommands.map((command) => ({ ...command }));
        const matrix = ctx.getTransform();
        const scale = transformScale(matrix);
        const points = commands.flatMap(pointsFromCommand);
        const bounds = shapeBoundsFromPoints(points);
        const kind = classifyPathKind(commands);
        const firstArc = commands.find((command) => command.type === 'arc');
        const edges = kind === 'polygon' ? inferPolygonEdges(commands) : 0;
        const shape = {
          drawMode,
          kind,
          edges,
          alpha: ctx.globalAlpha,
          fillStyle: ctx.fillStyle,
          strokeStyle: ctx.strokeStyle,
          lineWidth: ctx.lineWidth,
          bounds,
          commands,
          radius: firstArc ? firstArc.transformedRadius : null,
          transformScale: scale,
          position: bounds
            ? {
                x: (bounds.minX + bounds.maxX) / 2,
                y: (bounds.minY + bounds.maxY) / 2,
              }
            : null,
        };

        const zoomLevel = trackerState.zoom.current || 1;
        shape.zoom = zoomLevel;
        shape.zoomNormalizedRadius = shape.radius != null ? shape.radius / zoomLevel : null;
        shape.entityType = inferEntityType(shape, zoomLevel);
        frameShapes.push(shape);

        ctx.__diepPathCommands = [];
      };

      installWasmHooks();

      const contextProto = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
      if (!contextProto) return;

      const original = {
        beginPath: contextProto.beginPath,
        moveTo: contextProto.moveTo,
        lineTo: contextProto.lineTo,
        rect: contextProto.rect,
        arc: contextProto.arc,
        closePath: contextProto.closePath,
        fill: contextProto.fill,
        stroke: contextProto.stroke,
        fillRect: contextProto.fillRect,
        strokeRect: contextProto.strokeRect,
        fillText: contextProto.fillText,
        strokeText: contextProto.strokeText,
        setTransform: contextProto.setTransform,
        transform: contextProto.transform,
        scale: contextProto.scale,
      };


      const captureTransformEvent = (ctx) => {
        if (!trackerState.enabled) return;
        const m = ctx.getTransform();
        const scale = transformScale(m);
        if (!Number.isFinite(scale) || scale <= 0) return;
        frameTransformEvents.push(scale);
      };

      contextProto.setTransform = function (...args) {
        const out = original.setTransform.apply(this, args);
        captureTransformEvent(this);
        return out;
      };

      contextProto.transform = function (...args) {
        const out = original.transform.apply(this, args);
        captureTransformEvent(this);
        return out;
      };

      contextProto.scale = function (...args) {
        const out = original.scale.apply(this, args);
        captureTransformEvent(this);
        return out;
      };

      contextProto.beginPath = function (...args) {
        this.__diepPathCommands = [];
        return original.beginPath.apply(this, args);
      };

      contextProto.moveTo = function (x, y) {
        this.__diepPathCommands ||= [];
        const matrix = this.getTransform();
        const p = matrixPoint(matrix, x, y);
        this.__diepPathCommands.push({ type: 'moveTo', x, y, tx: p.x, ty: p.y });
        return original.moveTo.call(this, x, y);
      };

      contextProto.lineTo = function (x, y) {
        this.__diepPathCommands ||= [];
        const matrix = this.getTransform();
        const p = matrixPoint(matrix, x, y);
        this.__diepPathCommands.push({ type: 'lineTo', x, y, tx: p.x, ty: p.y });
        return original.lineTo.call(this, x, y);
      };

      contextProto.rect = function (x, y, width, height) {
        this.__diepPathCommands ||= [];
        const matrix = this.getTransform();
        const points = [
          matrixPoint(matrix, x, y),
          matrixPoint(matrix, x + width, y),
          matrixPoint(matrix, x, y + height),
          matrixPoint(matrix, x + width, y + height),
        ];
        this.__diepPathCommands.push({ type: 'rect', x, y, width, height, points });
        return original.rect.call(this, x, y, width, height);
      };

      contextProto.arc = function (x, y, radius, startAngle, endAngle, counterclockwise) {
        this.__diepPathCommands ||= [];

        const matrix = this.getTransform();
        const sampleCount = 20;
        const points = [];
        for (let i = 0; i <= sampleCount; i += 1) {
          const t = i / sampleCount;
          const angle = startAngle + (endAngle - startAngle) * t;
          points.push(matrixPoint(matrix, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius));
        }

        const center = matrixPoint(matrix, x, y);
        const radiusPoint = matrixPoint(matrix, x + radius, y);
        const transformedRadius = Math.hypot(radiusPoint.x - center.x, radiusPoint.y - center.y);

        this.__diepPathCommands.push({
          type: 'arc',
          x,
          y,
          radius,
          transformedRadius,
          startAngle,
          endAngle,
          counterclockwise: !!counterclockwise,
          points,
        });

        return original.arc.call(this, x, y, radius, startAngle, endAngle, counterclockwise);
      };

      contextProto.closePath = function (...args) {
        this.__diepPathCommands ||= [];
        this.__diepPathCommands.push({ type: 'closePath' });
        return original.closePath.apply(this, args);
      };

      contextProto.fill = function (...args) {
        capturePathShape(this, 'fill');
        return original.fill.apply(this, args);
      };

      contextProto.stroke = function (...args) {
        capturePathShape(this, 'stroke');
        return original.stroke.apply(this, args);
      };

      const captureRect = (ctx, mode, x, y, width, height) => {
        if (!trackerState.enabled) return;
        const matrix = ctx.getTransform();
        const points = [
          matrixPoint(matrix, x, y),
          matrixPoint(matrix, x + width, y),
          matrixPoint(matrix, x, y + height),
          matrixPoint(matrix, x + width, y + height),
        ];
        const bounds = shapeBoundsFromPoints(points);

        const scale = transformScale(matrix);
        const shape = {
          drawMode: mode,
          kind: 'rectangle',
          edges: 4,
          alpha: ctx.globalAlpha,
          fillStyle: ctx.fillStyle,
          strokeStyle: ctx.strokeStyle,
          lineWidth: ctx.lineWidth,
          bounds,
          position: bounds
            ? {
                x: (bounds.minX + bounds.maxX) / 2,
                y: (bounds.minY + bounds.maxY) / 2,
              }
            : null,
          radius: null,
          transformScale: scale,
          commands: [{ type: 'rect', x, y, width, height, points }],
        };

        const zoomLevel = trackerState.zoom.current || 1;
        shape.zoom = zoomLevel;
        shape.zoomNormalizedRadius = shape.radius != null ? shape.radius / zoomLevel : null;
        shape.entityType = inferEntityType(shape, zoomLevel);
        frameShapes.push(shape);
      };

      contextProto.fillRect = function (x, y, width, height) {
        captureRect(this, 'fill', x, y, width, height);
        return original.fillRect.call(this, x, y, width, height);
      };

      contextProto.strokeRect = function (x, y, width, height) {
        captureRect(this, 'stroke', x, y, width, height);
        return original.strokeRect.call(this, x, y, width, height);
      };

      const captureText = (ctx, mode, text, x, y) => {
        if (!trackerState.enabled) return;
        const matrix = ctx.getTransform();
        const scale = transformScale(matrix);
        const shape = {
          drawMode: mode,
          kind: 'text',
          edges: 0,
          text: String(text),
          alpha: ctx.globalAlpha,
          fillStyle: ctx.fillStyle,
          strokeStyle: ctx.strokeStyle,
          lineWidth: ctx.lineWidth,
          position: matrixPoint(matrix, x, y),
          bounds: null,
          radius: null,
          transformScale: scale,
          commands: [{ type: 'text', x, y, text: String(text) }],
          entityType: 'text',
        };
        frameShapes.push(shape);
      };

      contextProto.fillText = function (text, x, y, maxWidth) {
        captureText(this, 'fill', text, x, y);
        return original.fillText.call(this, text, x, y, maxWidth);
      };

      contextProto.strokeText = function (text, x, y, maxWidth) {
        captureText(this, 'stroke', text, x, y);
        return original.strokeText.call(this, text, x, y, maxWidth);
      };

      const updateCounts = (entities) => ({
        total: entities.length,
        players: entities.filter((e) => e.entityType === 'playerSelf' || e.entityType === 'playerEnemy').length,
        bullets: entities.filter((e) => e.entityType === 'bulletSelf' || e.entityType === 'bulletEnemy').length,
        triangles: entities.filter((e) => e.entityType === 'triangle').length,
        pentagons: entities.filter((e) => e.entityType === 'pentagon').length,
        squares: entities.filter((e) => e.entityType === 'square').length,
        cannons: entities.filter((e) => e.entityType === 'cannon').length,
        circles: entities.filter((e) => e.kind === 'circle').length,
        polygons: entities.filter((e) => e.kind === 'polygon').length,
        rectangles: entities.filter((e) => e.kind === 'rectangle').length,
        text: entities.filter((e) => e.kind === 'text').length,
        paths: entities.filter((e) => e.kind === 'path').length,
      });

      const originalRaf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) =>
        originalRaf((timestamp) => {
          trackerState.timestamp = timestamp;
          trackerState.frame += 1;

          const canvas = document.getElementById('canvas');
          if (canvas) {
            trackerState.canvasSize = { width: canvas.width, height: canvas.height };
          }

          trackerState.entities = frameShapes.splice(0, frameShapes.length);

          const entityZoomSamples = trackerState.entities
            .map((entity) => entity.transformScale)
            .filter((value) => Number.isFinite(value) && value > 0.05 && value < 20);
          const transformZoomSamples = frameTransformEvents
            .filter((value) => Number.isFinite(value) && value > 0.05 && value < 20);

          const zoomChoice = chooseZoom(trackerState.entities, transformZoomSamples, entityZoomSamples);
          const zoomLevel = zoomChoice.value;
          trackerState.zoom = {
            current: zoomLevel,
            samples: transformZoomSamples.slice(0, 100),
            fallbackSamples: entityZoomSamples.slice(0, 100),
            method: zoomChoice.method,
            sourceScale: zoomChoice.sourceScale ?? null,
            baseScale: BACKGROUND_RECT_BASE_SCALE,
          };

          for (const entity of trackerState.entities) {
            entity.zoom = zoomLevel;
            entity.zoomNormalizedRadius = entity.radius != null ? entity.radius / zoomLevel : null;
            entity.entityType = inferEntityType(entity, zoomLevel);
          }

          trackerState.shapes = trackerState.entities;
          trackerState.players = trackerState.entities.filter(
            (entity) => entity.entityType === 'playerSelf' || entity.entityType === 'playerEnemy',
          );
          trackerState.bullets = trackerState.entities.filter(
            (entity) => entity.entityType === 'bulletSelf' || entity.entityType === 'bulletEnemy',
          );
          trackerState.labels = trackerState.entities.filter((entity) => entity.kind === 'text');
          trackerState.counts = updateCounts(trackerState.entities);

          frameTransformEvents.length = 0;

          window.__diepShapeState = trackerState;
          callback(timestamp);
        });

      window.diepShapes = {
        getState: () => trackerState,
        getShapes: () => trackerState.shapes,
        getEntities: () => trackerState.entities,
        getPlayers: () => trackerState.players,
        getBullets: () => trackerState.bullets,
        byType: (entityType) => trackerState.entities.filter((entity) => entity.entityType === entityType),
        getZoom: () => trackerState.zoom,
        getWasmInfo: () => ({
          hasInstance: !!wasmState.instance,
          exportKeys: wasmState.exports ? Object.keys(wasmState.exports) : [],
          zoomProbe: wasmState.zoomProbe ? { kind: wasmState.zoomProbe.kind, name: wasmState.zoomProbe.name } : null,
        }),
        enable: () => {
          trackerState.enabled = true;
        },
        disable: () => {
          trackerState.enabled = false;
        },
        clear: () => {
          frameShapes.length = 0;
          trackerState.entities = [];
          trackerState.shapes = [];
          trackerState.players = [];
          trackerState.bullets = [];
          trackerState.labels = [];
          trackerState.counts = updateCounts([]);
          frameTransformEvents.length = 0;
          trackerState.zoom = { current: 1, samples: [], fallbackSamples: [], method: 'setTransform-dominant-scale', sourceScale: null, baseScale: BACKGROUND_RECT_BASE_SCALE };
        },
      };
    };

    const script = document.createElement('script');
    script.textContent = `;(${trackerBootstrap.toString()})();`;
    document.documentElement.appendChild(script);
    script.remove();
  };

  inject();
})();
