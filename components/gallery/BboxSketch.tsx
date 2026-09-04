import type { Project } from '@/lib/types';

/**
 * The AOI, drawn as itself.
 *
 * A plain inline SVG: no MapLibre, no tile fetch, no new dependency. The card
 * is a directory entry, not a map, and the one thing a directory entry has to
 * convey about an AOI is its shape and its size -- a wide arterial strip and a
 * square ward are different jobs, and that difference survives at 120px while
 * a basemap thumbnail at that size is just grey mush.
 *
 * Everything here is currentColor, so the sketch inherits the card's ink and
 * introduces no hue of its own. The graticule is a fixed 4x4 division of the
 * bbox rather than a real coordinate grid; it exists to give the rectangle a
 * sense of scale, and it is drawn faintly enough to read as texture.
 */
export default function BboxSketch({ project }: { project: Project }) {
  const [west, south, east, north] = project.bbox;

  // Metres per degree at this latitude, so the drawn rectangle carries the
  // AOI's real aspect ratio rather than its ratio in degrees -- at 17.7 N a
  // square in degrees is noticeably wider than it is tall on the ground.
  const midLat = (south + north) / 2;
  const wM = Math.abs(east - west) * 111320 * Math.cos((midLat * Math.PI) / 180);
  const hM = Math.abs(north - south) * 110574;

  // Fit inside a 100x64 box, keeping the aspect ratio and leaving a margin.
  const BOX_W = 100;
  const BOX_H = 64;
  const PAD = 6;
  const scale = Math.min((BOX_W - PAD * 2) / Math.max(wM, 1), (BOX_H - PAD * 2) / Math.max(hM, 1));
  const w = Math.max(4, wM * scale);
  const h = Math.max(4, hM * scale);
  const x = (BOX_W - w) / 2;
  const y = (BOX_H - h) / 2;

  const divisions = [1, 2, 3];

  return (
    <svg
      viewBox={`0 0 ${BOX_W} ${BOX_H}`}
      className="h-16 w-full text-[rgb(var(--muted))]"
      role="img"
      aria-label={
        `Area of interest: ${(wM / 1000).toFixed(2)} by ${(hM / 1000).toFixed(2)} `
        + `kilometres, west ${west.toFixed(4)}, south ${south.toFixed(4)}, `
        + `east ${east.toFixed(4)}, north ${north.toFixed(4)}`
      }
    >
      {divisions.map((d) => (
        <line
          key={`v${d}`}
          x1={x + (w * d) / 4} y1={y} x2={x + (w * d) / 4} y2={y + h}
          stroke="currentColor" strokeWidth={0.4} opacity={0.28}
        />
      ))}
      {divisions.map((d) => (
        <line
          key={`h${d}`}
          x1={x} y1={y + (h * d) / 4} x2={x + w} y2={y + (h * d) / 4}
          stroke="currentColor" strokeWidth={0.4} opacity={0.28}
        />
      ))}
      <rect
        x={x} y={y} width={w} height={h}
        fill="currentColor" fillOpacity={0.06}
        stroke="currentColor" strokeWidth={1}
      />
      {/* Corner ticks, so the extent reads as a surveyed extent rather than
          as a decorative box. */}
      {[[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r={1.1} fill="currentColor" />
      ))}
    </svg>
  );
}

/** "1.22 × 1.11 km", the same phrasing the StatusBar uses. */
export function bboxExtentLabel(project: Project): string {
  const [west, south, east, north] = project.bbox;
  const midLat = (south + north) / 2;
  const wKm = (Math.abs(east - west) * 111320 * Math.cos((midLat * Math.PI) / 180)) / 1000;
  const hKm = (Math.abs(north - south) * 110574) / 1000;
  return `${wKm.toFixed(2)} × ${hKm.toFixed(2)} km`;
}
