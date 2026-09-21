/**
 * Images on the public site: real console screenshots from a customer store that agreed to be shown, with every
 * Xiaohongshu user's name, avatar and words blurred before the capture. Only the files listed here are served, read
 * once at start-up; the URL carries a content hash, so a new capture is never served stale.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const NAMES = ['leads.webp', 'lead-score.webp', 'search-terms.webp'] as const;
export type SiteImage = (typeof NAMES)[number];

const FILES = new Map<string, Buffer>(NAMES.map((n) => [n, readFileSync(new URL(`./site-images/${n}`, import.meta.url))]));

export const SITE_IMAGE_VERSION = createHash('sha256')
  .update(Buffer.concat([...FILES.values()]))
  .digest('hex')
  .slice(0, 10);

export function siteImage(name: string): Buffer | null {
  return FILES.get(name) ?? null;
}

export const siteImageUrl = (name: SiteImage): string => `/assets/site/${name}?v=${SITE_IMAGE_VERSION}`;
