/**
 * identity.ts — carry the player's display name between games, without cookies.
 *
 * Every game is its own subdomain, so every game is its own ORIGIN and gets its
 * own localStorage. There is no way to read one game's storage from another. A
 * cookie on the parent domain would do it, but the games promise players "no
 * cookies" in their About panel, and a name is not worth breaking that for.
 *
 * So the name travels the only way left: as a `?n=` parameter on a link the
 * player themselves clicked (hub → game, game → hub). Each site seeds its OWN
 * localStorage from it once and strips it. No cookie, no shared store, no
 * identifier — just a name riding a first-party link.
 *
 * Be honest about the limits: this only helps when the player arrives via a link
 * that carries the name. Typing a URL, or following an invite link, still starts
 * from that game's own stored name. It is a nudge, not sync.
 *
 * IMPORT from '@ben-gy/game-engine/identity' — do not copy it into the game.
 *
 *   const name = seedNameFromLink(store) ?? storedNameOrDefault();
 */

/** The param name. Short, and unlikely to collide with a game's own params. */
const NAME_PARAM = 'n';
const MAX_NAME = 16;

function clean(raw: string): string {
  // Same shape a name field would accept. Never trust a URL: this string lands
  // in other players' lobbies, so it is length-capped and stripped of controls.
  return raw
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, MAX_NAME);
}

/**
 * Read `?n=` and remove it from the URL immediately.
 *
 * The strip is not cosmetic and must happen at BOOT, before anything builds an
 * invite link: those links are derived from `location.href`, so a lingering
 * `?n=` would ride along and rename whoever accepted the invite to the host.
 */
export function takeNameFromLink(): string | null {
  const url = new URL(location.href);
  const raw = url.searchParams.get(NAME_PARAM);
  if (raw == null) return null;
  url.searchParams.delete(NAME_PARAM);
  history.replaceState(null, '', url.toString());
  const name = clean(raw);
  return name.length ? name : null;
}

export interface NameStore {
  get<T>(k: string, fallback: T): T;
  set<T>(k: string, v: T): void;
}

/**
 * Resolve this player's name for THIS game: a name carried on the link wins on
 * a first visit, otherwise whatever this game already had.
 *
 * A link never overwrites a name the player has already chosen here — arriving
 * from the hub should not silently rename you in a game you have played before.
 */
export function resolveName(store: NameStore, fallback: () => string): string {
  const fromLink = takeNameFromLink();
  const stored = store.get<string>('name', '');
  if (stored) return stored;
  const name = fromLink ?? fallback();
  store.set('name', name);
  return name;
}

/** Add the player's name to an outbound link to a sibling site. */
export function withName(href: string, name: string): string {
  const n = clean(name);
  if (!n) return href;
  try {
    const url = new URL(href, location.href);
    url.searchParams.set(NAME_PARAM, n);
    return url.toString();
  } catch {
    return href;
  }
}
