import { randomBytes } from 'node:crypto';

/**
 * Prefixed, roughly time-sortable identifiers, e.g. `lead_0mf3k2a1b9c4e7f21a`.
 * Prefix makes ids self-describing in logs, audit trails and URLs.
 */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const rand = randomBytes(5).toString('hex');
  return `${prefix}_${time}${rand}`;
}
