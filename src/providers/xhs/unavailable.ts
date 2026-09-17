import type { Clock } from '../../core/clock.ts';
import { XHS_CAPABILITIES, type XhsCapability } from '../../core/types.ts';
import type {
  CapabilityReport,
  CapabilityState,
  ProviderFailure,
  ProviderMode,
  XhsCommentOptions,
  XhsCommentReplyRef,
  XhsNoteRef,
  XhsProvider,
  XhsPublishDraft,
  XhsSearchOptions,
  XhsUserRef,
} from './types.ts';

export function buildReport(
  provider: string,
  mode: ProviderMode,
  accountId: string | null,
  clock: Clock,
  states: Partial<Record<XhsCapability, Omit<CapabilityState, 'capability'>>>,
  fallback: Omit<CapabilityState, 'capability'> = { status: 'UNAVAILABLE', reason: 'not supported by this provider' },
): CapabilityReport {
  const capabilities = {} as Record<XhsCapability, CapabilityState>;
  for (const cap of XHS_CAPABILITIES) capabilities[cap] = { capability: cap, ...(states[cap] ?? fallback) };
  return { provider, mode, account_id: accountId, checked_at: clock.iso(), capabilities };
}

/**
 * Default provider when no Xiaohongshu integration is configured.
 * Every capability is UNAVAILABLE — the system keeps working (manual import, review queues)
 * and never pretends an action happened.
 */
export class UnavailableXhsProvider implements XhsProvider {
  readonly name = 'none';
  readonly mode: ProviderMode = 'none';
  private readonly clock: Clock;
  private readonly reason: string;

  constructor(clock: Clock, reason = 'No Xiaohongshu integration configured (set XHS_PROVIDER)') {
    this.clock = clock;
    this.reason = reason;
  }

  private fail(): ProviderFailure {
    return { ok: false, status: 'UNAVAILABLE', reason: this.reason };
  }

  async capabilities(accountId: string | null = null): Promise<CapabilityReport> {
    return buildReport(this.name, this.mode, accountId, this.clock, {}, { status: 'UNAVAILABLE', reason: this.reason });
  }
  async searchNotes(_query: string, _opts?: XhsSearchOptions, _accountId?: string | null): Promise<ProviderFailure> {
    return this.fail();
  }
  async getNote(_ref: XhsNoteRef, _accountId?: string | null): Promise<ProviderFailure> {
    return this.fail();
  }
  async getComments(_ref: XhsNoteRef, _opts?: XhsCommentOptions, _accountId?: string | null): Promise<ProviderFailure> {
    return this.fail();
  }
  async getUserProfile(_ref: XhsUserRef, _accountId?: string | null): Promise<ProviderFailure> {
    return this.fail();
  }
  async publishNote(_accountId: string, _draft: XhsPublishDraft): Promise<ProviderFailure> {
    return this.fail();
  }
  async getEngagement(_accountId: string, _platformNoteId: string): Promise<ProviderFailure> {
    return this.fail();
  }
  async replyToComment(_accountId: string, _ref: XhsCommentReplyRef, _text: string): Promise<ProviderFailure> {
    return this.fail();
  }
  async listInboundMessages(_accountId: string, _since: string | null): Promise<ProviderFailure> {
    return this.fail();
  }
  async sendMessage(_accountId: string, _toPlatformUserId: string, _text: string): Promise<ProviderFailure> {
    return this.fail();
  }
}
