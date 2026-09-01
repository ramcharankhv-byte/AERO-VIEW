import type { UseType } from '@/lib/types';

/**
 * Window-grid textures for the architectural model.
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
 * lines up with the floor bands drawn by the BuildingModelLayer.
 */

const PX_PER_M = 24;
const cache = new Map<string, HTMLCanvasElement>();

export function windowGrid(
  use: UseType,
  tileWidthM = 4,
  tileHeightM = 3.2,
): HTMLCanvasElement {
  const key = `${use}:${tileWidthM}:${tileHeightM}`;
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

  cache.set(key, canvas);
  return canvas;
}

// --- per-use-type drawers ----------------------------------------------------

function drawResidential(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  tileWM: number, tileHM: number,
) {
  // Warm off-white wall.
  ctx.fillStyle = '#d8cdb8';
  ctx.fillRect(0, 0, w, h);

  // One window per tile, centred, smaller than the tile so mullions show.
  const winW = Math.round(tileWM * 0.55 * PX_PER_M);
  const winH = Math.round(tileHM * 0.62 * PX_PER_M);
  const x0 = Math.round((w - winW) / 2);
  const y0 = Math.round((h - winH) / 2);

  // Window pane.
  ctx.fillStyle = '#1c2a3a';
  ctx.fillRect(x0, y0, winW, winH);
  // Reflection sheen.
  ctx.fillStyle = 'rgba(180,200,220,0.18)';
  ctx.fillRect(x0, y0, Math.max(2, winW * 0.18), winH);

  // White frame + central mullion cross.
  ctx.strokeStyle = '#f4ecdc';
  ctx.lineWidth = Math.max(1, Math.round(PX_PER_M * 0.06));
  ctx.strokeRect(x0, y0, winW, winH);
  ctx.beginPath();
  ctx.moveTo(x0 + winW / 2, y0);
  ctx.lineTo(x0 + winW / 2, y0 + winH);
  ctx.moveTo(x0, y0 + winH / 2);
  ctx.lineTo(x0 + winW, y0 + winH / 2);
  ctx.stroke();
}

function drawCommercial(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  tileWM: number, tileHM: number,
) {
  // Cool curtain wall.
  ctx.fillStyle = '#a9b6c2';
  ctx.fillRect(0, 0, w, h);

  // Two stacked panels per storey height, so the wall reads as glazing.
  const panelH = Math.round(h * 0.42);
  const inset = Math.round(tileWM * 0.08 * PX_PER_M);

  for (let i = 0; i < 2; i++) {
    const y = i * (h / 2) + Math.round((h / 2 - panelH) / 2);
    // Glass.
    ctx.fillStyle = '#2b3a4a';
    ctx.fillRect(inset, y, w - 2 * inset, panelH);
    // Reflection gradient.
    const grad = ctx.createLinearGradient(0, y, 0, y + panelH);
    grad.addColorStop(0, 'rgba(170,200,220,0.32)');
    grad.addColorStop(1, 'rgba(170,200,220,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(inset, y, w - 2 * inset, panelH);
    // Mullion frame.
    ctx.strokeStyle = '#cfd6df';
    ctx.lineWidth = Math.max(1, Math.round(PX_PER_M * 0.07));
    ctx.strokeRect(inset, y, w - 2 * inset, panelH);
  }
}

function drawInstitutional(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  _tileWM: number, _tileHM: number,
) {
  // Sandstone wall.
  ctx.fillStyle = '#d6c9a8';
  ctx.fillRect(0, 0, w, h);

  // Tall arched window.
  const winW = Math.round(w * 0.45);
  const winH = Math.round(h * 0.78);
  const x0 = Math.round((w - winW) / 2);
  const y0 = Math.round((h - winH) / 2);
  const archH = Math.round(winW * 0.5);

  ctx.fillStyle = '#22303e';
  ctx.beginPath();
  ctx.moveTo(x0, y0 + archH);
  ctx.arc(x0 + winW / 2, y0 + archH, winW / 2, Math.PI, 0);
  ctx.lineTo(x0 + winW, y0 + archH);
  ctx.lineTo(x0 + winW, y0 + winH);
  ctx.lineTo(x0, y0 + winH);
  ctx.closePath();
  ctx.fill();

  // Stone frame.
  ctx.strokeStyle = '#eee3c8';
  ctx.lineWidth = Math.max(1, Math.round(PX_PER_M * 0.09));
  ctx.strokeRect(x0, y0, winW, winH);
  // Mullion.
  ctx.beginPath();
  ctx.moveTo(x0 + winW / 2, y0);
  ctx.lineTo(x0 + winW / 2, y0 + winH);
  ctx.stroke();
}

function drawIndustrial(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  _tileWM: number, _tileHM: number,
) {
  // Corrugated metal.
  ctx.fillStyle = '#9aa1ab';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#7f8690';
  const ribW = Math.max(2, Math.round(PX_PER_M * 0.18));
  for (let x = 0; x < w; x += ribW * 2) {
    ctx.fillRect(x, 0, ribW, h);
  }
}
