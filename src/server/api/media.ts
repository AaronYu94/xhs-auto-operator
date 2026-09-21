/**
 * Xiaohongshu images for the console. The console CSP only allows same-origin images, so account avatars and note
 * covers (Xiaohongshu CDN URLs stored in xhs_accounts.platform_profile) are fetched server-side through this proxy:
 * *.xhscdn.com only, always https, no redirects, image content types only, size-capped, small in-memory cache.
 * Requires a console session like every other route. Note-cover URLs are signed and expire: a failed fetch is a 502,
 * and the next login check stores fresh URLs.
 */
import type { Reply, Router } from '../http.ts';

export const XHS_IMAGE_HOST_RE = /^(?:[a-z0-9-]+\.)+xhscdn\.com$/;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_MAX_ENTRIES = 200;
const CACHE_TTL_MS = 60 * 60_000;

/** A Xiaohongshu CDN image URL upgraded to https, or null for anything else (never proxies arbitrary hosts). */
export function xhsImageUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || (u.port && u.port !== '80' && u.port !== '443')) return null;
  if (!XHS_IMAGE_HOST_RE.test(u.hostname.toLowerCase())) return null;
  u.protocol = 'https:';
  u.port = '';
  return u;
}

/** Same-origin src for a Xiaohongshu image, or null when the URL is not an allowed CDN image. */
export function xhsImageSrc(raw: string | null | undefined): string | null {
  const u = xhsImageUrl(raw);
  return u ? `/media/xhs-image?src=${encodeURIComponent(u.href)}` : null;
}

/** Hosts that must never be fetched on behalf of the console: anything not on the public internet. */
const PRIVATE_HOST_RE = /^(?:localhost|[^.]*\.local|\[?[0-9a-f:]*:[0-9a-f:]*\]?|(?:\d{1,3}\.){3}\d{1,3})$/i;

/**
 * A vehicle photo URL the console may display. Unlike the Xiaohongshu proxy this has no fixed host list — a store's
 * photos live wherever its DMS or CDN puts them — so the guard is different: https only, no credentials, no custom
 * port, never an IP literal or a private name (no SSRF into the deployment's own network), and the caller must
 * confirm the URL is one the store actually stored on a vehicle.
 */
export function vehicleImageUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.port) return null;
  if (PRIVATE_HOST_RE.test(u.hostname)) return null;
  if (!u.hostname.includes('.')) return null;
  return u;
}

/** Same-origin src for a stored vehicle photo, or null when it cannot be displayed (local path, bad URL). */
export function vehicleImageSrc(raw: string | null | undefined): string | null {
  const u = vehicleImageUrl(raw);
  return u ? `/media/vehicle-image?src=${encodeURIComponent(u.href)}` : null;
}

export interface MediaOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** true when this exact URL is stored on a vehicle of this installation (never proxy anything else) */
  isStoredVehicleImage?: (url: string) => boolean;
}

export function registerMediaRoutes(router: Router, opts: MediaOptions = {}): void {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<string, { body: Buffer; type: string; at: number }>();
  const fail = (status: number, message: string): Reply => ({ status, text: message });
  const fetchImage = async (key: string): Promise<Reply> => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) {
      return { body: hit.body, contentType: hit.type, headers: { 'cache-control': 'private, max-age=3600' } };
    }
    let res: Response;
    try {
      // No referrer, no cookies, no redirects: a plain anonymous read.
      res = await fetchImpl(key, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'image/*' } });
    } catch {
      return fail(502, 'image fetch failed');
    }
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (res.status !== 200 || !/^image\/(?:jpeg|png|webp|gif|avif|heic)$/.test(type)) return fail(502, `image unavailable (${res.status})`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_IMAGE_BYTES) return fail(502, 'image too large');
    const body = Buffer.from(await res.arrayBuffer());
    if (body.byteLength > MAX_IMAGE_BYTES) return fail(502, 'image too large');
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(key, { body, type, at: now() });
    return { body, contentType: type, headers: { 'cache-control': 'private, max-age=3600' } };
  };

  router.get('/media/vehicle-image', async (rc) => {
    const u = vehicleImageUrl(rc.query.get('src'));
    if (!u) return fail(400, 'not a displayable vehicle image URL');
    if (!opts.isStoredVehicleImage?.(u.href)) return fail(403, 'this image is not stored on a vehicle of this dealer group');
    return fetchImage(u.href);
  });

  router.get('/media/xhs-image', async (rc) => {
    const u = xhsImageUrl(rc.query.get('src'));
    if (!u) return fail(400, 'not a Xiaohongshu CDN image');
    return fetchImage(u.href);
  });
}
