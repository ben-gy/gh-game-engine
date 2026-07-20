/**
 * qr.ts — a self-contained QR encoder, so a player can point a phone at a
 * screen and land straight in the room.
 *
 * No dependency and no image service. A hosted QR endpoint would put the invite
 * link — which identifies the room — through someone else's server on every
 * lobby render, which breaks the no-tracking promise the whole catalogue makes.
 * Everything here is pure computation; `toSvg` emits inline SVG, so it is also
 * safe under a `default-src 'self'` CSP and stays crisp at any size.
 *
 * Byte mode only (URLs are byte data), versions 1–10, all four ECC levels.
 * Version 10 at level M holds 213 bytes — roughly four times the longest invite
 * link the factory produces — so the ceiling is never the binding constraint.
 *
 * Correctness is not assumed: tests/qr.test.ts round-trips every output through
 * an independent decoder (`jsqr`, a dev dependency that never ships), because a
 * QR that renders beautifully and does not scan is worse than no QR at all.
 */

export type EccLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrCode {
  /** Modules per side, including the quiet zone? No — excludes it. */
  size: number;
  /** `true` is a dark module. Indexed `[y][x]`. */
  modules: boolean[][];
  version: number;
  ecc: EccLevel;
}

// ── Spec tables (versions 1–10) ──────────────────────────────────────
// Total codewords (data + error correction) per version.
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

// [ecCodewordsPerBlock, blockCount] per version, per level.
const ECC_TABLE: Record<EccLevel, Array<[number, number]>> = {
  L: [[0, 0], [7, 1], [10, 1], [15, 1], [20, 1], [26, 1], [18, 2], [20, 2], [24, 2], [30, 2], [18, 4]],
  M: [[0, 0], [10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4], [22, 5], [26, 5]],
  Q: [[0, 0], [13, 1], [22, 1], [18, 2], [26, 2], [18, 4], [24, 4], [18, 6], [22, 6], [20, 8], [24, 8]],
  H: [[0, 0], [17, 1], [28, 1], [22, 2], [16, 4], [22, 4], [28, 4], [26, 5], [26, 6], [24, 8], [28, 8]],
};

// Centre coordinates of the alignment patterns, per version.
const ALIGNMENT: number[][] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };
const MAX_VERSION = 10;

// ── GF(256) ──────────────────────────────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/** Coefficients of the generator polynomial, highest power first, monic. */
function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

// ── Encoding ─────────────────────────────────────────────────────────

/** Data codewords available at a version/level, after ECC is reserved. */
function dataCapacity(version: number, ecc: EccLevel): number {
  const [ecPerBlock, blocks] = ECC_TABLE[ecc][version];
  return TOTAL_CODEWORDS[version] - ecPerBlock * blocks;
}

/** Byte-mode overhead: 4-bit mode + 8-bit length (versions 1–9) or 16-bit. */
function headerBits(version: number): number {
  return 4 + (version <= 9 ? 8 : 16);
}

function smallestVersion(byteLength: number, ecc: EccLevel): number | null {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const bits = headerBits(v) + byteLength * 8;
    if (bits <= dataCapacity(v, ecc) * 8) return v;
  }
  return null;
}

class BitBuffer {
  readonly bits: number[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

function buildCodewords(data: Uint8Array, version: number, ecc: EccLevel): Uint8Array {
  const capacityBits = dataCapacity(version, ecc) * 8;
  const bb = new BitBuffer();
  bb.push(0b0100, 4); // byte mode
  bb.push(data.length, version <= 9 ? 8 : 16);
  for (const byte of data) bb.push(byte, 8);

  // Terminator, then pad to a byte boundary, then the alternating pad bytes.
  bb.push(0, Math.min(4, capacityBits - bb.bits.length));
  while (bb.bits.length % 8 !== 0) bb.bits.push(0);

  const codewords = new Uint8Array(capacityBits / 8);
  for (let i = 0; i < bb.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bb.bits[i + j];
    codewords[i / 8] = byte;
  }
  for (let i = bb.bits.length / 8, pad = 0; i < codewords.length; i++, pad++) {
    codewords[i] = pad % 2 === 0 ? 0xec : 0x11;
  }
  return codewords;
}

/**
 * Split into blocks, append per-block ECC, then interleave — the spec's
 * defence against a smudge taking out one whole block.
 */
function interleave(dataCodewords: Uint8Array, version: number, ecc: EccLevel): Uint8Array {
  const [ecPerBlock, blockCount] = ECC_TABLE[ecc][version];
  const shortLen = Math.floor(dataCodewords.length / blockCount);
  const longBlocks = dataCodewords.length % blockCount;
  const divisor = rsDivisor(ecPerBlock);

  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let b = 0; b < blockCount; b++) {
    const len = shortLen + (b >= blockCount - longBlocks ? 1 : 0);
    const block = dataCodewords.subarray(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    eccBlocks.push(rsRemainder(block, divisor));
  }

  const out: number[] = [];
  const maxData = shortLen + (longBlocks > 0 ? 1 : 0);
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of eccBlocks) out.push(block[i]);
  }
  return Uint8Array.from(out);
}

// ── Module placement ─────────────────────────────────────────────────

type Grid = { modules: boolean[][]; reserved: boolean[][]; size: number };

function newGrid(size: number): Grid {
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setModule(g: Grid, x: number, y: number, dark: boolean, reserve = true): void {
  if (x < 0 || y < 0 || x >= g.size || y >= g.size) return;
  g.modules[y][x] = dark;
  if (reserve) g.reserved[y][x] = true;
}

function drawFinder(g: Grid, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setModule(g, cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(g: Grid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setModule(g, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFunctionPatterns(g: Grid, version: number): void {
  const size = g.size;
  drawFinder(g, 3, 3);
  drawFinder(g, size - 4, 3);
  drawFinder(g, 3, size - 4);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    setModule(g, i, 6, i % 2 === 0);
    setModule(g, 6, i, i % 2 === 0);
  }

  // Alignment patterns, skipping the three finder corners.
  const centres = ALIGNMENT[version];
  for (const cy of centres) {
    for (const cx of centres) {
      const nearFinder =
        (cx === 6 && cy === 6) ||
        (cx === 6 && cy === size - 7) ||
        (cx === size - 7 && cy === 6);
      if (!nearFinder) drawAlignment(g, cx, cy);
    }
  }

  setModule(g, 8, size - 8, true); // the always-dark module

  // Reserve the format areas so data placement skips them.
  for (let i = 0; i < 9; i++) {
    setModule(g, i, 8, false);
    setModule(g, 8, i, false);
  }
  for (let i = 0; i < 8; i++) {
    setModule(g, size - 1 - i, 8, false);
    setModule(g, 8, size - 1 - i, false);
  }

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      setModule(g, a, b, bit);
      setModule(g, b, a, bit);
    }
  }
}

function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return ((version << 12) | rem) >>> 0;
}

function formatBits(ecc: EccLevel, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(g: Grid, ecc: EccLevel, mask: number): void {
  const bits = formatBits(ecc, mask);
  const size = g.size;
  for (let i = 0; i <= 5; i++) setModule(g, 8, i, ((bits >>> i) & 1) === 1);
  setModule(g, 8, 7, ((bits >>> 6) & 1) === 1);
  setModule(g, 8, 8, ((bits >>> 7) & 1) === 1);
  setModule(g, 7, 8, ((bits >>> 8) & 1) === 1);
  for (let i = 9; i < 15; i++) setModule(g, 14 - i, 8, ((bits >>> i) & 1) === 1);

  for (let i = 0; i < 8; i++) setModule(g, size - 1 - i, 8, ((bits >>> i) & 1) === 1);
  for (let i = 8; i < 15; i++) setModule(g, 8, size - 15 + i, ((bits >>> i) & 1) === 1);
}

/** Zigzag placement, two columns at a time, skipping the vertical timing column. */
function drawCodewords(g: Grid, codewords: Uint8Array): void {
  const size = g.size;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the timing column is not a data column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (g.reserved[y][x]) continue;
        const byte = codewords[bitIndex >>> 3];
        g.modules[y][x] = byte !== undefined && ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
        bitIndex++;
      }
    }
  }
}

function maskAt(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
  }
}

function applyMask(g: Grid, mask: number): void {
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!g.reserved[y][x] && maskAt(mask, x, y)) g.modules[y][x] = !g.modules[y][x];
    }
  }
}

/** The spec's four penalty rules; the lowest total wins. */
function penalty(g: Grid): number {
  const { size, modules } = g;
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules in a line.
  const runScore = (line: boolean[]): number => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) total += run - 2;
        run = 1;
      }
    }
    if (run >= 5) total += run - 2;
    return total;
  };

  for (let y = 0; y < size; y++) score += runScore(modules[y]);
  for (let x = 0; x < size; x++) score += runScore(modules.map((row) => row[x]));

  // Rule 2: 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        score += 3;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules beside them.
  const pattern = [true, false, true, true, true, false, true];
  const hasAt = (line: boolean[], i: number): boolean => {
    if (i + 7 > line.length) return false;
    for (let k = 0; k < 7; k++) if (line[i + k] !== pattern[k]) return false;
    const before = line.slice(Math.max(0, i - 4), i);
    const after = line.slice(i + 7, i + 11);
    const clear = (s: boolean[]) => s.length === 4 && s.every((v) => !v);
    return clear(before) || clear(after);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (hasAt(modules[y], x)) score += 40;
      if (hasAt(modules.map((row) => row[x]), y)) score += 40;
    }
  }

  // Rule 4: deviation from an even dark/light split.
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

export interface EncodeOptions {
  /** Defaults to 'M' — the level phone cameras handle comfortably. */
  ecc?: EccLevel;
}

/**
 * Encode text as QR modules. Returns `null` when the text cannot fit at this
 * ECC level within version 10, so callers degrade instead of throwing — the
 * invite link is always still on screen.
 */
export function encodeQr(text: string, options: EncodeOptions = {}): QrCode | null {
  const ecc = options.ecc ?? 'M';
  const data = new TextEncoder().encode(text);
  const version = smallestVersion(data.length, ecc);
  if (version === null) return null;

  const codewords = interleave(buildCodewords(data, version, ecc), version, ecc);
  const size = version * 4 + 17;

  let best: Grid | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = newGrid(size);
    drawFunctionPatterns(g, version);
    drawCodewords(g, codewords);
    drawFormat(g, ecc, mask);
    applyMask(g, mask);
    const score = penalty(g);
    if (score < bestScore) {
      bestScore = score;
      best = g;
    }
  }

  return { size, modules: best!.modules, version, ecc };
}

export interface SvgOptions extends EncodeOptions {
  /** Quiet zone in modules. The spec's minimum is 4; below that, scanners fail. */
  margin?: number;
  /** Dark colour. Defaults to `currentColor` so it inherits the game's theme. */
  dark?: string;
  /** Light colour. Defaults to white — a QR on a dark card must stay scannable. */
  light?: string;
}

/**
 * Inline SVG for the code, or `null` if the text does not fit.
 *
 * Deliberately white-backed by default: a "transparent" QR over a dark theme
 * inverts the contrast, and most scanners will not read an inverted code.
 */
export function toSvg(text: string, options: SvgOptions = {}): string | null {
  const code = encodeQr(text, options);
  if (!code) return null;
  const margin = options.margin ?? 4;
  const dark = options.dark ?? 'currentColor';
  const light = options.light ?? '#fff';
  const dim = code.size + margin * 2;

  let path = '';
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.modules[y][x]) path += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code linking to this room">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path fill="${dark}" d="${path}"/></svg>`
  );
}
