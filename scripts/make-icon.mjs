/**
 * Generates media/icon.png — the 128x128 Marketplace icon (§15).
 *
 * Written as a generator rather than a committed binary so the icon is
 * reviewable in a diff and regenerable. Draws a counter-clockwise revert arrow
 * (the Reject gesture) over a rounded dark tile, supersampled 4x for smooth
 * edges. Raw PNG encoding via zlib keeps this dependency-free.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SIZE = 128;
const SS = 4; // supersampling factor
const N = SIZE * SS;

const BG = [0x1c, 0x21, 0x2b];
const ARROW = [0x4e, 0xc9, 0xb0];
const ACCENT = [0xe0, 0x6c, 0x75];

const canvas = new Float64Array(N * N * 4);

function blend(x, y, rgb, alpha) {
  if (x < 0 || y < 0 || x >= N || y >= N || alpha <= 0) return;
  const i = (y * N + x) * 4;
  const a = Math.min(1, alpha);
  canvas[i] = canvas[i] * (1 - a) + rgb[0] * a;
  canvas[i + 1] = canvas[i + 1] * (1 - a) + rgb[1] * a;
  canvas[i + 2] = canvas[i + 2] * (1 - a) + rgb[2] * a;
  canvas[i + 3] = Math.min(255, canvas[i + 3] * (1 - a) + 255 * a);
}

/** Rounded-square background covering the whole tile. */
function roundedRect(radius, rgb) {
  const r = radius * SS;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = Math.max(r - x, x - (N - 1 - r), 0);
      const dy = Math.max(r - y, y - (N - 1 - r), 0);
      if (Math.hypot(dx, dy) <= r) blend(x, y, rgb, 1);
    }
  }
}

/** Arc from startDeg to endDeg, measured counter-clockwise from east. */
function arc(cx, cy, radius, thickness, startDeg, endDeg, rgb) {
  const c = { x: cx * SS, y: cy * SS };
  const rOuter = (radius + thickness / 2) * SS;
  const rInner = (radius - thickness / 2) * SS;
  const start = (startDeg * Math.PI) / 180;
  const end = (endDeg * Math.PI) / 180;

  for (let y = Math.floor(c.y - rOuter); y <= Math.ceil(c.y + rOuter); y++) {
    for (let x = Math.floor(c.x - rOuter); x <= Math.ceil(c.x + rOuter); x++) {
      const dx = x - c.x;
      const dy = c.y - y; // screen y grows downward
      const dist = Math.hypot(dx, dy);
      if (dist > rOuter || dist < rInner) continue;
      let angle = Math.atan2(dy, dx);
      if (angle < 0) angle += Math.PI * 2;
      let a = angle;
      if (a < start) a += Math.PI * 2;
      if (a > end) continue;
      blend(x, y, rgb, 1);
    }
  }
}

/** Solid triangle from three points in icon-space coordinates. */
function triangle(p1, p2, p3, rgb) {
  const pts = [p1, p2, p3].map((p) => ({ x: p[0] * SS, y: p[1] * SS }));
  const minX = Math.floor(Math.min(...pts.map((p) => p.x)));
  const maxX = Math.ceil(Math.max(...pts.map((p) => p.x)));
  const minY = Math.floor(Math.min(...pts.map((p) => p.y)));
  const maxY = Math.ceil(Math.max(...pts.map((p) => p.y)));
  const sign = (a, b, c) => (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y);

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const p = { x: x + 0.5, y: y + 0.5 };
      const d1 = sign(p, pts[0], pts[1]);
      const d2 = sign(p, pts[1], pts[2]);
      const d3 = sign(p, pts[2], pts[0]);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(hasNeg && hasPos)) blend(x, y, rgb, 1);
    }
  }
}

/**
 * Arrowhead sitting on the circle at `angleDeg`, pointing along the tangent in
 * the direction of increasing angle (counter-clockwise). Computing it from the
 * tangent rather than hand-placing it is what keeps the head attached to the
 * arc when any of the geometry above is tweaked.
 */
function arrowHead(cx, cy, radius, angleDeg, size, rgb) {
  const t = (angleDeg * Math.PI) / 180;
  // Screen space: y grows downward, so the radial and tangent vectors below
  // both carry a negated y component.
  const pos = { x: cx + radius * Math.cos(t), y: cy - radius * Math.sin(t) };
  const tangent = { x: -Math.sin(t), y: -Math.cos(t) };
  const normal = { x: Math.cos(t), y: -Math.sin(t) };

  const tip = [pos.x + tangent.x * size, pos.y + tangent.y * size];
  const back = { x: pos.x - tangent.x * size * 0.35, y: pos.y - tangent.y * size * 0.35 };
  const left = [back.x + normal.x * size * 0.85, back.y + normal.y * size * 0.85];
  const right = [back.x - normal.x * size * 0.85, back.y - normal.y * size * 0.85];

  triangle(tip, left, right, rgb);
}

function circle(cx, cy, radius, rgb) {
  const c = { x: cx * SS, y: cy * SS };
  const r = radius * SS;
  for (let y = Math.floor(c.y - r); y <= Math.ceil(c.y + r); y++) {
    for (let x = Math.floor(c.x - r); x <= Math.ceil(c.x + r); x++) {
      if (Math.hypot(x - c.x, y - c.y) <= r) blend(x, y, rgb, 1);
    }
  }
}

// --- compose -----------------------------------------------------------------

roundedRect(24, BG);

// The revert loop, open between 100° and 140° so the head has somewhere to sit.
const CX = 64;
const CY = 64;
const R = 36;
arc(CX, CY, R, 10, 140, 460, ARROW);

// Head at the open end, pointing counter-clockwise: the Reject gesture.
arrowHead(CX, CY, R, 100, 15, ARROW);

// Three dots in a row: the pending files the loop takes back.
circle(CX - 16, CY + 2, 5, ACCENT);
circle(CX, CY + 2, 5, ACCENT);
circle(CX + 16, CY + 2, 5, ACCENT);

// --- downsample and encode ---------------------------------------------------

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * N + (x * SS + sx)) * 4;
        r += canvas[i];
        g += canvas[i + 1];
        b += canvas[i + 2];
        a += canvas[i + 3];
      }
    }
    const n = SS * SS;
    const o = (y * SIZE + x) * 4;
    pixels[o] = Math.round(r / n);
    pixels[o + 1] = Math.round(g / n);
    pixels[o + 2] = Math.round(b / n);
    pixels[o + 3] = Math.round(a / n);
  }
}

// PNG scanlines are prefixed with a filter byte; 0 means "none".
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync('media', { recursive: true });
writeFileSync('media/icon.png', png);
console.log(
  `Wrote media/icon.png (${SIZE}x${SIZE}, ${png.length} bytes, sha256 ${createHash('sha256')
    .update(png)
    .digest('hex')
    .slice(0, 12)})`,
);
