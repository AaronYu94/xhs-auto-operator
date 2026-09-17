/**
 * Deterministic purchase-intent NLU for public Xiaohongshu posts & comments (pure, no I/O).
 *
 * prefilter()          cheap gate: empty / pure praise / marketing / too short / no automotive signal
 * detectIntentRules()  evidence-preserving extraction of vehicle, location, budget, timeframe,
 *                      transaction questions, negative feedback, author role and purchase stage + strength.
 *
 * Strength anchors are binding for lead scoring (ARCHITECTURE §5):
 * awareness 0.1 · research 0.2 · comparison 0.4 · price_shopping 0.88 · active_shopping /
 * dealer_selection / purchase_imminent 1.0.
 * Author roles are binding (ARCHITECTURE §5.1): only askers can be purchase signals; owners, creators and
 * marketing accounts never are.
 * Every evidence `quote` is a verbatim substring of its source (analyzed text by default,
 * post title/content when `source_ref='post_context'`, the IP string when `source_ref='ip_location'`,
 * the author's nickname when `source_ref='author_nickname'`).
 */
import { dedupeEvidence } from '../../../core/evidence.ts';
import { clamp, formatCny, meaningfulChars, meaningfulLength, normalizeText, round } from '../../../core/text.ts';
import {
  PURCHASE_STAGES,
  TRANSACTION_QUESTIONS,
  type AuthorRole,
  type AutomotiveIntent,
  type DealerProfile,
  type Evidence,
  type IntentDetection,
  type PrefilterResult,
  type PurchaseStage,
  type SignalContext,
  type TransactionQuestion,
} from '../../../core/types.ts';
import {
  clauseAt,
  detectTimeframeMapped,
  findBrands,
  findFirst,
  findLocationsMapped,
  findMatches,
  findModels,
  findTrims,
  getBrandInfo,
  getModelInfo,
  isNegatedAt,
  isStandaloneRefusal,
  mapText,
  modelShortLabel,
  negationStart,
  parseBudgetMapped,
  provinceOfIp,
  rawSlice,
  type BudgetMention,
  type ExtraModel,
  type MappedText,
  type TextHit,
  type Timeframe,
  type TimeframeOptions,
} from '../../../domain/automotive-lexicon.ts';

export const STAGE_STRENGTH: Readonly<Record<PurchaseStage, number>> = {
  awareness: 0.1,
  research: 0.2,
  comparison: 0.4,
  price_shopping: 0.88,
  active_shopping: 1,
  dealer_selection: 1,
  purchase_imminent: 1,
};

/** -1 for "no stage", else index in PURCHASE_STAGES. */
export function stageIndex(stage: PurchaseStage | null | undefined): number {
  return stage ? PURCHASE_STAGES.indexOf(stage) : -1;
}

export const PREFILTER_REASONS = ['empty_or_emoji', 'pure_praise', 'marketing_account', 'too_short', 'no_signal', 'keyword_hit'] as const;
export type PrefilterReason = (typeof PREFILTER_REASONS)[number];

/** Speakers that are never acquisition leads (ARCHITECTURE §5.1). */
export const NON_BUYER_ROLES: ReadonlySet<AuthorRole> = new Set<AuthorRole>(['owner', 'creator', 'marketing']);

export function isNonBuyerRole(role: AuthorRole | null | undefined): boolean {
  return !!role && NON_BUYER_ROLES.has(role);
}

/** Optional runtime context for rules detection: `now` / `tz` place calendar expressions ('9月底', '国庆前'). */
export type IntentRuleOptions = TimeframeOptions;

const PREFILTER_LABELS: Record<Exclude<PrefilterReason, 'keyword_hit'>, string> = {
  empty_or_emoji: '空内容/仅表情',
  pure_praise: '纯夸赞，无购车意图',
  marketing_account: '营销/同行账号话术',
  too_short: '内容过短',
  no_signal: '无购车相关信号',
};

/**
 * Evidence code + salesperson label for each transaction question. The code IS the TransactionQuestion value,
 * so a detection persisted as evidence (lead_signals) round-trips exactly through lead scoring's
 * `detectionFromSignal`, which counts questions from evidence codes equal to TRANSACTION_QUESTIONS values.
 */
export const QUESTION_EVIDENCE: Readonly<Record<TransactionQuestion, { code: TransactionQuestion; label: string }>> = {
  price: { code: 'price', label: '询问价格' },
  landing_price: { code: 'landing_price', label: '询问落地价' },
  discount: { code: 'discount', label: '询问优惠' },
  inventory: { code: 'inventory', label: '询问现车' },
  color_trim_availability: { code: 'color_trim_availability', label: '询问指定颜色/配置车源' },
  finance: { code: 'finance', label: '询问贷款/金融方案' },
  lease: { code: 'lease', label: '询问租赁方案' },
  trade_in: { code: 'trade_in', label: '询问置换' },
  dealer_location: { code: 'dealer_location', label: '咨询去哪家店买' },
  test_drive: { code: 'test_drive', label: '想到店看车' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary (patterns run against normalized text: NFKC + lower-case)
// ─────────────────────────────────────────────────────────────────────────────

const PRICE_RE =
  /多少钱|什么价|啥价|价格|报价|价位|价钱|售价|裸车价?|卖多少|多少米|贵不贵|指导价|几个w|多少w|(?<![优惠落地便宜降让补贴首付月供利率等航耗间里度了力矩寸距池保养钱速量压重宽长径温噪积容])多少(?!钱|公里|km|度|个|天|年|久|岁|人|次|级|分|秒|期|%|台|辆|现车|库存|颜色|种|款|配置|优惠|折扣|油|电|续航|空间|马力|首付|月供|定金|订金|利息)/;
/** A bare '多少' after a spec / finance term asks about that term ('油耗大概多少', '利率多少'), not the car price. */
const SPEC_BEFORE_AMOUNT_RE =
  /(?:油耗|电耗|能耗|续航|加速|马力|扭矩|功率|轴距|尺寸|长宽高|后备箱|容积|重量|电池|电量|充电|保养|利率|利息|月租|租金|残值|尾款|里程|公里|排量|座位|屏幕|胎压|噪音|分贝)[^,。!?\n]{0,4}$/;
const LANDING_RE = /落地(?!窗|灯|扇|页|生根|执行)/;
const DISCOUNT_RE =
  /优惠|折扣|打折|便宜多少|能便宜|便宜点|便宜吗|便宜些|让利|降价|降了多少|降多少|砍价|底价|最低价|团购|促销|有什么政策|啥政策|什么政策|政策怎么样/;
const SUBSIDY_RE = /国补|地补|补贴/;
/**
 * Stock / pickup-wait questions. '有没有车主' / '有没有车友' ask for people, not stock; a pickup that already happened
 * ('朋友刚提车了', '提车日记') is not a question about when the author can pick one up.
 */
const INVENTORY_RE =
  /有现车|现车|现货|有车吗|有没有车(?![主友评险贷位牌型展膜衣])|库存|(?<!刚|已经|已|喜)提车(?!了|啦|日记|记|作业|vlog|视频|现场|仪式)|要等多久|等多久|多久能提|多久提|几天能提|能提车|有货|车源|排产|交付周期|到港|在途/;
const INVENTORY_CONTEXTUAL_RE = /还在吗|在吗|还有吗|还有没有|还有货/;
const VEHICLE_REF_RE = /车|台|辆|款|色|配置|型号|这个|那个/;
/**
 * '有没有/还有' only ask about a car when not followed by an offer/finance object ('有没有优惠' is a discount question)
 * or by people ('有没有车主说说', '有车主吗').
 */
const AVAILABILITY_ASK_RE =
  /有吗|有没有(?![优折活政补礼赠送便团金贷分置试推人什啥其别问]|车[主友评险贷])|还有(?![优折活政补礼赠送便团金贷分置试推人什啥其别问点些])|有货|有车(?![主友评险贷位牌])|现车|能订|能提|可以订|有现/;
const COLOR_COMBO_RE = /([白黑灰蓝红棕银绿金紫橙黄青米咖])色?外饰?[ +/、,和]?([白黑灰蓝红棕米咖驼])色?内饰?/;
const COLOR_SINGLE_RE =
  /[白黑灰蓝红棕银绿金紫橙黄青咖]色(?!调|系列|幽默|牌|车牌|出行|能源|环保|通道|健康|食品)|矿石白|碳黑|曜夜黑|冰川灰|布鲁克林灰|波尔蒂芒蓝|珍珠白|星空灰|天际灰/;
const FINANCE_RE = /贷款|车贷|分期|首付|月供|利率|0息|零息|免息|低息|贴息|金融方案|金融政策|金融|按揭/;
const FULL_PAYMENT_RE = /全款|一次性付清|付全款/;
const LEASE_RE = /融资租赁|以租代购|租赁|租购|长租/;
const TRADE_IN_RE = /以旧换新|置换|旧车|换购|估个价|二手车评估|旧车估价/;
/**
 * "finance/lease/trade-in specifics" (ARCHITECTURE §5 active_shopping): a concrete programme detail rather than
 * a yes/no 'can I get a loan'. Generic questions stay price_shopping, like an unspecific discount question.
 */
const CN_COUNT = '(?:\\d{1,2}|[一二三四五六七八九十两]{1,3})';
const FINANCE_DETAIL_RE = new RegExp(`首付|月供|利率|利息|0息|零息|免息|低息|贴息|金融方案|金融政策|${CN_COUNT}期|几期|多少期|期数|尾款`);
const LEASE_DETAIL_RE = new RegExp(`月租|租金|残值|尾款|首付|月供|方案|${CN_COUNT}(?:年|个月|期)`);
const TRADE_IN_DETAIL_RE = /补贴|估价|评估|估个价|能抵|抵多少|作价|残值|旧车是|开了|(?:\d{2,4}|[一二三四五六七八九十两]{1,3}) *年的?|公里/;
const DEALER_LOCATION_RE =
  /哪家店|哪个店|哪家4s|哪个4s|哪(?:家|个)[^,。!?\n]{1,6}?(?:4s店?|门店|经销商|店)|哪家好|哪家靠谱|哪里买|在哪买|去哪买|哪儿买|在哪里买|推荐销售|推荐个销售|推荐一下销售|推荐.{0,4}?(?:店|销售)|(?:门店|店|销售|顾问)推荐|靠谱的[^,。!?\n]{0,6}?(?:店|销售|顾问)|店在哪|地址在哪|4s店推荐|有没有推荐的店/;
const VISIT_RE =
  /试驾|到店(?!价)|去店里|去4s|来店|看车|去看看|过去看|去看一下|去瞅瞅|看看实车|看实车|摸摸车|试坐|试一下车|(?:去|来|过去|过来)看(?:一下|一眼)?(?=[^,。!?]{0,3}?(?:车|[a-z0-9]|宝马|实物))/;
const TEST_DRIVE_WORD_RE = /试驾|试坐|试一下车/;
const COMMITMENT_RE =
  /准备下定|准备下订|打算下定|准备订车|准备提车|去提车|交定金|付定金|下定金|要下定|可以下定|马上下定|直接下定|定下来|订下来|(?:这周|本周|周末|明天|今天|后天|下周)(?:就)?(?:去)?提(?:车)?(?!到|问|醒|供|前|出|议|交|示|高|升|速|心)/;
const DESIRE_RE = /想买|被种草|种草|心动|想入手|想要一台|想要一辆|好想要|想换|打算买|准备买|考虑买|计划买|梦中情车|攒钱买|等我有钱|入手/;
const RESEARCH_RE =
  /后排|空间|续航|油耗|电耗|能耗|质量|保养|值得买|值不值|值得入手|怎么样|咋样|靠谱吗|靠谱不|口碑|缺点|优点|配置|动力|加速|底盘|隔音|舒适|车机|充电|保值|毛病|通病|故障|好开|推荐吗|能买吗|好不好|安全性|智驾|辅助驾驶|内饰|做工|后备箱|尺寸|轴距|掉电|电池|质保|耐用|可靠|操控|区别|差别|参数|如何/;
const SCENARIO_RE =
  /买什么车|什么车好|推荐什么车|选什么车|买啥车|第一次买车|首台车|第一台车|准备换车|想换车|换什么车|suv推荐|车推荐|推荐一款|推荐一台|推荐一辆/;
const COMPARISON_RE = /还是|vs|对比|纠结|选哪个|选哪台|选哪辆|哪个好|哪个更|怎么选|二选一|pk|比较|选谁|买哪个|相比|比起|(?:和|跟|与).{1,14}?比/;
const VERSUS_RE = /vs|对比|pk|相比|比起|(?:和|跟|与).{1,14}?比/;
const HIGH_PRICE_SENSITIVITY_RE = /砍价|底价|最低价|便宜点|再便宜|能便宜|性价比|划算|太贵|贵了|预算有限|钱不多|能省/;
const LOW_PRICE_SENSITIVITY_RE = /不差钱|价格无所谓|不在乎价格|不看价格|预算充足/;
/**
 * A question or request form. Product-topic words ('后排', '续航') only make a research signal when asked about.
 * '几点感受 / 几点建议' are "a few points", not "what time".
 */
const QUESTION_RE =
  /[?]|吗|呢|多少|几(?:个|台|辆|月|天|号|点(?!感受|建议|体会|心得|注意|看法|经验|总结|想法|说明|区别|优点|缺点|真实|个人)|万|年|种|家|期)|怎么|咋|如何|哪|啥|什么|有没有|能不能|可不可以|是不是|是否|请问|求问|求助|求推荐|值不值|好不好|行不行/;
/**
 * A visit that already happened ('试驾了两天', '试驾过', '上周试驾了i3') is not a request to visit. A sentence-final 了
 * after a plan ('准备这周去试驾了') still announces a visit.
 */
const VISIT_DONE_AFTER_RE = /^(?:过(?!来|去)|完)/;
const VISIT_PLAN_BEFORE_RE = /准备|打算|要|想|计划|这周|本周|明天|后天|周末|下周|马上|快|约|预约|等/;
/** The price / stock / where-to-buy question is about something other than a car ('博主这件外套哪里买的'). */
const NON_VEHICLE_OBJECT_RE =
  /外套|衣服|上衣|裙子|裤子|鞋子|包包|帽子|眼镜|墨镜|口红|香水|耳环|项链|手表|手机(?!号|钥匙|互联|映射|app)|手机壳|t恤|卫衣|发型|美甲|滤镜|相机|镜头|咖啡|这件|这双|这条裙/;

/**
 * Explicit do-not-contact / refusal phrasing. '别' is not the second character of a word ('区别发…', '特别发…'),
 * '发' is not the start of an unrelated verb ('别发愁', '发动机').
 */
const HARD_NEGATIVE_RE =
  /(?<![区差识分级类性告特派辨鉴个])别再?(?:给我|跟我)?(?:发(?!愁|呆|火|现|动|展|挥|布|表|票|货|型|音|生|烧|光|芽|酵|育)|私信|推送|打电话|联系|打扰|骚扰|烦我)|(?:不要|请勿|勿|不用)(?:再(?:给我|跟我)?(?:发|私信|推送|打电话|联系|打扰|骚扰)|(?:给我|跟我)?(?:发(?:了|消息|信息|私信)|私信我|推送|打电话|联系我|打扰|骚扰))|拉黑|举报|骚扰|退订/;
/** 'not interested' only counts without an object of its own ('对这个不感兴趣' yes, '对SUV没兴趣' no). */
const DISINTEREST_RE = /不感兴趣|没兴趣|没有兴趣/;
/** Already bought / picked up — but never a question to the poster ('提车了吗', '已经买了没'). */
const PURCHASED_RE =
  /(?:(?:已经|已|刚刚|刚)(?:买|订|下定|下订|入手|交了定金|付了定金)(?!到|问|醒|供|前|出|议|示|高|升|速|心|价|款|不起|菜|票|房)|(?:已经|已|刚刚|刚)提(?:了|车|完|回|走|的车|的(?=[a-z0-9]|宝马))|提车了|提完车|喜提|提车作业|提车日记|提车(?:[一两三四五六七八九十半]|\d+)个?(?:月|年|周|天))(?![吗么嘛没?]|了吗|了么|了没|车了吗|车了没)/;
/**
 * Someone else as the subject of a purchase cue in the same clause ('朋友已经提了i3', '陪朋友去提车了'). A vocative
 * address ('姐妹们，', '家人们谁懂啊，提车了') is not a subject: the author is still the one who bought.
 */
const OTHER_SUBJECT_RE =
  /(?:朋友|同事|老公|老婆|媳妇|对象|家人|家里人|邻居|同学|闺蜜|别人|室友|领导|亲戚|哥哥|姐姐|弟弟|妹妹|我哥|我姐|我弟|我妹|老爸|老妈|爸爸|妈妈|我爸|我妈|(?<!其)他|她)(?!们)/;
const SOFT_NEGATIVE_RE = /不需要|不用了|暂不考虑|不考虑了?|不买了|不想买了|不打算买了?|没打算买|放弃了|不要了|买不起/;

const MARKETING_STRONG_RE =
  /有需要的|需要的朋友|需要的姐妹|需要的宝子|需要的私|有意向的朋友|有意向的可以|欢迎到店|欢迎咨询|欢迎来店|(?<!租)代购|收车|高价回收|二手车商|车商|我是.{0,8}(?:4s店?|车行|汽车|门店|店)的?.{0,3}(?:销售|顾问)|本人(?:是)?.{0,6}(?:4s店?|车行|汽车|门店|店)的?.{0,3}(?:销售|顾问)|包上牌|全网最低|点击主页|看主页|主页有|到店有惊喜|底价私聊|4s店销售/;
/** Buyers also write '找我老婆商量' / '联系我了' / '微信转账'; those are not solicitation. */
const MARKETING_WEAK_RE =
  /私信我|私我|找我(?!老|家|对象|媳|爸|妈|男|女|朋友|同事|们|儿|闺|哥|姐|弟|妹|领导)|加我|联系我(?!了|过|说|们)|私聊|微信(?!支付|付款|转账|付|提现|小程序|公众号|视频号)|vx|加v|v我|威信|薇信/;
const BUYER_REQUEST_BEFORE_RE = /(?:求|麻烦|请|可以|能不能|能|谁|哪位|哪个|哪家|推荐|有没有人?|方便|认识|别|不要|不找|不是)[^,。!?]{0,3}$/;
const BUYER_AFTER_SALES_RE = /^(?:靠谱|推荐|吗|\?|怎么样|电话|联系方式)/;

// ── author roles (ARCHITECTURE §5.1) ─────────────────────────────────────────

/**
 * Creator / informational voice that settles the role on its own (a creator who also asks a first-person buying
 * question stays an asker): guides, reviews, hauls, audience address ('给大家', '姐妹们注意', '评论区聊聊').
 */
const CREATOR_STRONG_RE =
  /攻略|测评|评测|实拍|合集|干货|一次说清|说清楚了|必看|避坑|科普|探店|整理(?:了|好)|清单|汇总|给大家|帮大家|和大家|跟大家|粉丝(?:问|私信|留言|催)|被问(?:最多|了很多|爆|到)|深度对比|横评|我的建议|给[^,。!?\n]{0,8}(?:朋友|姐妹|宝子|小伙伴)们?(?:一些|点)?(?:参考|建议)|(?:朋友|姐妹|宝子|小伙伴|家人)们?(?:注意|记得|一定要|可以冲|看过来|先想清楚)|看过来|评论区(?:聊聊|留言|见|问我|扣|告诉我|交流)|建议收藏|码住/;
/** Creator voice that a buyer can also use ('想去试驾体验', '分享下预算求推荐'): overridden by a transaction question. */
const CREATOR_WEAK_RE =
  /(?<![想要去能])体验(?!店|中心|馆|卡|券|官|一下)|分享(?!一下(?:吗|呗|呀|嘛)|下(?:吗|呗|嘛))|(?:开|试驾|试)了(?:一|两|三|几|\d+)?个?(?:周末|周|星期|天)|几点(?:真实)?感受|说几点|思路/;
/** Advice to someone else in a reply ('建议到店问清楚', '推荐去试驾对比下'), only counted when the text asks nothing. */
const ADVICE_RE =
  /建议(?:你|您|大家|直接|先|提前|到店|去|多|还是|找)|推荐(?:你|您|大家)?去(?:试驾|店里|看|问|对比)|可以(?:多|去)(?:跑|看|问|对比|试驾|比)|记得(?:多|去|先)(?:比|问|看|试)|一定要(?:试驾|去|多|问|对比)/;
/** Nickname hints for creator accounts. */
const CREATOR_NICK_RE = /测评|评测|攻略|探店|车评|说车|聊车|买车指南|选车指南|购车指南|汽车博主|车博主|研究所/;
/** Purchase already completed, stated by the author (in addition to PURCHASED_RE). */
const OWNER_TEXT_RE =
  /终于提(?:车)?(?:啦|了)|提车啦|已提车|提车(?:记|vlog)|(?:开|用)了(?:[一两三四五六七八九十]|\d+|半|大半|快|将近|差不多)?个?多?(?:月|年)(?!前|后|内|以内|以后)|提车(?:[一两三四五六七八九十半几]|\d+)个?多?(?:月|年|周|天)|(?:我是|我也是|本人是?|作为|身为|已经是)[^,。!?\n]{0,8}?车主|车主一枚|老车主|人生第一台[^,。!?\n]{0,10}?(?:提|入手|买)|(?<!想|要|准备|打算|决定|计划|考虑|可以|能|该|快)入手(?:了|啦)(?![吗么没?])|(?:在|去)[^,。!?\n]{1,8}?(?:店|4s|家)提(?:了|的)/;
/** Owner cues inside a clause about the car being traded in describe the OLD car ('旧车开了五年'). */
const TRADE_IN_CLAUSE_RE = /旧车|老车|现在的车|现在开的|目前开的|手上的车|手里的车|置换/;
/** A future owner ('我是准车主', '作为未来车主') is still buying. */
const FUTURE_OWNER_RE = /准车主|未来车主|想当车主|准备当车主|即将成为[^,。!?\n]{0,6}车主|快要成为[^,。!?\n]{0,6}车主|潜在车主/;
/**
 * The author wants to buy (again): with a question it overrides owner cues ('租了一辆i3开了一个月，想买了，现车多少钱').
 * Not an invitation to readers ('想买的姐妹问我') and not a past wish ('当初也想买X3' — checked in code).
 */
const BUY_DESIRE_RE =
  /(?:想|打算|准备|计划|决定)(?:再|要)?(?:买|入手|换|提|订|定)(?!的(?:朋友|姐妹|宝子|小伙伴|人|家人|话)|的?可以|过)/;
const PAST_DESIRE_BEFORE_RE = /(?:当初|当时|之前|本来|原本|一开始|那时|以前|曾经)[也还都就]?$/;
/** The wanted purchase is an accessory or service, not a car ('提车半年了，打算买个充电桩'). */
const NON_CAR_PURCHASE_AFTER_RE = /^.{0,4}?(?:充电桩|保险|车险|贴膜|车膜|车衣|脚垫|轮胎|轮毂|配件|记录仪|座套|香薰|挂件|车模|会员|保养|套餐|延保)/;
/** A first-person dilemma ('还是纠结', '一直犹豫'): with a question it is a buying question, not creator content. */
const SELF_DILEMMA_RE = /(?:纠结|犹豫|拿不定主意|选择困难)(?!的(?:朋友|姐妹|宝子|小伙伴|人|家人|你|宝宝)|党)/;
/**
 * A creator word the author asks FOR ('求分享', '有没有攻略？', '怎么避坑？') is a request, not informational content.
 * Checked in the cue's clause: a request word before it, or a question particle right after it. '教你怎么避坑' informs.
 */
const CREATOR_REQUEST_BEFORE_RE =
  /求|有没有|有无|哪里有|哪儿有|哪有|谁有|(?<!教你|教大家|告诉你|告诉大家|带你看|看看)(?:怎么|怎样|如何)|有什么|有啥|能不能|可不可以|麻烦|请(?:问|教|帮|分享|推荐)/;
const CREATOR_REQUEST_AFTER_RE = /^[^,。!?\n]{0,3}?(?:[?]|吗|么|呢)/;
const OWNER_NICK_RE = /车主|提车日记|提车记|用车日记|用车记/;
const NOT_OWNER_NICK_RE = /准车主|未来车主|想当车主|准备当车主|车主之家|车主指南/;
/** Nickname hints for dealer-sales / trade accounts (content-level solicitation is detected by the prefilter). */
const MARKETING_NICK_RE =
  /4s店?|(?:汽车|购车|卖车|宝马|奔驰|奥迪|特斯拉|比亚迪|蔚来|理想|问界|丰田|本田|大众|别克|凯迪拉克|沃尔沃|雷克萨斯|保时捷|路虎)(?:销售|顾问)|销售顾问|汽车经纪|车行|车商|二手车|收车|代购|销售[^a-z0-9]{0,6}(?:宝马|奔驰|奥迪|特斯拉|比亚迪)/;
/** A first-person buying request: keeps a creator- or owner-looking author an asker. */
const ASKER_SELF_RE =
  /求推荐|求助|求问|求建议|求指点|求解答|求[^,。!?\n]{0,10}?攻略|帮我(?:选|看|参谋|推荐|分析)|帮忙(?:选|看|参谋|推荐|分析)|给点建议|有没有(?:懂车的|懂的|车主|大佬|姐妹|宝子|人)(?:说说|帮|推荐|知道|分享)|求[^,。!?\n]{1,14}?推荐|我(?:也|们家|家)?(?:想|打算|准备|计划|在考虑|正在考虑|考虑)要?(?:买|入手|换|提|订|定|选)/;
/** An owner shopping for another car ('我是车主，想给老婆再买一台X3'). */
const REPEAT_PURCHASE_RE =
  /换车|换一台|换台|换辆|换个车|增购|再买|再入手|再添|再提|再订|第二台|第二辆|二台车|加一台|给(?:老婆|老公|媳妇|家里|爸妈|父母|孩子|女儿|儿子|我妈|我爸|对象)再?(?:买|换|提|选|入)|想换|准备换|打算换/;

const AUTOMOTIVE_TERMS_RE =
  /买车|看车|提车|现车|这车|这台车|这款车|这辆车|车型|新车|电车|油车|车贷|选车|换车|购车|订车|定车|试驾|4s|落地价|裸车|续航|油耗|电耗|充电桩|suv|轿车|新能源|混动|增程|纯电|车主|车况|车源|车子|汽车|座驾|车价|车友|车身|车漆|车机|后备箱|底盘|变速箱|发动机|轮毂|排量|马力/;
/** Generic purchase language: only a signal when the text or its post context is automotive. */
const PURCHASE_TERM_RES: readonly RegExp[] = [
  PRICE_RE,
  LANDING_RE,
  DISCOUNT_RE,
  SUBSIDY_RE,
  INVENTORY_RE,
  INVENTORY_CONTEXTUAL_RE,
  COLOR_COMBO_RE,
  COLOR_SINGLE_RE,
  HARD_NEGATIVE_RE,
  DISINTEREST_RE,
  PURCHASED_RE,
  SOFT_NEGATIVE_RE,
  FINANCE_RE,
  FULL_PAYMENT_RE,
  LEASE_RE,
  TRADE_IN_RE,
  DEALER_LOCATION_RE,
  VISIT_RE,
  COMMITMENT_RE,
  DESIRE_RE,
  RESEARCH_RE,
  SCENARIO_RE,
];

const PRAISE_TOKENS = [
  '帅', '好帅', '太帅了', '真帅', '帅气', '帅炸', '好看', '漂亮', '美', '好美', '太美了', '绝美', '绝了', '绝绝子', '爱了', '哈', '哈哈',
  '哈哈哈', '羡慕', '慕了', '酸了', '蹲', '蹲一个', '蹲蹲', 'mark', '码住', '马住', '沙发', '打卡', '路过', '同款', '心动', '好家伙',
  '牛', '牛逼', 'nb', '666', '66', '6', 'yyds', '赞', '点赞', '酷', '拉风', '好车', '喜欢', '好喜欢', '霸气', '优雅', '高级', '质感',
  '大气', '顶', '前排', '支持', '太棒了', '棒', '厉害', '学到了', '收藏', '收藏了', '已关注', '关注了', '感谢分享', '谢谢分享', '可爱',
  '惊艳', '神车', 'wow', '哇塞', '真香',
];
const FILLER_TOKENS = [
  '啊', '呀', '哇', '哦', '噢', '呢', '吧', '嘛', '了', '的', '啦', '耶', '呜', '嘿', '嗯', '哎', '唉', '真', '真的', '太', '超', '超级',
  '好', '很', '也', '我', '你', '这', '这个', '这车', '车', '车子', '这台', '这辆', '颜值', '外观', '颜色', '简直', '就是', '是', '最',
  '宝', '姐妹', '家人们', '博主', '楼主', '一个', '个', '还', '挺', '蛮', '有点', '这么', '那么', '款', '真是', '实在', '不错',
];
const PRAISE_SET = new Set(PRAISE_TOKENS);
const TOKEN_LIST = [...new Set([...PRAISE_TOKENS, ...FILLER_TOKENS])].sort((a, b) => b.length - a.length);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const uniq = (xs: readonly string[]) => [...new Set(xs.filter((x) => x.trim().length > 0))];
const lower = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');

/** Verbatim prefix (≤ max code points) of the trimmed raw text, for "whole comment" evidence. */
function textQuote(raw: string, max = 60): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  return Array.from(t).slice(0, max).join('');
}

/** The text that is analyzed for a signal: posts are analyzed as title + '\n' + content. */
export function analyzedTextFor(text: string, context?: SignalContext): string {
  if (context?.source_type !== 'post') return text;
  const title = (context.post_title ?? '').trim();
  if (!title) return text;
  if (normalizeText(text).includes(normalizeText(title))) return text;
  return text.trim() ? `${title}\n${text}` : title;
}

function contextTextFor(context?: SignalContext): string {
  if (!context || context.source_type === 'post') return '';
  return [context.post_title, context.post_content].filter((x): x is string => typeof x === 'string' && x.trim().length > 0).join('\n');
}

function contextIsAutomotive(context?: SignalContext): boolean {
  const ctxText = contextTextFor(context);
  if (!ctxText) return false;
  if (findModels(ctxText).length > 0 || findBrands(ctxText).length > 0) return true;
  return findFirst(mapText(ctxText), AUTOMOTIVE_TERMS_RE) !== null;
}

/** Whole comment consists only of praise/noise tokens (after stripping emoji & punctuation). */
export function isPurePraise(text: string): boolean {
  const chars = meaningfulChars(text);
  if (!chars) return false;
  // reachable[i] = 0 unreachable, 1 reachable without praise, 2 reachable with ≥1 praise token
  const reach = new Array<number>(chars.length + 1).fill(0);
  reach[0] = 1;
  for (let i = 0; i < chars.length; i++) {
    if (reach[i] === 0) continue;
    for (const tok of TOKEN_LIST) {
      if (!chars.startsWith(tok, i)) continue;
      const next = i + tok.length;
      const state = reach[i] === 2 || PRAISE_SET.has(tok) ? 2 : 1;
      if (state > reach[next]) reach[next] = state;
    }
  }
  return reach[chars.length] === 2;
}

function marketingHits(mt: MappedText): TextHit[] {
  const hits: TextHit[] = [];
  const exempt = (h: TextHit) => BUYER_REQUEST_BEFORE_RE.test(mt.norm.slice(Math.max(0, h.start - 6), h.start));
  for (const h of findMatches(mt, MARKETING_STRONG_RE)) {
    if (h.text === '4s店销售' || h.text === '车商') {
      if (exempt(h) || BUYER_AFTER_SALES_RE.test(mt.norm.slice(h.end, h.end + 4))) continue;
    } else if (/(?:别|不要|不找|不是)[^,。!?]{0,3}$/.test(mt.norm.slice(Math.max(0, h.start - 5), h.start))) continue;
    hits.push(h);
  }
  for (const h of findMatches(mt, MARKETING_WEAK_RE)) {
    if (exempt(h)) continue;
    hits.push(h);
  }
  return hits.sort((a, b) => a.start - b.start);
}

function prefilterMapped(mt: MappedText, context?: SignalContext): PrefilterResult {
  const raw = mt.raw;
  const fail = (reason: PrefilterReason, hits: string[] = [], is_marketing = false): PrefilterResult => ({
    passed: false,
    reason,
    hits,
    is_marketing,
  });
  const len = meaningfulLength(raw);
  if (len === 0) return fail('empty_or_emoji');
  const marketing = marketingHits(mt);
  if (marketing.length > 0) return fail('marketing_account', uniq(marketing.map((h) => h.quote)), true);
  if (isPurePraise(raw)) return fail('pure_praise');

  const ctxText = contextTextFor(context);
  const entity = [...findModels(raw, { context: ctxText }).map((m) => m.quote), ...findBrands(raw).map((b) => b.quote)];
  const automotive = [...findMatches(mt, AUTOMOTIVE_TERMS_RE), ...findMatches(mt, SCENARIO_RE)].map((h) => h.quote);
  const purchase = PURCHASE_TERM_RES.flatMap((re) => findMatches(mt, re).map((h) => h.quote));
  const trims = findTrims(raw).map((t) => t.quote);
  const budget = parseBudgetMapped(mt);
  if (budget) purchase.push(budget.quote);
  purchase.push(...trims);

  const strong = [...entity, ...automotive];
  const passes = strong.length > 0 || (purchase.length > 0 && contextIsAutomotive(context));
  if (!passes) return fail(len <= 1 ? 'too_short' : 'no_signal');
  return { passed: true, reason: 'keyword_hit', hits: uniq([...strong, ...purchase]), is_marketing: false };
}

/**
 * Cheap gate before intent detection (pure). Content-only: nickname hints (dealer-sales / creator / owner accounts)
 * are applied by `detectIntentRules`, which sets `author_role` and `is_marketing`.
 */
export function prefilter(text: string, context?: SignalContext): PrefilterResult {
  return prefilterMapped(mapText(analyzedTextFor(text, context)), context);
}

interface ModelMention {
  brand: string;
  model: string;
  quote: string;
  source: 'text' | 'trim' | 'post_context';
}

interface KeywordState {
  hit: TextHit | null;
  negated: TextHit | null;
}

function keywordState(mt: MappedText, re: RegExp, negatable: boolean, accept: (h: TextHit) => boolean = () => true): KeywordState {
  let negated: TextHit | null = null;
  for (const h of findMatches(mt, re)) {
    if (!accept(h)) continue;
    if (negatable && isNegatedAt(mt, h.start)) {
      negated ??= h;
      continue;
    }
    return { hit: h, negated };
  }
  return { hit: null, negated };
}

/** Quote for a negated keyword including its negator ('不需要贷款'). */
function negatedQuote(mt: MappedText, hit: TextHit): string {
  const s = negationStart(mt, hit.start);
  return rawSlice(mt, s ?? hit.start, hit.end);
}

/** Salesperson label for a stated location relative to the dealer ('本地买家（杭州）', '同省买家（宁波）', '所在地（深圳）'). */
export function locationLabel(loc: { city?: string; province?: string }, dealer?: DealerProfile): string {
  if (loc.city) {
    if (dealer && loc.city === dealer.city) return `本地买家（${loc.city}）`;
    if (dealer && loc.province === dealer.province) return `同省买家（${loc.city}）`;
    return `所在地（${loc.city}）`;
  }
  if (dealer && loc.province === dealer.province) return `同省买家（${loc.province}）`;
  return `所在地（${loc.province}）`;
}

const placeName = (s: string | undefined) => (s ?? '').replace(/(省|市)$/, '');

/**
 * The stated location a signal is scored with. With several places ('人在上海工作，想回杭州买i3') the one related to
 * the dealer wins — its city, else its province — so a buyer is only treated as out of area (§5.2) when EVERY stated
 * place is outside the dealer's province. Without a dealer: the first city, else the first province.
 */
function pickStatedLocation<T extends { city?: string; province?: string }>(all: readonly T[], dealer?: DealerProfile): T | undefined {
  if (dealer && all.length > 1) {
    const city = all.find((l) => !!l.city && placeName(l.city) === placeName(dealer.city));
    if (city) return city;
    const province = all.find((l) => !!l.province && placeName(l.province) === placeName(dealer.province));
    if (province) return province;
  }
  return all.find((l) => l.city) ?? all[0];
}

function budgetLabel(b: BudgetMention): string {
  if (b.budget_min !== undefined && b.budget_max !== undefined) {
    return b.budget_min === b.budget_max
      ? `预算 ${formatCny(b.budget_min)}`
      : `预算 ${formatCny(b.budget_min)}-${formatCny(b.budget_max)}`;
  }
  if (b.budget_max !== undefined) return `预算 ${formatCny(b.budget_max)}以内`;
  return `预算 ${formatCny(b.budget_min ?? 0)}以上`;
}

const TIMEFRAME_LABELS: Record<Timeframe, [string, string]> = {
  this_week: ['本周内有购车计划', '计划本周到店'],
  soon: ['近期购车', '近期计划到店'],
  this_month: ['本月内购车', '本月内计划到店'],
  within_3_months: ['三个月内购车', '三个月内计划到店'],
  later: ['购车时间较晚（观望）', '购车时间较晚（观望）'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Rules engine
// ─────────────────────────────────────────────────────────────────────────────

export interface SignalAnalysis {
  /** exact text the evidence quotes refer to (title + '\n' + content for posts) */
  analyzed_text: string;
  prefilter: PrefilterResult;
  detection: IntentDetection;
}

interface RoleCue {
  quote: string;
  fromNickname: boolean;
}

export function analyzeSignal(text: string, context?: SignalContext, dealer?: DealerProfile, opts: IntentRuleOptions = {}): SignalAnalysis {
  const analyzed = analyzedTextFor(text, context);
  const mt = mapText(analyzed);
  const pf = prefilterMapped(mt, context);
  const evidence: Evidence[] = [];
  const intent: AutomotiveIntent = {};
  const inferred: string[] = [];

  const ctxText = contextTextFor(context);
  const dealerBrand = dealer && dealer.brands.length > 0 ? dealer.brands[0] : '';
  const extraModels: ExtraModel[] = dealer
    ? dealer.models.filter((m) => !getModelInfo(m)).map((m) => ({ brand: dealerBrand, model: m }))
    : [];
  const carried = new Set((dealer?.models ?? []).map(lower));
  const isCarried = (model: string) => carried.has(lower(model));

  // ── vehicle ────────────────────────────────────────────────────────────────
  const stated: ModelMention[] = findModels(analyzed, { context: ctxText, extra: extraModels }).map((m) => ({
    brand: m.brand,
    model: m.model,
    quote: m.quote,
    source: 'text',
  }));
  const brands = findBrands(analyzed);

  let contextModel: ModelMention | undefined;
  // Context inference only for plausible signals: a filtered comment ('帅') must not inherit the post's model.
  if (ctxText && pf.passed) {
    const title = context?.post_title ?? '';
    const content = context?.post_content ?? '';
    const found = new Map<string, ModelMention>();
    for (const src of [title, content]) {
      if (!src) continue;
      for (const m of findModels(src, { context: ctxText, extra: extraModels })) {
        if (!found.has(m.model)) found.set(m.model, { brand: m.brand, model: m.model, quote: m.quote, source: 'post_context' });
      }
    }
    if (found.size === 1) contextModel = [...found.values()][0];
  }

  const comparisonHit = findFirst(mt, COMPARISON_RE);
  let comparisonModels: ModelMention[] = [];
  if (stated.length >= 2 && comparisonHit) comparisonModels = stated;
  else if (stated.length === 1 && contextModel && contextModel.model !== stated[0].model && findFirst(mt, VERSUS_RE)) {
    comparisonModels = [contextModel, stated[0]];
  }

  let primary: ModelMention | undefined;
  if (comparisonModels.length > 0) primary = comparisonModels.find((m) => isCarried(m.model)) ?? comparisonModels[0];
  else if (stated.length > 0) primary = stated.find((m) => isCarried(m.model)) ?? stated[0];

  let trimMention: { model: string; trim: string; quote: string } | undefined;
  if (!primary) {
    const trims = findTrims(analyzed, undefined, dealer?.trims);
    const trimModels = uniq(trims.map((t) => t.model));
    if (contextModel && trimModels.some((m) => lower(m) === lower(contextModel.model))) {
      primary = contextModel;
    } else if (trimModels.length === 1) {
      const t = trims[0];
      primary = { brand: getModelInfo(t.model)?.brand ?? dealerBrand, model: t.model, quote: t.quote, source: 'trim' };
      trimMention = t;
    }
  }
  if (!primary && contextModel) {
    const conflicting = brands.length > 0 && !brands.some((b) => b.brand === contextModel.brand);
    if (!conflicting) primary = contextModel;
  }

  const competing = comparisonModels.filter((m) => primary && m.model !== primary.model);

  if (primary) {
    intent.brand = primary.brand || undefined;
    intent.model = primary.model;
    const brandStated = brands.some((b) => b.brand === primary.brand);
    if (primary.source === 'post_context') {
      if (!brandStated) inferred.push('brand');
      inferred.push('model');
      evidence.push({ code: 'model_from_post_context', label: '车型来自帖子上下文', quote: primary.quote, source_ref: 'post_context' });
    } else if (primary.source === 'trim') {
      evidence.push({ code: 'model_from_trim', label: `配置对应车型 ${modelShortLabel(primary.model)}`, quote: primary.quote });
    } else {
      evidence.push({ code: 'stated_model', label: `提及车型 ${modelShortLabel(primary.model)}`, quote: primary.quote });
    }
    if (brandStated) {
      const b = brands.find((x) => x.brand === primary.brand)!;
      evidence.push({ code: 'stated_brand', label: `提及品牌 ${b.brand_zh}`, quote: b.quote });
    }
    const trim = trimMention ?? findTrims(analyzed, primary.model, dealer?.trims)[0];
    if (trim) {
      intent.trim = trim.trim;
      evidence.push({ code: 'specified_trim', label: `指定配置 ${trim.trim}`, quote: trim.quote });
    }
  } else if (brands.length > 0) {
    const b = brands.find((x) => dealer?.brands.includes(x.brand)) ?? brands[0];
    intent.brand = b.brand;
    evidence.push({ code: 'stated_brand', label: `提及品牌 ${getBrandInfo(b.brand)?.brand_zh ?? b.brand}`, quote: b.quote });
  }

  if (competing.length > 0) {
    intent.competing_models = competing.map((m) => m.model);
    for (const m of competing) {
      evidence.push({
        code: 'competing_model',
        label: `对比 ${modelShortLabel(m.model)}`,
        quote: m.quote,
        ...(m.source === 'post_context' ? { source_ref: 'post_context' } : {}),
      });
    }
    if (comparisonHit) evidence.push({ code: 'comparison', label: '车型对比中', quote: comparisonHit.quote });
  }

  // ── location ───────────────────────────────────────────────────────────────
  const loc = pickStatedLocation(findLocationsMapped(mt), dealer);
  let statedLocation = false;
  let locationEvidence: Evidence | undefined;
  if (loc) {
    statedLocation = true;
    if (loc.city) intent.location = loc.city;
    if (loc.province) intent.province = loc.province;
    locationEvidence = { code: 'stated_location', label: locationLabel(loc, dealer), quote: loc.quote };
    evidence.push(locationEvidence);
  } else if (context?.ip_location) {
    const province = provinceOfIp(context.ip_location);
    if (province) {
      intent.province = province;
      inferred.push('province');
      evidence.push({ code: 'ip_location', label: `IP属地 ${province}`, quote: context.ip_location.trim(), source_ref: 'ip_location' });
    }
  }

  // ── budget & timeframe ─────────────────────────────────────────────────────
  const budget = parseBudgetMapped(mt);
  const timeframe = detectTimeframeMapped(mt, opts);

  // ── transaction questions ──────────────────────────────────────────────────
  /** the question's clause is about a non-vehicle object ('这件外套哪里买的') */
  const offTopic = (h: TextHit) => NON_VEHICLE_OBJECT_RE.test(clauseAt(mt, h.start).text);
  const firstOnTopic = (re: RegExp, accept: (h: TextHit) => boolean = () => true): TextHit | null =>
    findMatches(mt, re).find((h) => !offTopic(h) && accept(h)) ?? null;

  const price = firstOnTopic(PRICE_RE, (h) => !(h.text === '多少' && SPEC_BEFORE_AMOUNT_RE.test(mt.norm.slice(clauseAt(mt, h.start).start, h.start))));
  const landing = firstOnTopic(LANDING_RE);
  const discount = firstOnTopic(DISCOUNT_RE);
  const subsidy = findFirst(mt, SUBSIDY_RE);
  let inventory = firstOnTopic(INVENTORY_RE);
  if (!inventory) {
    const vehicleSpans = [...stated.map((m) => m.quote), ...(intent.trim ? [intent.trim] : [])].map((q) => normalizeText(q));
    inventory =
      findMatches(mt, INVENTORY_CONTEXTUAL_RE).find((h) => {
        const clause = clauseAt(mt, h.start).text;
        if (NON_VEHICLE_OBJECT_RE.test(clause)) return false;
        return VEHICLE_REF_RE.test(clause) || vehicleSpans.some((q) => q && clause.includes(q)) || COLOR_SINGLE_RE.test(clause);
      }) ?? null;
  }
  const colorCombo = findFirst(mt, COLOR_COMBO_RE);
  const colorSingle = findMatches(mt, COLOR_SINGLE_RE).find((h) => !colorCombo || h.end <= colorCombo.start || h.start >= colorCombo.end) ?? null;
  const color = colorCombo ?? colorSingle;
  const availabilityAsk = findFirst(mt, AVAILABILITY_ASK_RE);
  const finance = keywordState(mt, FINANCE_RE, true);
  const fullPayment = findFirst(mt, FULL_PAYMENT_RE);
  const lease = keywordState(mt, LEASE_RE, true);
  const tradeIn = keywordState(mt, TRADE_IN_RE, true);
  const dealerLocation = firstOnTopic(DEALER_LOCATION_RE);
  const visitDone = (h: TextHit): boolean => {
    const after = mt.norm.slice(h.end, h.end + 3);
    if (VISIT_DONE_AFTER_RE.test(after)) return true;
    if (!after.startsWith('了')) return false;
    return !VISIT_PLAN_BEFORE_RE.test(mt.norm.slice(Math.max(clauseAt(mt, h.start).start, h.start - 8), h.start));
  };
  const visit = keywordState(mt, VISIT_RE, true, (h) => !visitDone(h));
  /** a completed visit / test drive: active shopping when the author also asks something, never a visit request */
  const visited = visit.hit ? null : (findMatches(mt, VISIT_RE).find((h) => visitDone(h) && !isNegatedAt(mt, h.start)) ?? null);
  const commitmentRaw = findFirst(mt, COMMITMENT_RE);
  const commitment = commitmentRaw && !isNegatedAt(mt, commitmentRaw.start) ? commitmentRaw : null;

  const discountHit = discount ?? (subsidy && !tradeIn.hit && !offTopic(subsidy) ? subsidy : null);
  const priceQ = !!(price || landing || discountHit);
  const colorTrimAvailability = !!(color || intent.trim) && !!(inventory || availabilityAsk || (color && priceQ));

  const questions = new Set<TransactionQuestion>();
  const qEvidence = new Map<TransactionQuestion, Evidence>();
  const ask = (q: TransactionQuestion, hit: TextHit | null, label?: string) => {
    if (!hit) return;
    questions.add(q);
    qEvidence.set(q, { code: QUESTION_EVIDENCE[q].code, label: label ?? QUESTION_EVIDENCE[q].label, quote: hit.quote });
  };
  ask('price', price);
  ask('landing_price', landing);
  ask('discount', discountHit);
  ask('inventory', inventory);
  if (colorTrimAvailability) {
    const quoteHit = color ?? availabilityAsk ?? inventory;
    ask('color_trim_availability', quoteHit);
  }
  ask('finance', finance.hit);
  ask('lease', lease.hit);
  ask('trade_in', tradeIn.hit, tradeIn.hit && subsidy ? '询问置换补贴' : undefined);
  ask('dealer_location', dealerLocation);
  if (visit.hit) ask('test_drive', visit.hit, TEST_DRIVE_WORD_RE.test(visit.hit.text) ? '想试驾' : '想到店看车');

  // ── negative feedback ──────────────────────────────────────────────────────
  const hardNegative =
    findMatches(mt, HARD_NEGATIVE_RE).find((h) => {
      if (h.text !== '骚扰') return true;
      // '一直被骚扰' / '骚扰电话' complain about third parties; they do not refuse this conversation
      const clause = clauseAt(mt, h.start);
      if (/被[^,。!?]{0,4}$/.test(mt.norm.slice(clause.start, h.start))) return false;
      return !/^(?:电话|短信)/.test(mt.norm.slice(h.end, h.end + 2));
    }) ?? null;
  // A refusal may name the discussed vehicle ('i3不买了', '宝马不考虑了') but no other object ('不需要四驱').
  const refusedObjects = [
    ...stated.filter((m) => m.model === intent.model).map((m) => m.quote),
    ...brands.filter((b) => b.brand === intent.brand).map((b) => b.quote),
    ...findTrims(analyzed, intent.model, dealer?.trims).map((t) => t.quote),
  ];
  const standalone = (h: TextHit) => isStandaloneRefusal(mt, h.start, h.end, refusedObjects);
  const disinterest = findMatches(mt, DISINTEREST_RE).find(standalone) ?? null;
  const softNegative = findMatches(mt, SOFT_NEGATIVE_RE).find(standalone) ?? null;
  const refusal = hardNegative ?? disinterest;
  const positiveTransaction = priceQ || !!inventory || !!dealerLocation || !!visit.hit || !!commitment;
  const softRefusal = !!softNegative && !positiveTransaction;

  // ── purchase stage ─────────────────────────────────────────────────────────
  const hasVehicle = !!intent.model || !!intent.brand;
  const nearTimeframe = timeframe?.timeframe === 'this_week' || timeframe?.timeframe === 'soon';
  const questionHit = findFirst(mt, QUESTION_RE);
  // product topics ('后排', '续航') are research only when asked about; statements ('后排一般', '红内饰好好看') are not
  const research = questionHit ? findFirst(mt, RESEARCH_RE) : null;
  const scenario = findFirst(mt, SCENARIO_RE);
  const desire = findFirst(mt, DESIRE_RE);
  const specific = !!intent.trim || statedLocation || !!color;
  const paymentQ = !!(finance.hit || lease.hit || tradeIn.hit);
  const paymentSpecifics =
    (!!finance.hit && FINANCE_DETAIL_RE.test(mt.norm)) ||
    (!!lease.hit && LEASE_DETAIL_RE.test(mt.norm)) ||
    (!!tradeIn.hit && TRADE_IN_DETAIL_RE.test(mt.norm));

  let stage: PurchaseStage | undefined;
  if (commitment || (nearTimeframe && (inventory || visit.hit || priceQ))) stage = 'purchase_imminent';
  else if (dealerLocation) stage = 'dealer_selection';
  else if (
    inventory ||
    colorTrimAvailability ||
    visit.hit ||
    (!!visited && !!questionHit) ||
    (priceQ && specific) ||
    (paymentQ && hasVehicle && (specific || paymentSpecifics))
  )
    stage = 'active_shopping';
  else if (priceQ || finance.hit || lease.hit || tradeIn.hit) stage = 'price_shopping';
  else if (competing.length > 0) stage = 'comparison';
  else if ((research && hasVehicle) || scenario || budget) stage = 'research';
  else if (desire && hasVehicle) stage = 'awareness';

  // ── author role (ARCHITECTURE §5.1) ────────────────────────────────────────
  const nickname = (context?.author_nickname ?? '').trim();
  const nickMt = nickname ? mapText(nickname) : null;
  const nickHit = (re: RegExp): RoleCue | null => {
    if (!nickMt) return null;
    const h = findFirst(nickMt, re);
    return h ? { quote: h.quote, fromNickname: true } : null;
  };
  const textCue = (h: TextHit | null): RoleCue | null => (h ? { quote: h.quote, fromNickname: false } : null);
  const postLike = context?.source_type === 'post' || context?.source_type === 'profile';
  const shoppingQuestion = questions.size > 0;
  const askerSelf = findFirst(mt, ASKER_SELF_RE);
  const repeatPurchase = findFirst(mt, REPEAT_PURCHASE_RE);
  const dilemma = findFirst(mt, SELF_DILEMMA_RE);
  /** a question about the author's own purchase (incl. '还是纠结…选哪个？'): overrides nickname-only and weak creator hints */
  const buyingQuestion = !!askerSelf || (!!questionHit && (shoppingQuestion || !!dilemma));

  const marketingNick = pf.is_marketing ? null : nickHit(MARKETING_NICK_RE);
  const isMarketing = pf.is_marketing || !!marketingNick;

  /** someone else is the subject of the cue: before it, inside its clause ('朋友已经提了i3'), never a vocative */
  const aboutSomeoneElse = (h: TextHit) => {
    const clause = clauseAt(mt, h.start);
    return OTHER_SUBJECT_RE.test(mt.norm.slice(Math.max(clause.start, h.start - 10), h.start));
  };
  const ownerTextHit =
    [...findMatches(mt, PURCHASED_RE), ...findMatches(mt, OWNER_TEXT_RE)]
      .filter((h) => !aboutSomeoneElse(h))
      .filter((h) => !TRADE_IN_CLAUSE_RE.test(clauseAt(mt, h.start).text))
      .filter((h) => !FUTURE_OWNER_RE.test(h.text))
      .sort((a, b) => a.start - b.start)[0] ?? null;
  const buyDesire =
    findMatches(mt, BUY_DESIRE_RE).find(
      (h) =>
        !PAST_DESIRE_BEFORE_RE.test(mt.norm.slice(Math.max(0, h.start - 5), h.start)) &&
        !NON_CAR_PURCHASE_AFTER_RE.test(mt.norm.slice(h.end, h.end + 8)),
    ) ?? null;
  /** an owner (or renter) who wants another car and asks about it is shopping again */
  const shopsAgain = (!!repeatPurchase || !!buyDesire) && (!!questionHit || shoppingQuestion);
  const ownerText = ownerTextHit && !shopsAgain ? textCue(ownerTextHit) : null;
  const ownerNick =
    !ownerTextHit && nickMt && !NOT_OWNER_NICK_RE.test(nickMt.norm) && !buyingQuestion && !shopsAgain ? nickHit(OWNER_NICK_RE) : null;
  const ownerCue = ownerText ?? ownerNick;

  /** a creator cue informs unless the author asks for that content ('求分享', '有没有攻略？', '怎么避坑？') */
  const informs = (h: TextHit) => {
    const clause = clauseAt(mt, h.start);
    if (CREATOR_REQUEST_BEFORE_RE.test(mt.norm.slice(clause.start, h.start))) return false;
    return !CREATOR_REQUEST_AFTER_RE.test(mt.norm.slice(h.end, Math.max(h.end, clause.end)));
  };
  const firstInforming = (re: RegExp) => findMatches(mt, re).find(informs) ?? null;
  const creatorStrong = postLike ? textCue(firstInforming(CREATOR_STRONG_RE)) : null;
  const creatorWeak = postLike && !creatorStrong ? textCue(firstInforming(CREATOR_WEAK_RE)) : null;
  const advice = questionHit ? null : textCue(findFirst(mt, ADVICE_RE));
  let creatorCue: RoleCue | null = null;
  if (creatorStrong && !askerSelf) creatorCue = creatorStrong;
  else if (creatorWeak && !buyingQuestion) creatorCue = creatorWeak;
  else if (advice && !askerSelf) creatorCue = advice;
  else if (!creatorStrong && !creatorWeak && !advice && !buyingQuestion) creatorCue = nickHit(CREATOR_NICK_RE);

  let role: AuthorRole;
  if (isMarketing) role = 'marketing';
  else if (ownerCue) role = 'owner';
  else if (creatorCue) role = 'creator';
  else if (pf.passed && (stage !== undefined || !!refusal || softRefusal)) role = 'asker';
  else role = 'unknown';
  const buyerVoice = role === 'asker' || role === 'unknown';

  // an owner who states the completed purchase is not in the market (ARCHITECTURE §5.1, F2)
  const negative = !!refusal || softRefusal || (role === 'owner' && !!ownerText);

  // ── assemble ───────────────────────────────────────────────────────────────
  const passed = pf.passed;
  if (!passed) {
    if (pf.reason === 'marketing_account') {
      const hits = pf.hits.slice(0, 3);
      evidence.unshift({
        code: 'marketing_account',
        label: hits.length > 1 ? `${PREFILTER_LABELS.marketing_account}（${hits.join('、')}）` : PREFILTER_LABELS.marketing_account,
        quote: pf.hits[0],
      });
    } else {
      const quote = textQuote(analyzed);
      if (quote) {
        evidence.unshift({ code: pf.reason, label: PREFILTER_LABELS[pf.reason as Exclude<PrefilterReason, 'keyword_hit'>], quote });
      }
    }
  } else {
    if (buyerVoice) {
      for (const q of TRANSACTION_QUESTIONS) {
        const e = qEvidence.get(q);
        if (e) evidence.push(e);
      }
      if (budget) {
        if (budget.budget_min !== undefined) intent.budget_min = budget.budget_min;
        if (budget.budget_max !== undefined) intent.budget_max = budget.budget_max;
        evidence.push({ code: 'budget', label: budgetLabel(budget), quote: budget.quote });
      }
      if (color) {
        intent.color_intent = color.quote;
        evidence.push({ code: 'specified_color', label: `指定颜色 ${color.quote}`, quote: color.quote });
      }
      if (price || landing) intent.price_intent = true;
      if (discountHit) intent.discount_intent = true;
      if (inventory) intent.inventory_intent = true;
      if (finance.hit) intent.financing_intent = true;
      else if (finance.negated || fullPayment) {
        intent.financing_intent = false;
        if (finance.negated) evidence.push({ code: 'financing_declined', label: '明确不需要贷款', quote: negatedQuote(mt, finance.negated) });
        if (fullPayment) evidence.push({ code: 'full_payment', label: '全款购车', quote: fullPayment.quote });
      }
      if (lease.hit) intent.leasing_intent = true;
      else if (lease.negated) {
        intent.leasing_intent = false;
        evidence.push({ code: 'leasing_declined', label: '不需要租赁', quote: negatedQuote(mt, lease.negated) });
      }
      if (tradeIn.hit) intent.trade_in_intent = true;
      else if (tradeIn.negated) {
        intent.trade_in_intent = false;
        evidence.push({ code: 'no_trade_in', label: '不需要置换', quote: negatedQuote(mt, tradeIn.negated) });
      }
      if (dealerLocation) intent.dealer_selection_intent = true;
      if (visit.hit) intent.visit_intent = true;
      else if (visit.negated) intent.visit_intent = false;
      if (visited) {
        evidence.push({ code: 'visited_store', label: TEST_DRIVE_WORD_RE.test(visited.text) ? '已试驾' : '已到店看车', quote: visited.quote });
      }

      const highSens = findFirst(mt, HIGH_PRICE_SENSITIVITY_RE);
      if (highSens) {
        intent.price_sensitivity = 'high';
        evidence.push({ code: 'price_sensitivity', label: '价格敏感', quote: highSens.quote });
      } else if (findFirst(mt, LOW_PRICE_SENSITIVITY_RE)) intent.price_sensitivity = 'low';
      else if (priceQ) intent.price_sensitivity = 'medium';

      if (timeframe) {
        intent.purchase_timeframe = timeframe.timeframe;
        const [plain, withVisit] = TIMEFRAME_LABELS[timeframe.timeframe];
        evidence.push({ code: 'purchase_timeframe', label: visit.hit ? withVisit : plain, quote: timeframe.quote });
      }
      if (commitment) evidence.push({ code: 'purchase_commitment', label: '准备下定/提车', quote: commitment.quote });
    } else if (locationEvidence && loc) {
      // a creator / owner / trade account mentioning a place is not a "local buyer"
      locationEvidence.label = `提及地点（${loc.city ?? loc.province}）`;
    }

    if (refusal) evidence.push({ code: 'not_interested', label: '明确拒绝/不感兴趣', quote: refusal.quote });
    if (softRefusal && softNegative) evidence.push({ code: 'not_interested', label: '表示不需要/不考虑', quote: softNegative.quote });

    if (buyerVoice && !negative) {
      if (stage === 'research') {
        const hit = research ?? scenario;
        if (hit) evidence.push({ code: research ? 'product_research' : 'purchase_scenario', label: research ? '关注产品细节' : '购车场景咨询', quote: hit.quote });
      } else if (stage === 'awareness' && desire) {
        evidence.push({ code: 'purchase_desire', label: '表达购买意愿', quote: desire.quote });
      }
    }
    if (buyerVoice && stage && scenario && stage !== 'research') {
      evidence.push({ code: 'purchase_scenario', label: '购车场景咨询', quote: scenario.quote });
    }
  }

  // ── role evidence ──────────────────────────────────────────────────────────
  const roleEvidence = (code: string, label: string, cue: RoleCue): Evidence =>
    cue.fromNickname ? { code, label: `${label}（昵称）`, quote: cue.quote, source_ref: 'author_nickname' } : { code, label, quote: cue.quote };
  if (role === 'marketing' && marketingNick) {
    evidence.push(roleEvidence('marketing_account', '经销商/同行销售账号', marketingNick));
  }
  if (role === 'owner' && ownerCue) {
    evidence.push(roleEvidence('already_purchased', '已购车（非在市买家）', ownerCue));
    // generic marker recognized as negative wherever detections are rebuilt from stored evidence (lead scoring)
    if (passed && negative && ownerText) evidence.push({ code: 'negative_feedback', label: '非在市买家，不应跟进', quote: ownerText.quote });
  }
  const creatorEvidenceCue = creatorCue ?? (role === 'owner' ? (creatorStrong ?? creatorWeak) : null);
  if ((role === 'creator' || role === 'owner') && creatorEvidenceCue) {
    evidence.push(roleEvidence('content_creator', '内容创作/经验分享（非本人购车询问）', creatorEvidenceCue));
  }

  const finalStage = passed && !negative && buyerVoice ? stage : undefined;
  if (finalStage) intent.purchase_stage = finalStage;
  if (inferred.length > 0) intent.inferred_fields = inferred;

  const questionList = passed && buyerVoice ? TRANSACTION_QUESTIONS.filter((q) => questions.has(q)) : [];
  intent.confidence = confidenceFor(pf, role, !!(ownerText || creatorStrong || creatorWeak || advice), negative, finalStage, intent, statedLocation, questionList.length);

  const detection: IntentDetection = {
    is_purchase_signal: passed && !negative && buyerVoice && finalStage !== undefined,
    intent,
    evidence: dedupeEvidence(evidence),
    transaction_questions: questionList,
    strength: finalStage ? STAGE_STRENGTH[finalStage] : 0,
    negative: passed && negative,
    engine: 'rules',
    is_marketing: isMarketing,
    author_role: role,
  };
  return { analyzed_text: analyzed, prefilter: pf, detection };
}

function confidenceFor(
  pf: PrefilterResult,
  role: AuthorRole,
  roleFromText: boolean,
  negative: boolean,
  stage: PurchaseStage | undefined,
  intent: AutomotiveIntent,
  statedLocation: boolean,
  questionCount: number,
): number {
  if (!pf.passed) {
    const byReason: Record<string, number> = {
      empty_or_emoji: 0.99,
      pure_praise: 0.95,
      marketing_account: 0.85,
      too_short: 0.8,
      no_signal: 0.7,
    };
    return byReason[pf.reason] ?? 0.7;
  }
  if (role === 'marketing') return 0.75; // nickname-only dealer-sales hint
  if (role === 'owner' || role === 'creator') return roleFromText ? 0.85 : 0.7;
  if (negative) return 0.85;
  if (!stage) return 0.55;
  const inferred = intent.inferred_fields ?? [];
  let c = 0.45;
  if (intent.model) c += inferred.includes('model') ? 0.08 : 0.15;
  else if (intent.brand) c += 0.04;
  if (intent.trim) c += 0.08;
  if (statedLocation) c += 0.08;
  else if (intent.province) c += 0.03;
  c += Math.min(0.15, 0.05 * questionCount);
  if (intent.purchase_timeframe) c += 0.04;
  if (intent.budget_min !== undefined || intent.budget_max !== undefined) c += 0.04;
  if (intent.color_intent) c += 0.04;
  if (intent.competing_models?.length) c += 0.04;
  return round(clamp(c, 0, 0.95), 2);
}

/**
 * Rules-only purchase-intent detection (pure). `opts.now` / `opts.tz` place calendar expressions ('9月底', '国庆前')
 * relative to the signal's evaluation time; without them such expressions are ignored.
 */
export function detectIntentRules(text: string, context?: SignalContext, dealer?: DealerProfile, opts?: IntentRuleOptions): IntentDetection {
  return analyzeSignal(text, context, dealer, opts).detection;
}
