import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { encodeQr, toSvg, type EccLevel } from '../src/qr';

/**
 * These do not check the encoder against itself. Every case is decoded by an
 * independent implementation (jsQR, dev-only), because the failure that matters
 * is "renders beautifully, does not scan" — and only a decoder can catch it.
 */

const QUIET = 4;
const SCALE = 3; // jsQR wants a few pixels per module to lock on

/** Render to the RGBA bitmap jsQR expects, with a quiet zone. */
function rasterise(text: string, ecc: EccLevel) {
  const code = encodeQr(text, { ecc });
  if (!code) return null;
  const dim = (code.size + QUIET * 2) * SCALE;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.modules[y][x]) continue;
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const px = ((y + QUIET) * SCALE + dy) * dim + ((x + QUIET) * SCALE + dx);
          data[px * 4] = 0;
          data[px * 4 + 1] = 0;
          data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { code, decoded: jsQR(data, dim, dim)?.data ?? null };
}

function roundTrip(text: string, ecc: EccLevel = 'M'): string | null {
  return rasterise(text, ecc)?.decoded ?? null;
}

describe('qr round-trips through an independent decoder', () => {
  it('encodes a real invite link', () => {
    const link = 'https://orbital-skirmish.benrichardson.dev/?room=K7QP';
    expect(roundTrip(link)).toBe(link);
  });

  it('encodes every invite link shape the factory produces', () => {
    const links = [
      'https://morsel.benrichardson.dev/?room=AB3D',
      'https://hexbloom.benrichardson.dev/?room=ZZ99',
      'https://cipher-clash.benrichardson.dev/?room=K7QP',
      'http://localhost:5173/?room=TEST',
      'https://tiny-tanks.benrichardson.dev/?room=ABCDEFGH',
    ];
    for (const link of links) expect(roundTrip(link), link).toBe(link);
  });

  it('round-trips at every ECC level', () => {
    const link = 'https://snake-royale.benrichardson.dev/?room=QW42';
    for (const ecc of ['L', 'M', 'Q', 'H'] as EccLevel[]) {
      expect(roundTrip(link, ecc), ecc).toBe(link);
    }
  });

  it('round-trips across the whole length range it claims to support', () => {
    // Every length from 1 to the version-10/M ceiling, stepped, so a version
    // or block-split boundary cannot pass unnoticed.
    for (let len = 1; len <= 200; len += 7) {
      const text = 'A'.repeat(len);
      expect(roundTrip(text), `length ${len}`).toBe(text);
    }
  });

  it('round-trips arbitrary byte content, not just the happy alphabet', () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~:/?#[]@!$&()*+,;=%';
    for (let n = 0; n < 25; n++) {
      const len = 1 + Math.floor(rand() * 120);
      let text = '';
      for (let i = 0; i < len; i++) text += alphabet[Math.floor(rand() * alphabet.length)];
      expect(roundTrip(text), text).toBe(text);
    }
  });

  it('picks the smallest version that fits', () => {
    expect(encodeQr('hi', { ecc: 'M' })!.version).toBe(1);
    expect(encodeQr('A'.repeat(200), { ecc: 'M' })!.version).toBe(10);
    // size = version * 4 + 17
    expect(encodeQr('hi', { ecc: 'M' })!.size).toBe(21);
  });
});

describe('qr degrades rather than throwing', () => {
  it('returns null when the text cannot fit', () => {
    expect(encodeQr('A'.repeat(5000))).toBeNull();
    expect(toSvg('A'.repeat(5000))).toBeNull();
  });
});

describe('toSvg', () => {
  it('emits self-contained SVG with no external references', () => {
    const svg = toSvg('https://morsel.benrichardson.dev/?room=AB3D')!;
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // no remote assets
    expect(svg).not.toContain('<script');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label');
  });

  it('inherits theme colour but keeps an opaque light background', () => {
    const svg = toSvg('hello')!;
    expect(svg).toContain('currentColor');
    expect(svg).toContain('fill="#fff"'); // never transparent — inverted codes do not scan
  });

  it('includes the quiet zone the spec requires', () => {
    const code = encodeQr('hello')!;
    const svg = toSvg('hello')!;
    const dim = code.size + 8;
    expect(svg).toContain(`viewBox="0 0 ${dim} ${dim}"`);
  });
});
