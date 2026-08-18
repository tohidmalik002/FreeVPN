// Dependency-free shield-icon generator. Draws a coloured shield to an RGBA
// buffer (4x supersampled for smooth edges) and encodes it as PNG using only
// Node's zlib. Kept free of any electron import so plain build scripts can use it.
import * as zlib from 'zlib';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode a raw RGBA buffer (w*h*4) as a PNG. */
export function pngFromRGBA(rgba: Buffer, w: number, h: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Shield membership test in normalised coords (x,y in [-1,1], y down). */
function inShield(nx: number, ny: number): boolean {
  const topY = -0.86;
  const shoulderY = 0.2;
  const tipY = 0.92;
  const halfW = 0.72;
  if (ny < topY || ny > tipY) return false;
  let hw: number;
  if (ny <= shoulderY) {
    hw = halfW;
    const cornerR = 0.3;
    if (ny < topY + cornerR) {
      const dy = topY + cornerR - ny;
      hw = Math.min(hw, halfW - cornerR + Math.sqrt(Math.max(0, cornerR * cornerR - dy * dy)));
    }
  } else {
    const t = (ny - shoulderY) / (tipY - shoulderY);
    hw = halfW * (1 - t * t * 0.55 - t * 0.45);
  }
  return Math.abs(nx) <= hw;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** A filled shield PNG in the given hex colour, `size`x`size` px. */
export function shieldPng(hex: string, size: number): Buffer {
  const ss = 4; // supersample factor
  const S = size * ss;
  const [r, g, b] = hexToRgb(hex);
  const [cr, cg, cb] = [255, 255, 255]; // check-mark colour

  // supersampled coverage
  const cover = new Float32Array(size * size);
  const isCheck = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = 0;
      let check = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x * ss + sx;
          const py = y * ss + sy;
          const nx = (px / (S - 1)) * 2 - 1;
          const ny = (py / (S - 1)) * 2 - 1;
          if (inShield(nx, ny)) {
            inside++;
            // a simple check-mark stroke inside the shield
            if (checkMark(nx, ny)) check++;
          }
        }
      }
      const n = ss * ss;
      cover[y * size + x] = inside / n;
      isCheck[y * size + x] = check / n;
    }
  }

  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = cover[i];
    const c = isCheck[i];
    const rr = Math.round(r * (1 - c) + cr * c);
    const gg = Math.round(g * (1 - c) + cg * c);
    const bb = Math.round(b * (1 - c) + cb * c);
    rgba[i * 4] = rr;
    rgba[i * 4 + 1] = gg;
    rgba[i * 4 + 2] = bb;
    rgba[i * 4 + 3] = Math.round(a * 255);
  }
  return pngFromRGBA(rgba, size, size);
}

/** Thick check-mark stroke in normalised coords. */
function checkMark(nx: number, ny: number): boolean {
  // two segments: (-0.35,0.02)->(-0.08,0.32) and (-0.08,0.32)->(0.42,-0.34)
  const w = 0.11;
  return (
    distToSeg(nx, ny, -0.35, 0.02, -0.08, 0.32) < w ||
    distToSeg(nx, ny, -0.08, 0.32, 0.42, -0.34) < w
  );
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Wrap a 256px shield PNG into a single-image .ico container (PNG-in-ICO). */
export function shieldIco(hex: string): Buffer {
  const png = shieldPng(hex, 256);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256
  entry[1] = 0; // height 256
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset (6 + 16)
  return Buffer.concat([header, entry, png]);
}
