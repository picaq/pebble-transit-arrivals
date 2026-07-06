/*
 * favorites.js — persistent favorite stops, stored on the watch.
 *
 * Favorites survive app restarts and watch reboots via localStorage.
 * A favorite is the minimal record needed to fetch arrivals later:
 *   { agency: "SF", code: "15553", name: "Church St & 24th St" }
 *
 * Keep this list short (MAX_FAVORITES) — watch storage is limited and the
 * main screen renders favorites above nearby stops.
 */

const STORAGE_KEY = "favorites.v1";
const MAX_FAVORITES = 10;

function keyOf(stop) {
  return stop.agency + ":" + stop.code;
}

export function loadFavorites() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.log("favorites: failed to parse, resetting");
    localStorage.removeItem(STORAGE_KEY);
    return [];
  }
}

function save(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    console.log("favorites: save failed: " + e.message);
  }
}

export function isFavorite(stop) {
  return loadFavorites().some(f => keyOf(f) === keyOf(stop));
}

/** Toggle a stop; returns true if it is now a favorite. */
export function toggleFavorite(stop) {
  const list = loadFavorites();
  const k = keyOf(stop);
  const idx = list.findIndex(f => keyOf(f) === k);
  if (idx >= 0) {
    list.splice(idx, 1);
    save(list);
    return false;
  }
  list.unshift({ agency: stop.agency, code: stop.code, name: stop.name });
  if (list.length > MAX_FAVORITES) list.length = MAX_FAVORITES;
  save(list);
  return true;
}
