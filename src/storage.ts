/**
 * storage.ts — namespaced, typed, quota-safe localStorage for settings and
 * local high scores. NEVER used for anything that must be authoritative across
 * peers (that's the host's job). Games are offline-capable, so all persistence
 * is local by design.
 *
 * IMPORT from '@ben-gy/game-engine/storage' and pass your repo slug as the
 * namespace — do not copy it in.
 */

export function createStore(namespace: string) {
  const key = (k: string) => `game:${namespace}:${k}`;

  function get<T>(k: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key(k));
      if (raw == null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  function set<T>(k: string, value: T): void {
    try {
      localStorage.setItem(key(k), JSON.stringify(value));
    } catch {
      // quota exceeded / disabled — persistence is best-effort
    }
  }

  function remove(k: string): void {
    try {
      localStorage.removeItem(key(k));
    } catch {
      /* ignore */
    }
  }

  /** Record a score into a top-N leaderboard. Returns the new sorted board. */
  function recordScore(
    board: string,
    entry: { name: string; score: number },
    topN = 10,
  ): { name: string; score: number }[] {
    const list = get<{ name: string; score: number }[]>(board, []);
    list.push(entry);
    list.sort((a, b) => b.score - a.score);
    const trimmed = list.slice(0, topN);
    set(board, trimmed);
    return trimmed;
  }

  return { get, set, remove, recordScore };
}
