/**
 * 说人话: the console speaks to a car dealer, not to whoever built the system.
 *
 * Everything technical the runtime produces — provider tool names, English capability reasons, internal row ids,
 * skill and agent names, instance URLs, environment variable names — is diagnostic material. It belongs in the audit
 * log and in the server's own logs, never on a page a salesperson reads. This module is the one place that turns it
 * into a sentence about the store's business, and `scrubInternals` is the safety net for text that nobody mapped yet.
 *
 * The rule: a page renders `human*()` output. If a raw string must be shown for support, it goes inside the 技术详情
 * disclosure on 系统, and nowhere else.
 */
import type { AppContext } from '../app/context.ts';
import type { CapabilityStatus, XhsCapability } from '../core/types.ts';

/** Ids this system generates (ARCHITECTURE §1 prefixes) plus the instance names of the account sessions. */
const INTERNAL_ID_RE =
  /\b(?:lead|veh|acc|dlr|grp|post|plan|ppost|pcmt|sig|score|asgn|out|conv|msg|appt|conv|run|step|goal|dec|evt|cap|brief|reply|rep|ntf|inv|off|know|sch|cfg|sq|sr|dnc|trans)_[0-9a-z]{6,}\b/gi;
const XHS_INSTANCE_RE = /\bxhs[_-][0-9a-z]{6,}\b/gi;
/** Tool and component names of the integration layer. */
const TOOL_RE =
  /\b(?:xiaohongshu-mcp|xhs-mcp-fleet(?:\.sh)?|Dealer ?Brain|search_feeds|get_feed_detail|user_profile|get_my_profile|publish_content|publish_with_video|post_comment_to_feed|reply_comment_in_feed|like_feed|favorite_feed|list_feeds|get_unread_count|list_notifications|reply_notification|like_notification|check_login_status|get_login_qrcode|delete_cookies|tools\/list|tools\/call)\b/gi;
const ENV_RE = /\bXHS_[A-Z_]+\b|\bAPP_ENV\b|\bDATABASE_PATH\b|\bOPENROUTER_API_KEY\b|\bANTHROPIC_API_KEY\b|\bLLM_[A-Z_]+\b|\bCONSOLE_PASSWORD\b|\bSESSION_SECRET\b/g;
const URL_RE = /\bhttps?:\/\/[^\s)）」』]+/gi;
const STATUS_RE = /\b(?:UNAVAILABLE|REQUIRES_AUTH|REQUIRES_REVIEW|AVAILABLE|HEALTHY|WATCH|AT_RISK|RESTRICTED|READY_FOR_REVIEW|SENT_MANUALLY|PENDING|SUCCEEDED|FAILED|SKIPPED)\b:?/g;
const PAREN_NOISE_RE = /[（(]\s*(?:account|instance|db|env|endpoint)[^)）]*[)）]/gi;

/**
 * Remove everything that only means something to whoever maintains the system. Used as a last line of defence on
 * text that has no specific mapping — a page should prefer a real `human*()` sentence.
 */
export function scrubInternals(raw: string | null | undefined): string {
  if (!raw) return '';
  let t = String(raw);
  t = t.replace(PAREN_NOISE_RE, ' ');
  t = t.replace(TOOL_RE, '小红书接口');
  t = t.replace(URL_RE, '');
  t = t.replace(ENV_RE, '');
  t = t.replace(STATUS_RE, '');
  t = t.replace(XHS_INSTANCE_RE, '');
  t = t.replace(INTERNAL_ID_RE, '');
  // leftovers from the removals: doubled separators and stray brackets
  t = t.replace(/[（(]\s*[)）]/g, ' ').replace(/\s*[:：]\s*(?=[,，。;；]|$)/g, '');
  t = t.replace(/\s{2,}/g, ' ').replace(/^[\s,，。:：、·|-]+|[\s,，:：、·|-]+$/g, '');
  return t.trim();
}

const clip = (t: string, max: number): string => ([...t].length > max ? `${[...t].slice(0, max - 1).join('')}…` : t);

// ─────────────────────────────────────────────────────────────────────────────
// What went wrong, and what the store should do about it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One sentence about a failure, in the store's terms. Order matters: the most actionable cause wins, so a
 * logged-out account is reported as "去扫码登录" even when the error also mentions a timeout.
 */
export function humanProblem(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = String(raw);
  if (/interrupted: process restarted/i.test(t)) return '系统重启时这一步被打断了，重新运行即可。';
  if (/cancel/i.test(t)) return '任务被取消了。';
  if (/REQUIRES_AUTH|not logged in|未登录|登录已?过期|扫码登录/i.test(t)) return '账号掉登录了，去「账号」页重新扫码登录就能继续。';
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|unreachable|fetch failed/i.test(t)) return '这台机器上的账号服务没在运行，去「账号」页点「重新连接」。';
  if (/no xiaohongshu-mcp endpoint|no endpoint configured|还没有自己的/i.test(t)) return '这个账号还没连上小红书，去「账号」页完成连接和扫码登录。';
  if (/deadline exceeded|timed? ?out|timeout|aborted|超时/i.test(t)) return '小红书那边响应太慢，这次没成功，稍后会自动重试。';
  if (/筛选面板|筛选条件|找不到.*按钮|页面结构|selector|element not found/i.test(t)) return '小红书页面改版了，这次搜索没走通；系统已记录，稍后重试。';
  if (/rate ?limit|too many requests|429|频繁/i.test(t)) return '操作太频繁被小红书限流了，缓一会儿会自动恢复。';
  if (/笔记不可访问|内容不存在|已删除/i.test(t)) return '这条内容在小红书上已经看不到了（可能被删除或设为私密）。';
  if (/setup_incomplete|设置未完成/i.test(t)) return '门店设置还没完成，先去「设置」补齐。';
  if (/no results|没有结果|empty/i.test(t)) return '这次没有搜到符合条件的内容。';
  const cleaned = scrubInternals(t);
  if (/[一-鿿]/.test(cleaned)) return clip(cleaned, 60);
  return '这一步没执行成功，已记录下来。';
}

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities
// ─────────────────────────────────────────────────────────────────────────────

export const CAPABILITY_NAME: Record<XhsCapability, string> = {
  search_public_content: '搜索公开内容',
  read_public_post: '读取公开笔记',
  read_public_comments: '读取公开评论',
  read_public_profile: '读取公开主页',
  publish_content: '发布内容',
  read_engagement: '读取互动数据',
  read_notifications: '读取消息中心',
  receive_messages: '接收私信',
  send_messages: '发送私信',
  reply_comments: '公开回复评论',
};

/** What the store can actually do (or not) with this capability right now. */
const CAPABILITY_OK: Record<XhsCapability, string> = {
  search_public_content: '可以按关键词搜索小红书公开内容找客户',
  read_public_post: '可以读取公开笔记的正文和数据',
  read_public_comments: '可以读取公开笔记下的评论',
  read_public_profile: '可以查看客户的公开主页',
  publish_content: '可以直接发笔记（图文至少 1 张图，视频 1 个文件）',
  read_engagement: '可以读取自家笔记的点赞、收藏、评论数（小红书不给浏览量）',
  read_notifications: '可以读取消息中心：评论和@、赞和收藏、新增关注',
  receive_messages: '可以读取私信收件箱',
  send_messages: '可以用这个账号自己的登录状态发私信，发出后以会话里读回的消息为准',
  reply_comments: '可以在自家笔记下公开回复评论',
};

const CAPABILITY_OFF: Partial<Record<XhsCapability, string>> = {
  receive_messages: '小红书不开放私信收件箱读取，客户的回复需要你粘贴进系统',
  send_messages: '当前没有开启自动发私信，私信由销售本人发出后在系统里登记',
};

/**
 * The ten pre-send checks a draft DM goes through (ARCHITECTURE §6), named by what they protect the store from.
 * A page never prints the check's own identifier.
 */
const GUARD_CHECK: Record<string, string> = {
  ownership: '这个客户归不归这个号',
  negative_feedback: '他说过不想被打扰',
  previous_contact: '之前有没有联系过他',
  duplicate: '同一个人只发一次',
  account_health: '这个号的状态好不好',
  rate_limit: '今天发得太多了没有',
  factual_verification: '说的价格和车况对不对',
  platform_rules: '有没有踩小红书的规矩',
  approval_policy: '要不要你先看一眼',
  provider_capability: '这个号现在能不能发',
};

/** What a pre-send check looks at, in words a salesperson uses. Unknown checks are not printed raw. */
export function humanGuardCheck(check: string | null | undefined): string {
  const key = String(check ?? '').trim();
  return GUARD_CHECK[key] ?? '发送前检查';
}

/** One Chinese line for a capability row: what it means for the store, never the tool behind it. */
export function humanCapability(capability: string, status: CapabilityStatus, raw?: string | null): string {
  const cap = capability as XhsCapability;
  if (status === 'AVAILABLE') return CAPABILITY_OK[cap] ?? '可用';
  if (status === 'REQUIRES_AUTH') return '账号需要重新扫码登录，登录后这项就能用';
  if (status === 'REQUIRES_REVIEW') return '状态异常，需要人工确认后再用';
  const off = CAPABILITY_OFF[cap];
  if (off) return off;
  const t = String(raw ?? '');
  if (/unreachable|ECONNREFUSED|fetch failed/i.test(t)) return '连不上这个账号的服务，去「账号」页点「重新连接」';
  if (/not exposed|no endpoint|not configured|no xiaohongshu-mcp/i.test(t)) return '当前的接入方式没有这项能力';
  if (/simulation|synthetic/i.test(t)) return '演示数据源没有这项能力（只有真实账号才有）';
  return '当前不可用';
}

// ─────────────────────────────────────────────────────────────────────────────
// Who did it / what it was about
// ─────────────────────────────────────────────────────────────────────────────

/** Internal agent names → the role a dealer would recognise. */
const AGENT_LABEL: Record<string, string> = {
  'automotive-operator': 'AI 运营官',
  'research-agent': 'AI 市场研究',
  'account-strategy-agent': 'AI 账号策略',
  'content-agent': 'AI 内容',
  'content-review-agent': 'AI 内容审核',
  'publishing-agent': 'AI 发布',
  'lead-hunting-agent': 'AI 获客',
  'intent-detection-agent': 'AI 意向识别',
  'lead-research-agent': 'AI 线索研究',
  'lead-scoring-agent': 'AI 线索评分',
  'fleet-controller': 'AI 账号调度',
  'outreach-agent': 'AI 私信',
  'conversation-agent': 'AI 对话',
  'crm-agent': 'AI 客户管理',
  'analytics-agent': 'AI 数据分析',
  'optimization-agent': 'AI 策略优化',
};

export const humanAgent = (agent: string): string => AGENT_LABEL[agent] ?? 'AI';

/** `agent:outreach-agent` → AI 私信 · `operator:张三` → 张三 · `user:李四` → 李四 · `system` → 系统 */
export function humanActor(actor: string | null | undefined): string {
  const t = (actor ?? '').trim();
  if (!t) return '系统';
  const [kind, ...rest] = t.split(':');
  const name = rest.join(':').trim();
  if (kind === 'agent') return humanAgent(name);
  if (kind === 'operator' || kind === 'user') return name || '运营';
  if (kind === 'system' || t === 'system') return '系统';
  if (t === 'console' || kind === 'console') return '控制台操作';
  return scrubInternals(t) || '系统';
}

/** `post.published` → 发布了笔记. Unknown actions fall back to their own words without the dotted namespace. */
const ACTION_LABEL: Record<string, string> = {
  'post.published': '发布了笔记',
  'post.published_unreachable': '发布结果未知',
  'post.ready_to_publish': '笔记待人工发布',
  'post.images_updated': '更新了笔记配图',
  'post.video_updated': '更新了笔记视频',
  'post.note_id_conflict': '笔记ID重复',
  'vehicle.created': '新增了车型',
  'vehicle.updated': '修改了车型',
  'vehicle.deleted': '删除了车型',
  'vehicle.archived': '归档了车型',
  'vehicle.restored': '恢复了车型',
  'vehicle.imported': '批量导入车型',
  'vehicle.knowledge_generated': '生成了车型资料',
  'account.auth_synced': '检测了账号登录',
  'account.logged_out': '退出了账号登录',
  'account.login_qrcode_requested': '请求了登录二维码',
  'account.created': '添加了账号',
  'account.removed': '移除了账号',
  'lead.created': '新增线索',
  'lead.stage_changed': '线索阶段变化',
  'outreach.sent': '私信已发出',
  'outreach.sent_manually': '登记了人工发送',
  'outreach.approved': '私信已审核',
  'outreach.cancelled': '私信已取消',
  'notifications_synced': '同步了消息中心',
  'notification_replied': '回复了评论',
  'notification_handled': '处理了一条消息',
  'notification_ignored': '忽略了一条消息',
  'notification_promoted': '把消息转成了线索',
  'console.login': '登录了控制台',
  'account.voice_learned': '学习了账号的说话风格',
  'account.endpoint_set': '设置了账号的连接',
  'account.paused': '暂停了账号',
  'account.resumed': '恢复了账号',
  'dealer.updated': '修改了门店信息',
  'dealer.created': '新建了门店',
  'offer.created': '新增了优惠政策',
  'offer.updated': '修改了优惠政策',
  'inventory.updated': '改了库存',
  'dnc.added': '加入了不再联系名单',
  'lead.suppressed': '把客户加入不再联系',
  'lead.reassigned': '换了负责账号',
  'conversion.recorded': '登记了成交',
  'appointment.created': '登记了到店预约',
};

export function humanAction(action: string): string {
  if (ACTION_LABEL[action]) return ACTION_LABEL[action];
  const tail = action.split('.').slice(-1)[0] ?? action;
  return scrubInternals(tail.replace(/_/g, ' ')) || action;
}

export interface SubjectLink {
  label: string;
  href: string | null;
}

/**
 * What a decision or an event was about, as a name the store knows — the customer's nickname, the note's title, the
 * car's name — with a link to it. The internal row id is never part of the label.
 */
export function humanSubject(ctx: AppContext, type: string, id: string, dealerId: string | null): SubjectLink {
  const q = dealerId ? `?dealer=${encodeURIComponent(dealerId)}` : '';
  switch (type) {
    case 'lead': {
      const lead = ctx.db.table('leads').get(id);
      return { label: lead ? `客户 ${lead.username}` : '客户', href: lead ? `/leads/${lead.id}${q}` : null };
    }
    case 'outreach': {
      const row = ctx.db.table('outreach').get(id);
      const lead = row ? ctx.db.table('leads').get(row.lead_id) : undefined;
      return { label: lead ? `给 ${lead.username} 的私信` : '一条私信', href: lead ? `/leads/${lead.id}${q}` : null };
    }
    case 'conversation': {
      const conv = ctx.db.table('conversations').get(id);
      const lead = conv ? ctx.db.table('leads').get(conv.lead_id) : undefined;
      return { label: lead ? `与 ${lead.username} 的对话` : '一段对话', href: conv ? `/conversations/${conv.id}${q}` : null };
    }
    case 'post': {
      const post = ctx.db.table('posts').get(id);
      return { label: post ? `笔记「${clip(post.title || post.topic, 16)}」` : '一篇笔记', href: post ? `/content/posts/${post.id}${q}` : null };
    }
    case 'vehicle': {
      const veh = ctx.db.table('vehicles').get(id);
      return { label: veh ? `${veh.brand_zh}${veh.model_zh} ${veh.trim}` : '一个车型', href: veh ? `/vehicles/${veh.id}${q}` : null };
    }
    case 'xhs_account':
    case 'account': {
      const acc = ctx.db.table('xhs_accounts').get(id);
      return { label: acc ? `账号 ${acc.nickname}` : '一个账号', href: `/accounts${q}` };
    }
    case 'appointment': {
      const appt = ctx.db.table('appointments').get(id);
      const lead = appt ? ctx.db.table('leads').get(appt.lead_id) : undefined;
      return { label: lead ? `${lead.username} 的到店预约` : '一个到店预约', href: lead ? `/leads/${lead.id}${q}` : null };
    }
    case 'comment':
    case 'public_post':
      return { label: '一条公开内容', href: `/intel${q}` };
    case 'research_brief':
      return { label: '一份研究简报', href: `/intel${q}` };
    case 'xhs_notification':
      return { label: '一条小红书消息', href: `/conversations${q}` };
    case 'goal': {
      const goal = ctx.db.table('operator_goals').get(id);
      return { label: goal ? `目标「${clip(goal.text, 18)}」` : '一个经营目标', href: null };
    }
    case 'dealer': {
      const dealer = ctx.db.table('dealers').get(id);
      return { label: dealer ? dealer.name : '门店', href: `/setup${q}` };
    }
    case 'search_query':
    case 'query':
      return { label: '一个搜索词', href: `/intel${q}` };
    default:
      return { label: scrubInternals(type) || '系统', href: null };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data sources
// ─────────────────────────────────────────────────────────────────────────────

/** How the store should read "which data source am I on" — never the provider's internal name. */
export function humanProviderMode(mode: string): { label: string; note: string } {
  switch (mode) {
    case 'live':
      return { label: '真实账号', note: '所有内容来自你们自己登录的小红书账号' };
    case 'simulation':
      return { label: '演示数据', note: '这是演示语料，不是真实的小红书数据' };
    default:
      return { label: '未连接', note: '还没有连接小红书账号，系统不会搜索公开内容' };
  }
}

export function humanLlm(status: CapabilityStatus): { label: string; note: string } {
  if (status === 'AVAILABLE') return { label: 'AI 已启用', note: 'AI 写的内容一律要过事实核查，价格、参数、库存只能用车型库和门店数据' };
  return { label: 'AI 未启用', note: '当前由规则引擎工作：功能都在，文案不如开 AI 时灵活' };
}

/** `rules` / `llm` / `llm+rules` → what actually wrote it. */
export function humanEngine(engine: string): string {
  if (engine === 'rules') return '规则';
  if (engine === 'llm') return 'AI';
  if (engine === 'llm+rules') return 'AI＋规则';
  if (engine === 'human') return '人工';
  return scrubInternals(engine) || '规则';
}
