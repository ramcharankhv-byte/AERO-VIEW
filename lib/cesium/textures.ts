import type { UseType } from '@/lib/types';

/**
 * Facade textures for the architectural model.
 *
 * Drawn once per (useType, tile size) into a module-level cache so that
 * selecting a different building of the same use type does not redraw the
 * canvas -- the same ImageMaterialProperty is reused.
 *
 * `tileW` / `tileH` are in real-world metres. The canvas is sized so 1 m on
 * the wall = 24 px, which keeps the windows sharp on a 4K monitor without
 * exhausting texture memory at city scale.
 *
 * Defaults: 4 m × 3.2 m. The 3.2 m height is the floor-to-floor dimension
 * used by build_geometry.sql, so one tile = one storey and the window grid
 * lines up with the floor bands drawn by the BuildingModelLayer. Ground-floor
 * tiles (`groundFloor: true`) overlay an entry door on the same grid.
 *
 * CONTRAST DISCIPLINE: every drawer keeps its darkest pane well above black
 * and its wall tone close to the material it imitates. The caller repeats the
 * tile around the whole perimeter, so a high-contrast tile would strobe into
 * vertical stripes exactly like the ones this drawing replaced. Details are
 * carried by shading (sills, coursing, spandrels), not by tonal extremes.
 *
 * VERTICAL-JOINT RULE: with metric tiling (repeat = perimeter / bay width)
 * any vertical line drawn INSIDE the tile repeats once per bay and strobes at
 * city distance -- the stripes in the bug report. Vertical joints therefore
 * live only at the bay boundary (x = 0 / x = w), where one per bay is the
 * correct rhythm. Horizontal elements (sills, spandrels, rails) are free.
 */

const PX_PER_M = 24;
const cache = new Map<string, HTMLCanvasElement>();

export function windowGrid(
  use: UseType,
  tileWidthM = 4,
  tileHeightM = 3.2,
  groundFloor = false,
): HTMLCanvasElement {
  const key = `${use}:${tileWidthM}:${tileHeightM}:${groundFloor ? 'g' : 'u'}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const w = Math.max(1, Math.round(tileWidthM * PX_PER_M));
  const h = Math.max(1, Math.round(tileHeightM * PX_PER_M));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  switch (use) {
    case 'residential':
      drawResidential(ctx, w, h, tileWidthM, tileHeightM);
      break;
    case 'commercial':
      drawCommercial(ctx, w, h, tileWidthM, tileHeightM);
      break;
    case 'institutional':
      drawInstitutional(ctx, w, h, tileWidthM, tileHeightM);
      break;
    case 'industrial':
      drawIndustrial(ctx, w, h, tileWidthM, tileHeightM);
      break;
  }

  // Ground floor: overlay an entry door over the window drawer's bay, so
  // every building reads as having a real entrance at street level.
  if (groundFloor) {
    drawEntryDoor(ctx, w, h, use);
  }

  // Shared ambient grounding: a faint darkening toward the slab line and a
  // hairline highlight under the one above. Reads as depth from any angle and
  // costs four rects.
  const ao = ctx.createLinearGradient(0, h * 0.78, 0, h);
  ao.addColorStop(0, 'rgba(0,0,0,0)');
  ao.addColorStop(1, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = ao;
  ctx.fillRect(0, Math.round(h * 0.78), w, h - Math.round(h * 0.78));
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(0, 0, w, Math.max(1, Math.round(PX_PER_M * 0.08)));

  cache.set(key, canvas);
  return canvas;
}

/**
 * Ground hatch for surface parcels: a 45° plot hatch rotated to the parcel's
 * long axis, at very low alpha. Gives the flat map a drawn-cadastre texture
 * that survives both the dark treatment and Esri imagery underneath, without
 * competing with the building fills on top of it.
 *
 * Keyed by parcel id so each parcel keeps its own rotation; the canvas is
 * tiny (64 px) and repeated across the polygon by Cesium's default 1:1 UV.
 */
const hatchCache = new Map<number, HTMLCanvasElement>();

export function plotHatch(parcelId: number, longAxisDeg: number): HTMLCanvasElement {
  const cached = hatchCache.get(parcelId);
  if (cached) return cached;

  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // Transparent base -- the parcel tint underneath stays visible.
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(140, 220, 180, 0.13)';
  ctx.lineWidth = 2;
  const pitch = 12;
  ctx.save();
  ctx.translate(size / 2, size / 2);
  // Align the hatch with the plot's principal axis for a surveyed look.
  ctx.rotate((longAxisDeg * Math.PI) / 180);
  for (let d = -size; d < size; d += pitch) {
    ctx.beginPath();
    ctx.moveTo(d, -size);
    ctx.lineTo(d, size);
    ctx.stroke();
  }
  ctx.restore();

  hatchCache.set(parcelId, canvas);
  return canvas;
}

/** Faint speckle so flat walls read as material rather than solid fill. */
function grain(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  strength: number,
) {
  const step = Math.max(2, Math.round(PX_PER_M * 0.25));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const v = (Math.random() - 0.5) * strength;
      if (Math.abs(v) < 0.015) continue;
      ctx.fillStyle = v > 0
        ? `rgba(255,255,255,${v.toFixed(3)})`
        : `rgba(0,0,0,${(-v).toFixed(3)})`;
      ctx.fillRect(x, y, step, step);
    }
  }
}

// --- per-use-type drawers ----------------------------------------------------

function drawResidential(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  tileWM: number, tileHM: number,
) {
  // Warm plaster wall.
  ctx.fillStyle = '#d3c9b6';
  ctx.fillRect(0, 0, w, h);
  grain(ctx, w, h, 0.10);

  // One window per bay, sitting on a visible sill with a lintel above --
  // the shading around the reveal is what reads as "window" at distance,
  // not the pane colour.
  const winW = Math.round(tileWM * 0.5 * PX_PER_M);
  const winH = Math.round(tileHM * 0.52 * PX_PER_M);
  const x0 = Math.round((w - winW) / 2);
  const y0 = Math.round(h * 0.2);

  // Reveal shadow (right + bottom inside the opening).
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(x0 - 2, y0 - 2, winW + 4, winH + 4);
  // Pane.
  ctx.fillStyle = '#33424f';
  ctx.fillRect(x0, y0, winW, winH);
  // Diagonal sky reflection, low alpha so it never strobes.
  const sheen = ctx.createLinearGradient(x0, y0, x0 + winW, y0 + winH);
  sheen.addColorStop(0, 'rgba(190,210,225,0.20)');
  sheen.addColorStop(0.5, 'rgba(190,210,225,0.04)');
  sheen.addColorStop(1, 'rgba(190,210,225,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(x0, y0, winW, winH);
  // Frame + mullion.
  ctx.strokeStyle = '#e9e0cd';
  ctx.lineWidth = Math.max(1, Math.round(PX_PER_M * 0.07));
  ctx.strokeRect(x0, y0, winW, winH);
  ctx.beginPath();
  ctx.moveTo(x0 + winW / 2, y0);
  ctx.lineTo(x0 + winW / 2, y0 + winH);
  ctx.stroke();

  // Lintel and sill.
  ctx.fillStyle = '#e4dac6';
  ctx.fillRect(x0 - 3, y0 - Math.round(PX_PER_M * 0.22), winW + 6, Math.max(1, Math.round(PX_PER_M * 0.14)));
  ctx.fillStyle = '#c9bda6';
  ctx.fillRect(x0 - 4, y0 + winH + 2, winW + 8, Math.max(1, Math.round(PX_PER_M * 0.16)));
  // Sill shadow underneath.
  ctx.fillStyle = 'rgba(0,0,0,0.14)';
  ctx.fillRect(x0 - 4, y0 + winH + 2 + Math.max(1, Math.round(PX_PER_M * 0.16)), winW + 8, 2);

  // Faint balcony rail hint across the lower third (Indian residential bays
  // usually have one; at this scale a rail reads as two light lines).
  const railY = Math.round(h * 0.74);
  ctx.fillStyle = 'rgba(250,246,236,0.5)';
  ctx.fillRect(0, railY, w, Math.max(1, Math.round(PX_PER_M * 0.08)));
  ctx.fillRect(0, railY + Math.round(PX_PER_M * 0.35), w, Math.max(1, Math.round(PX_PER_M * 0.08)));
}

function drawCommercial(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  tileWM: number, _tileHM: number,
) {
  // Curtain wall: vision glass above, spandrel covering the slab below.
  const spandrelH = Math.round(h * 0.3);

  // Vision glass.
  const glass = ctx.createLinearGradient(0, 0, w * 0.4, h);
  glass.addColorStop(0, '#41556a');
  glass.addColorStop(0.45, '#33445a');
  glass.addColorStop(1, '#2a3849');
  ctx.fillStyle = glass;
  ctx.fillRect(0, 0, w, h - spandrelH);

  // Spandrel (opaque band hiding the slab).
  ctx.fillStyle = '#57616c';
  ctx.fillRect(0, h - spandrelH, w, spandrelH);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(0, h - spandrelH, w, 2);

  // Mullions only at the bay edges (see the vertical-joint rule above): the
  // old interior mullion every 1.2 m repeated once per bay under metric
  // tiling and stretched into the vertical stripes on misaligned walls. One
  // tile = one curtain-wall bay.
  const mullion = 'rgba(203,212,220,0.55)';
  const mw = Math.max(1, Math.round(PX_PER_M * 0.06));
  ctx.fillStyle = mullion;
  ctx.fillRect(0, 0, mw, h - spandrelH);
  ctx.fillRect(w - mw, 0, mw, h - spandrelH);
  ctx.fillRect(0, h - spandrelH - mw, w, mw);
}

function drawInstitutional(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  _tileWM: number, _tileHM: number,
) {
  // Sandstone with coursing.
  ctx.fillStyle = '#d7cbae';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(90,78,58,0.08)';
  const course = Math.round(PX_PER_M * 0.4);
  for (let y = course; y < h; y += course) {
    ctx.fillRect(0, y, w, 1);
  }
  // Quoin/pilaster shading at the bay edges only (x = 0 / x = w) -- one per
  // bay under metric tiling, per the vertical-joint rule.
  ctx.fillStyle = 'rgba(90,78,58,0.10)';
  ctx.fillRect(0, 0, Math.round(PX_PER_M * 0.18), h);
  ctx.fillRect(w - Math.round(PX_PER_M * 0.18), 0, Math.round(PX_PER_M * 0.18), h);
  grain(ctx, w, h, 0.07);

  // Tall arched window.
  const winW = Math.round(w * 0.46);
  const winH = Math.round(h * 0.66);
  const x0 = Math.round((w - winW) / 2);
  const y0 = Math.round(h * 0.14);
  const archH = Math.round(winW * 0.5);

  // Reveal shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.20)';
  ctx.fillRect(x0 - 2, y0 - 2, winW + 4, winH + 4);
  ctx.fillStyle = '#2c3947';
  ctx.beginPath();
  ctx.moveTo(x0, y0 + archH);
  ctx.arc(x0 + winW / 2, y0 + archH, winW / 2, Math.PI, 0);
  ctx.lineTo(x0 + winW, y0 + winH);
  ctx.lineTo(x0, y0 + winH);
  ctx.closePath();
  ctx.fill();
  // Sheen.
  ctx.fillStyle = 'rgba(190,210,225,0.10)';
  ctx.fill();

  // Stone frame + mullion.
  ctx.strokeStyle = '#eadfc4';
  ctx.lineWidth = Math.max(1, Math.round(PX_PER_M * 0.09));
  ctx.strokeRect(x0, y0, winW, winH);
  ctx.beginPath();
  ctx.moveTo(x0 + winW / 2, y0);
  ctx.lineTo(x0 + winW / 2, y0 + winH);
  ctx.stroke();

  // Sill.
  ctx.fillStyle = '#c6b99c';
  ctx.fillRect(x0 - 4, y0 + winH + 2, winW + 8, Math.max(1, Math.round(PX_PER_M * 0.16)));
}

function drawIndustrial(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  tileWM: number, _tileHM: number,
) {
  // Coated metal cladding. Flat tone + grain: the drawn-in 0.6 m ribs
  // repeated once per bay under metric tiling and were the main source of
  // the vertical stripes in the bug report, so they are gone.
  ctx.fillStyle = '#a3aab3';
  ctx.fillRect(0, 0, w, h);
  grain(ctx, w, h, 0.06);

  // Clerestory ribbon across the top third -- factory windows run in bands.
  const bandH = Math.round(h * 0.26);
  const bandY = Math.round(h * 0.14);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(0, bandY - 2, w, bandH + 4);
  ctx.fillStyle = '#39485a';
  ctx.fillRect(0, bandY, w, bandH);
  ctx.fillStyle = 'rgba(190,210,225,0.12)';
  ctx.fillRect(0, bandY, w, Math.max(1, Math.round(bandH * 0.3)));
  // Ribbon mullions, wide pitch and faint (see the vertical-joint rule).
  ctx.fillStyle = 'rgba(200,208,216,0.35)';
  const pitch = Math.max(6, Math.round(PX_PER_M * 2));
  for (let x = 0; x < w; x += pitch) {
    ctx.fillRect(x, bandY, 1, bandH);
  }
  // Band frame.
  ctx.strokeStyle = 'rgba(225,230,235,0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0, bandY, w, bandH);
}

/**
 * Entry door overlay for ground-floor tiles.
 *
 * Painted OVER the per-use drawer's window: the bay's wall tone is restored
 * around the opening (one use type keeps its glass as a shopfront gate), then
 * a full-height recessed door panel is drawn reaching down to the floor line
 * with a lintel, threshold and handle. One door per tile = one door per bay,
 * which at model scale reads as the entrance rhythm of a row of plots.
 */
function drawEntryDoor(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  use: UseType,
) {
  // Door opening geometry: full-height-ish, centred in the bay.
  const doorW = Math.round(w * 0.42);
  const doorH = Math.round(h * 0.76);
  const x0 = Math.round((w - doorW) / 2);
  const y0 = h - doorH; // reaches the floor line

  // Restore the bay's wall tone behind the opening so the window underneath
  // doesn't ghost through around the frame. Commercial keeps its curtain
  // glass -- there the "door" is a glazed shopfront gate.
  if (use !== 'commercial') {
    const wall: Record<string, string> = {
      residential: '#d3c9b6',
      institutional: '#d7cbae',
      industrial: '#a3aab3',
    };
    ctx.fillStyle = wall[use] ?? '#d3c9b6';
    ctx.fillRect(0, 0, w, h);
  }

  // Reveal shadow around the opening.
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(x0 - 2, y0 - 2, doorW + 4, doorH + 4);

  // Door panel: dark recessed leaf with a faint vertical sheen.
  const leaf = ctx.createLinearGradient(x0, y0, x0 + doorW, y0 + doorH);
  leaf.addColorStop(0, '#454b53');
  leaf.addColorStop(0.5, '#3a3f46');
  leaf.addColorStop(1, '#31363c');
  ctx.fillStyle = leaf;
  ctx.fillRect(x0, y0, doorW, doorH);
  // Panel inset (two recessed rectangles read as a flush double leaf).
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = Math.max(1, Math.round(PX_PER_M * 0.05));
  const inset = Math.round(doorW * 0.14);
  ctx.strokeRect(x0 + inset, y0 + Math.round(doorH * 0.08),
    doorW - inset * 2, Math.round(doorH * 0.34));
  ctx.strokeRect(x0 + inset, y0 + Math.round(doorH * 0.5),
    doorW - inset * 2, Math.round(doorH * 0.38));

  // Frame + lintel.
  ctx.strokeStyle = '#e9e0cd';
  ctx.lineWidth = Math.max(1, Math.round(PX_PER_M * 0.09));
  ctx.strokeRect(x0, y0, doorW, doorH);
  ctx.fillStyle = '#e4dac6';
  ctx.fillRect(x0 - 3, y0 - Math.round(PX_PER_M * 0.28), doorW + 6,
    Math.max(1, Math.round(PX_PER_M * 0.16)));

  // Threshold step.
  ctx.fillStyle = '#c9bda6';
  ctx.fillRect(x0 - 4, h - Math.max(2, Math.round(PX_PER_M * 0.14)), doorW + 8,
    Math.max(2, Math.round(PX_PER_M * 0.14)));

  // Handle: a small bright vertical bar on the leaf's right side.
  ctx.fillStyle = 'rgba(222,226,230,0.85)';
  ctx.fillRect(x0 + doorW - Math.round(doorW * 0.16), y0 + Math.round(doorH * 0.42),
    Math.max(1, Math.round(PX_PER_M * 0.07)), Math.round(doorH * 0.14));
}
