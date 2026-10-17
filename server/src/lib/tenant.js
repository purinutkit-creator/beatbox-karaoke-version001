// Resolves which store (tenant) a request belongs to and runs the rest of the request inside that store's context.
//  1. staff / member tokens carry their store (signed claim `st`) — a token can never be used against another store
//  2. a device signed in to a store (store code + store account) sends its store session (X-Store-Session)
//  3. public pages pass the store code, slug or id (X-Store header or ?store=)
//  4. otherwise the original (first) store, so existing links keep working
import { pool, runWithStore, runAsPlatform, setContextStore } from '../db/index.js';
import { verifyToken } from './auth.js';
import { notFound } from './errors.js';
import { readStoreSession } from '../services/storeAccount.js';

let defaultStore = { id: null, at: 0 };
const refCache = new Map(); // ref -> { id, at }

export async function defaultStoreId() {
  if (defaultStore.id && Date.now() - defaultStore.at < 60000) return defaultStore.id;
  const r = await runAsPlatform(() => pool.query('SELECT min(id) AS id FROM stores'));
  defaultStore = { id: r.rows[0]?.id || null, at: Date.now() };
  return defaultStore.id;
}

/** Store id from a slug or numeric id (null when unknown). */
export async function resolveStoreRef(ref) {
  const key = String(ref || '').trim().toLowerCase();
  if (!key) return null;
  const hit = refCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.id;
  const r = await runAsPlatform(() => pool.query(`SELECT id FROM stores WHERE lower(slug) = $1 OR lower(store_code) = $1 OR id::text = $1 LIMIT 1`, [key]));
  const id = r.rows[0]?.id || null;
  refCache.set(key, { id, at: Date.now() });
  return id;
}

export function clearStoreCache() {
  refCache.clear();
  defaultStore = { id: null, at: 0 };
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

export async function storeForRequest(req) {
  const token = bearer(req);
  const p = token ? verifyToken(token) : null;
  if (p && (p.typ === 'employee' || p.typ === 'member')) return Number(p.st) || defaultStoreId();
  const session = req.headers['x-store-session'];
  if (session) {
    const sid = await readStoreSession(session);
    if (sid) {
      req.storeSession = sid;
      return sid;
    }
  }
  const ref = req.headers['x-store'] || req.query?.store;
  if (ref) {
    const id = await resolveStoreRef(ref);
    if (!id) throw notFound('ไม่พบร้านค้า');
    return id;
  }
  return defaultStoreId();
}

/** Express middleware: everything after it runs in the store's context. */
export function tenantContext(req, res, next) {
  storeForRequest(req).then(
    (storeId) =>
      runWithStore(storeId, () => {
        req.storeId = storeId;
        next();
      }),
    next,
  );
}

/**
 * Global lookup of a random token / code (QR link, display pair code, webhook reference) → switch the current
 * context to the store that owns it. Returns the store id or null.
 */
export async function useStoreOf(table, column, value) {
  if (value == null || value === '') return null;
  const r = await runAsPlatform(() => pool.query(`SELECT store_id FROM ${table} WHERE ${column} = $1 LIMIT 1`, [value]));
  const sid = r.rows[0]?.store_id || null;
  if (sid) setContextStore(sid);
  return sid;
}
