/**
 * Real Xiaohongshu content from the first live discovery run (2026-09): every note and comment came from dealer stores
 * and their sales staff, and the rules then turned 5 of those accounts into "buyer" leads. Sellers must be classified
 * DEALER_OR_SALES — by account name and, independently, by their promotion phrasing — and buyers asking about the same
 * offers must not be.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { DealerProfile, SignalContext } from '../../../src/core/types.ts';
import { DEALER_ACCOUNT_NAME_RE } from '../../../src/domain/automotive-lexicon.ts';
import { classifyActor } from '../../../src/domain/actor-classification.ts';
import { analyzeSignal } from '../../../src/skills/acquisition/intent-detection/nlu.ts';
import { detectIndustryAccount } from '../../../src/skills/acquisition/lead-research/index.ts';

interface Row {
  source_type: 'post' | 'comment';
  nickname: string;
  title?: string;
  content: string;
  seller: boolean;
  text_cue?: boolean;
}
const { rows } = JSON.parse(readFileSync(new URL('./fixtures/xhs-live-dealer-posts.json', import.meta.url), 'utf8')) as { rows: Row[] };

const XPENG: DealerProfile = {
  dealer_id: 'dlr_live',
  brands: ['XPeng'],
  models: [],
  trims: [],
  inventory: [],
  offers: [],
  city: '舟山',
  province: '浙江',
  service_cities: ['舟山'],
} as unknown as DealerProfile;

function actorOf(content: string, source_type: Row['source_type'], nickname: string | null, title?: string) {
  const context: SignalContext =
    source_type === 'post'
      ? { source_type, post_title: title ?? null, post_content: content, author_nickname: nickname }
      : { source_type, author_nickname: nickname };
  const a = analyzeSignal(content, context, XPENG);
  return classifyActor(a.detection, a.prefilter);
}

const label = (r: Row) => `${r.nickname}: ${(r.title || r.content).slice(0, 30)}`;

describe('live capture: dealer stores and sales staff are never buyers', () => {
  it('the fixture is the real mix: mostly sellers, a few owners', () => {
    assert.equal(rows.length, 23);
    assert.equal(rows.filter((r) => r.seller).length, 19);
  });

  it('every seller text is DEALER_OR_SALES with its account name', () => {
    for (const r of rows.filter((x) => x.seller)) {
      assert.equal(actorOf(r.content, r.source_type, r.nickname, r.title).actor_type, 'DEALER_OR_SALES', label(r));
    }
  });

  it('the promotion phrasing alone identifies the seller (account name hidden)', () => {
    for (const r of rows.filter((x) => x.seller && x.text_cue !== false)) {
      assert.equal(actorOf(r.content, r.source_type, null, r.title).actor_type, 'DEALER_OR_SALES', label(r));
    }
  });

  it('owners sharing their car are neither buyers nor sellers', () => {
    for (const r of rows.filter((x) => !x.seller)) {
      const actor = actorOf(r.content, r.source_type, r.nickname, r.title).actor_type;
      assert.ok(actor !== 'BUYER' && actor !== 'DEALER_OR_SALES', `${label(r)} → ${actor}`);
    }
  });

  it('buyers asking about the same offers stay buyers', () => {
    const buyers: [Row['source_type'], string | undefined, string][] = [
      ['post', 'M03和海豚选哪个？', '预算12万，第一次买车，舟山通勤为主，纠结M03和海豚，求推荐'],
      ['post', '小鹏M03落地价多少合适', '舟山这边店里说至高2万权益，0首付，靠谱吗？想这个月入手'],
      ['comment', undefined, '新车到店了吗？想去看看'],
      ['comment', undefined, '舟山小鹏销售服务中心在哪？周末想去试驾'],
      ['post', '想换车，G6还是Model Y', '家里老车开了八年，准备换台电车，预算20万，G6和Model Y怎么选？'],
    ];
    for (const [type, title, content] of buyers) {
      assert.equal(actorOf(content, type, '普通用户', title).actor_type, 'BUYER', content);
    }
    // a buyer addressing other buyers is not soliciting
    assert.notEqual(actorOf('想买M03的宝子们，舟山哪家店价格好？', 'comment', null).actor_type, 'DEALER_OR_SALES');
  });
});

describe('dealer account names (naming convention, not brand)', () => {
  const sellerNames = [...new Set(rows.filter((r) => r.seller && r.nickname !== '厂里小t').map((r) => r.nickname))];
  const personalNames = ['路人甲', '理想汽车车主 | 小王', '汽车博主-阿杰', 'i3电车研究所', '爱吃汽车糖的猫', '汽车小白一枚', '小米汽车 | 车主日记', '路人丁-车友会'];
  const norm = (s: string) => s.normalize('NFKC').toLowerCase();

  it('matches store and staff accounts, not owners, creators or fans', () => {
    assert.ok(sellerNames.length >= 7);
    for (const n of sellerNames) assert.ok(DEALER_ACCOUNT_NAME_RE.test(norm(n)), n);
    for (const n of personalNames) assert.ok(!DEALER_ACCOUNT_NAME_RE.test(norm(n)), n);
  });

  it('lead research closes such accounts as industry accounts even with an empty bio', () => {
    for (const n of sellerNames) {
      const d = detectIndustryAccount({ nickname: n, bio: '' });
      assert.ok(d.industry, n);
      assert.equal(d.evidence?.quote, n);
    }
    for (const n of personalNames) assert.equal(detectIndustryAccount({ nickname: n, bio: '' }).industry, false, n);
  });
});
