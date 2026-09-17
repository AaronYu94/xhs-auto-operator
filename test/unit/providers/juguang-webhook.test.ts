import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../../../src/core/errors.ts';
import {
  juguangTimeToIso,
  noteIdFromUrl,
  parseJuguangLeadPush,
  parseJuguangLeadPushDetailed,
} from '../../../src/providers/xhs/juguang-webhook.ts';

describe('parseJuguangLeadPush', () => {
  it('parses a Chinese-labelled single lead record', () => {
    const body = {
      操作类型: '新增',
      时间: '2026-09-12 10:30:00',
      小红书号: '95012345678',
      用户昵称: '钱塘江的风',
      省份: '浙江',
      城市: '杭州',
      线索标签: '高意向，i3、到店',
      电话: '138 0000 1234',
      微信: 'qtj_wind',
      备注: '想周六下午看白色35L',
      笔记链接: 'https://www.xiaohongshu.com/explore/66e1a2b3c4d5e6f7a8b9c0d1?xsec_token=ABC',
      广告计划ID: 10001,
      单元ID: '20002',
      创意ID: '30003',
      私信接收人: '杭州宝马中心官方',
    };
    const [lead] = parseJuguangLeadPush(body);
    assert.equal(lead.platform_user_id, '95012345678');
    assert.equal(lead.nickname, '钱塘江的风');
    assert.equal(lead.province, '浙江');
    assert.equal(lead.city, '杭州');
    assert.deepEqual(lead.tags, ['高意向', 'i3', '到店']);
    assert.equal(lead.phone, '13800001234');
    assert.equal(lead.wechat, 'qtj_wind');
    assert.equal(lead.remark, '想周六下午看白色35L');
    assert.equal(lead.note_id, '66e1a2b3c4d5e6f7a8b9c0d1');
    assert.equal(lead.campaign_id, '10001');
    assert.equal(lead.unit_id, '20002');
    assert.equal(lead.creative_id, '30003');
    assert.equal(lead.receiver, '杭州宝马中心官方');
    assert.equal(lead.operation, '新增');
    assert.equal(lead.occurred_at, '2026-09-12T02:30:00.000Z', 'naive time interpreted as Asia/Shanghai');
    assert.equal(lead.raw, body);
  });

  it('accepts snake_case and camelCase variants wrapped in {data: [...]}', () => {
    const leads = parseJuguangLeadPush({
      code: 0,
      data: [
        { user_id: 'u-hz-buyer-001', nickname: '西湖边的小鹿', province: '浙江', tags: ['i3', '35L'], phone: '13900002222', push_time: 1789180200000, note_url: 'https://www.xiaohongshu.com/discovery/item/abc123def456' },
        { redId: '9988776655', nickName: '静安小周', city: '上海', wechat: 'zhou_sh', campaignId: 'c-1', unitId: 'u-1', creativeId: 'cr-1', receiverId: 'xhs-sh-official', pushTime: 1789180200 },
      ],
    });
    assert.equal(leads.length, 2);
    assert.equal(leads[0].platform_user_id, 'u-hz-buyer-001');
    assert.deepEqual(leads[0].tags, ['i3', '35L']);
    assert.equal(leads[0].note_id, 'abc123def456');
    assert.equal(leads[0].occurred_at, new Date(1789180200000).toISOString());
    assert.equal(leads[1].platform_user_id, '9988776655');
    assert.equal(leads[1].nickname, '静安小周');
    assert.equal(leads[1].campaign_id, 'c-1');
    assert.equal(leads[1].receiver, 'xhs-sh-official');
    assert.equal(leads[1].occurred_at, new Date(1789180200 * 1000).toISOString(), 'epoch seconds supported');
    assert.equal(leads[1].phone, null);
    assert.equal(leads[1].note_url, null);
  });

  it('prefers user_id over red_id and reads one nested level', () => {
    const [lead] = parseJuguangLeadPush([{ user: { user_id: 'uid-1', red_id: '123', nickname: 'n' }, ad: { campaign_id: 'cmp' }, time: '2026-09-12T03:00:00+08:00' }]);
    assert.equal(lead.platform_user_id, 'uid-1');
    assert.equal(lead.campaign_id, 'cmp');
    assert.equal(lead.occurred_at, '2026-09-11T19:00:00.000Z');
  });

  it('parses JSON string bodies and reports rejected items in detailed mode', () => {
    const detailed = parseJuguangLeadPushDetailed(JSON.stringify([{ 电话: '13700001111' }, { 备注: '只有备注' }, 'garbage']));
    assert.equal(detailed.leads.length, 1);
    assert.equal(detailed.leads[0].phone, '13700001111');
    assert.deepEqual(detailed.rejected.map((r) => r.index), [1, 2]);
  });

  it('throws ValidationError on unusable payloads', () => {
    assert.throws(() => parseJuguangLeadPush(null), ValidationError);
    assert.throws(() => parseJuguangLeadPush(42), ValidationError);
    assert.throws(() => parseJuguangLeadPush('{not json'), /not valid JSON/);
    assert.throws(() => parseJuguangLeadPush([]), /no lead records/);
    assert.throws(() => parseJuguangLeadPush({ data: [{ 备注: 'x' }] }), /no user identity/);
  });

  it('helpers: note id extraction and time parsing', () => {
    assert.equal(noteIdFromUrl('https://www.xiaohongshu.com/explore/note-own-hz-i3-001?xsec_token=x'), 'note-own-hz-i3-001');
    assert.equal(noteIdFromUrl('https://example.com/share?noteId=abcdef123'), 'abcdef123');
    assert.equal(noteIdFromUrl('https://www.xiaohongshu.com/user/profile/xyz'), null);
    assert.equal(noteIdFromUrl(null), null);
    assert.equal(juguangTimeToIso('2026/09/12 08:00'), '2026-09-12T00:00:00.000Z');
    assert.equal(juguangTimeToIso('not a time'), null);
    assert.equal(juguangTimeToIso(''), null);
  });
});

describe('parseJuguangLeadPush hardening', () => {
  it('never takes the lead identity or nickname from nested note / receiver objects', () => {
    const [lead] = parseJuguangLeadPush({
      小红书号: '95012345678',
      note: { user_id: 'note-author-5f3a', nickname: '电车老司机阿杰', 笔记链接: 'https://www.xiaohongshu.com/explore/66e1a2b3c4d5?xsec_token=x' },
      receiver: { user_id: 'xhs-hz-official', nickname: '杭州宝马中心官方' },
      电话: '13800001234',
    });
    assert.equal(lead.platform_user_id, '95012345678');
    assert.equal(lead.red_id, '95012345678');
    assert.equal(lead.nickname, null, 'receiver / note author nickname is not the lead nickname');
    assert.equal(lead.note_url, 'https://www.xiaohongshu.com/explore/66e1a2b3c4d5?xsec_token=x', 'non-person fields may come from nested objects');
    assert.equal(lead.note_id, '66e1a2b3c4d5');

    const [nested] = parseJuguangLeadPush({ user_info: { 小红书号: '777', 昵称: '钱塘江的风' }, author: { user_id: 'kol' }, 线索时间: '2026-09-12 10:00' });
    assert.equal(nested.platform_user_id, '777');
    assert.equal(nested.nickname, '钱塘江的风');

    const [both] = parseJuguangLeadPush({ user_id: '5f3a9b', 小红书号: '9501' });
    assert.equal(both.platform_user_id, '5f3a9b');
    assert.equal(both.red_id, '9501');
  });

  it('parses compact, fractional and Chinese date formats in Asia/Shanghai; rejects impossible or zone-less free text', () => {
    assert.equal(juguangTimeToIso('20260912103000'), '2026-09-12T02:30:00.000Z');
    assert.equal(juguangTimeToIso(20260912103000), '2026-09-12T02:30:00.000Z');
    assert.equal(juguangTimeToIso('202609121030'), '2026-09-12T02:30:00.000Z');
    assert.equal(juguangTimeToIso('20260912'), '2026-09-11T16:00:00.000Z');
    assert.equal(juguangTimeToIso('2026-09-12 10:30:00.123'), '2026-09-12T02:30:00.123Z');
    assert.equal(juguangTimeToIso('2026年9月12日 10:30'), '2026-09-12T02:30:00.000Z');
    assert.equal(juguangTimeToIso('１７８９１８０２００'), new Date(1789180200 * 1000).toISOString(), 'full-width digits');
    assert.equal(juguangTimeToIso('1789180200000123'), new Date(1789180200000).toISOString(), 'epoch microseconds');
    assert.equal(juguangTimeToIso('2026-13-01 10:00'), null);
    assert.equal(juguangTimeToIso('2026-02-30'), null);
    assert.equal(juguangTimeToIso('2026-09-12 24:00'), null);
    assert.equal(juguangTimeToIso('Sat Sep 12 2026 10:30:00'), null, 'zone-less free text would depend on server TZ');
    assert.equal(juguangTimeToIso('12345'), null);
    assert.equal(juguangTimeToIso('2026-09-12T10:30:00Z'), '2026-09-12T10:30:00.000Z');
  });

  it('unwraps nested envelopes like {code, data: {list: [...]}}', () => {
    const leads = parseJuguangLeadPush({ code: 0, msg: 'success', data: { total: 2, list: [{ 小红书号: '1', 电话: '13800000000' }, { user_id: 'u2', 微信: 'wx2' }] } });
    assert.deepEqual(leads.map((l) => l.platform_user_id), ['1', 'u2']);
    const single = parseJuguangLeadPush({ data: JSON.stringify({ result: { 小红书号: '3', 用户昵称: '静安小周' } }) });
    assert.equal(single[0].nickname, '静安小周');
    assert.throws(() => parseJuguangLeadPush({ code: 0, data: { list: [] } }), /no lead records found/);
  });
});
