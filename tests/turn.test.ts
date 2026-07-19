/**
 * turn.test.ts — TURN credential fetching.
 *
 * The invariant that matters most is FAIL OPEN: every failure path must resolve
 * to `[]` (STUN-only, i.e. exactly the old behaviour) rather than throwing or
 * hanging. A player must never be blocked from joining a game because an infra
 * Worker had a bad minute.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTurnCache, getTurnConfig, TURN_URL } from '../src/turn';

const CF_RESPONSE = {
  iceServers: [
    // Cloudflare really does return :53 entries, which browsers refuse.
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
      ],
      username: 'user-abc',
      credential: 'cred-xyz',
    },
  ],
};

/** Minimal sessionStorage for node. */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  return map;
}

const ok = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

let store: Map<string, string>;
beforeEach(() => {
  store = installStorage();
  store.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getTurnConfig', () => {
  it('returns the ICE servers the worker minted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(CF_RESPONSE)));
    const servers = await getTurnConfig();
    expect(servers).toHaveLength(2);
    expect(servers[1]).toMatchObject({ username: 'user-abc', credential: 'cred-xyz' });
  });

  it('drops :53 URLs, which browsers block and non-trickle ICE waits out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(CF_RESPONSE)));
    const urls = (await getTurnConfig()).flatMap((s) =>
      Array.isArray(s.urls) ? s.urls : [s.urls],
    );
    expect(urls.some((u) => /:53(\?|$)/.test(u))).toBe(false);
    // …while :5349 (TURN over TLS) survives — it is the entry that rescues
    // corporate and school networks, so a sloppy ":53" filter would be a bug.
    expect(urls).toContain('turns:turn.cloudflare.com:5349?transport=tcp');
    expect(urls).toContain('stun:stun.cloudflare.com:3478');
  });

  it('accepts a bare object as well as an array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ iceServers: { urls: 'turn:x:3478' } })));
    expect(await getTurnConfig()).toEqual([{ urls: ['turn:x:3478'] }]);
  });

  // ── fail open ─────────────────────────────────────────────────────────────

  it('fails open on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
    expect(await getTurnConfig()).toEqual([]);
  });

  it('fails open when the network is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    expect(await getTurnConfig()).toEqual([]);
  });

  it('fails open on unparseable JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('bad json');
        },
      })) as unknown as typeof fetch,
    );
    expect(await getTurnConfig()).toEqual([]);
  });

  it('fails open, and does not hang, when the worker never answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_res, rej) => {
            init.signal.addEventListener('abort', () => rej(new Error('aborted')));
          }),
      ) as unknown as typeof fetch,
    );
    // Real timers with a tiny budget: proves the AbortController actually fires.
    expect(await getTurnConfig(TURN_URL, { timeoutMs: 20 })).toEqual([]);
  });

  it('does not cache a failure', async () => {
    const f = vi.fn(async () => ({ ok: false }) as Response);
    vi.stubGlobal('fetch', f);
    await getTurnConfig();
    await getTurnConfig();
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('session caching', () => {
  it('reuses a cached credential instead of refetching', async () => {
    const f = vi.fn(async () => ok(CF_RESPONSE));
    vi.stubGlobal('fetch', f);
    const first = await getTurnConfig();
    const second = await getTurnConfig();
    expect(f).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('refetches once the cached entry has expired', async () => {
    const f = vi.fn(async () => ok({ ...CF_RESPONSE, ttl: 60 })); // cache half of 60s
    vi.stubGlobal('fetch', f);
    await getTurnConfig();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31_000);
    await getTurnConfig();
    vi.useRealTimers();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('survives sessionStorage being unavailable (private mode)', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ok(CF_RESPONSE)));
    expect(await getTurnConfig()).toHaveLength(2);
    expect(() => clearTurnCache()).not.toThrow();
  });

  it('ignores a corrupt cache entry', async () => {
    store.set(`engine.turn.${TURN_URL}`, '{not json');
    vi.stubGlobal('fetch', vi.fn(async () => ok(CF_RESPONSE)));
    expect(await getTurnConfig()).toHaveLength(2);
  });

  it('clearTurnCache forces a refetch', async () => {
    const f = vi.fn(async () => ok(CF_RESPONSE));
    vi.stubGlobal('fetch', f);
    await getTurnConfig();
    clearTurnCache();
    await getTurnConfig();
    expect(f).toHaveBeenCalledTimes(2);
  });
});
