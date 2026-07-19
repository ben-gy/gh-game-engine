/**
 * turn.ts — short-lived TURN credentials for the WebRTC handshake.
 *
 * WHY THIS EXISTS. Trystero's default ICE is STUN-only. STUN discovers your
 * public address, which is enough when at least one side can accept an inbound
 * path — but a phone on carrier-grade NAT (most AU mobile plans), a corporate
 * or school network, or a locked-down guest Wi-Fi cannot. Those pairs find each
 * other in signaling and then the data channel simply never opens, so
 * `onPeerJoin` never fires and both players sit in the right room code staring
 * at an empty lobby. TURN relays the media/data through a server and rescues
 * exactly those pairs. Games here are mobile-first, so this is the highest-value
 * reliability fix in the engine.
 *
 * WHY A WORKER MINTS THEM. TURN credentials must be short-lived, and minting
 * them needs an API token that must never ship in a browser bundle. So one
 * shared first-party Worker (`gh-game-infra`, rt.benrichardson.dev) holds the
 * token and hands out 6-hour credentials. That is the whole backend: it carries
 * no gameplay state, and no game has a backend of its own.
 *
 * FAIL OPEN, ALWAYS. Every failure path here returns `[]`, which is precisely
 * the old STUN-only behaviour. A joining player must never be blocked, delayed
 * past a few seconds, or shown an error because an infra worker is down — TURN
 * is an upgrade to connectivity, never a dependency of it.
 *
 *   const turnConfig = await getTurnConfig();
 *   const net = createNet({ appId: roomAppId('my-game'), roomId, turnConfig });
 */

/** The fleet's shared TURN endpoint. */
export const TURN_URL = 'https://rt.benrichardson.dev/turn';

/** sessionStorage key prefix — one entry per endpoint URL. */
const CACHE_PREFIX = 'engine.turn.';

/**
 * How long to reuse a cached credential when the server does not tell us its
 * TTL. Half of the Worker's 6-hour TTL, so a cached credential is never close to
 * expiring when a round starts.
 */
const DEFAULT_CACHE_MS = 3 * 60 * 60 * 1000;

interface CacheEntry {
  iceServers: RTCIceServer[];
  /** Epoch ms after which this entry must be refetched. */
  expires: number;
}

interface TurnResponse {
  iceServers?: RTCIceServer[] | RTCIceServer;
  /** Seconds, if the Worker chooses to report the TTL it requested. */
  ttl?: number;
}

/**
 * Browsers refuse to use ICE URLs on port 53, and because Trystero does not use
 * trickle ICE for these, a bad entry costs the whole ICE-gathering timeout
 * rather than being skipped. Cloudflare's response does include `:53` STUN
 * entries, so this is a live concern, not a theoretical one.
 */
function usablePorts(server: RTCIceServer): RTCIceServer | null {
  const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
    // Port 53 only — anchored on the query string or end of URL, so the useful
    // `turns:…:5349` (TURN over TLS, the entry that rescues corporate networks)
    // is not caught by a naive ":53" substring match.
    (u): u is string => typeof u === 'string' && !/:53(\?|$)/.test(u),
  );
  return urls.length ? { ...server, urls } : null;
}

function readCache(url: string): RTCIceServer[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + url);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (!entry || typeof entry.expires !== 'number' || Date.now() >= entry.expires) return null;
    return Array.isArray(entry.iceServers) ? entry.iceServers : null;
  } catch {
    // Private mode, disabled storage, or corrupt JSON. Not worth a refetch
    // failure — just treat it as a miss.
    return null;
  }
}

function writeCache(url: string, iceServers: RTCIceServer[], ttlSeconds?: number): void {
  try {
    const ms = ttlSeconds && ttlSeconds > 0 ? (ttlSeconds * 1000) / 2 : DEFAULT_CACHE_MS;
    const entry: CacheEntry = { iceServers, expires: Date.now() + ms };
    sessionStorage.setItem(CACHE_PREFIX + url, JSON.stringify(entry));
  } catch {
    /* storage unavailable or full — caching is an optimisation, not a requirement */
  }
}

/**
 * Fetch ICE servers (STUN + TURN) for this session.
 *
 * Cached in `sessionStorage` for half the credential lifetime, so joining five
 * rooms in a session costs one request. Never throws and never rejects: on
 * timeout, network error, non-2xx, or unparseable body it resolves to `[]` and
 * the caller proceeds STUN-only.
 */
export async function getTurnConfig(
  url: string = TURN_URL,
  { timeoutMs = 3000 }: { timeoutMs?: number } = {},
): Promise<RTCIceServer[]> {
  const cached = readCache(url);
  if (cached) return cached;

  const ctrl = new AbortController();
  // A join must never wait on infra. If the Worker is slow, we abandon it and
  // connect STUN-only rather than holding the player on a spinner.
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) return [];
    const body = (await res.json()) as TurnResponse;
    const raw = body?.iceServers;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const servers = list
      .filter((s): s is RTCIceServer => !!s && !!s.urls)
      .map(usablePorts)
      .filter((s): s is RTCIceServer => s !== null);
    if (servers.length) writeCache(url, servers, body?.ttl);
    return servers;
  } catch {
    // Aborted, offline, CORS-blocked, or malformed. All the same to us.
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Test/debug helper: forget any cached credential for `url`. */
export function clearTurnCache(url: string = TURN_URL): void {
  try {
    sessionStorage.removeItem(CACHE_PREFIX + url);
  } catch {
    /* nothing to clear */
  }
}
