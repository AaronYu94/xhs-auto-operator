/**
 * Registry of product features the console does NOT implement yet. Every entry is rendered as a visible 「未完成」
 * placeholder where the feature belongs (placeholder helpers in render.ts) and listed on 系统 → 未完成功能.
 * When a feature is finished: remove its entry and its placeholder together (test/unit/server/unfinished.test.ts
 * checks that every entry is still shown somewhere).
 *
 * Platform limits (DMs, note views, publish without note id) are NOT listed here: they are honest capability states,
 * not unfinished work.
 */

export interface UnfinishedFeature {
  /** page where the placeholder appears */
  page: '总览' | '线索' | '内容' | '账号' | '情报' | '系统' | '设置';
  title: string;
  /** what exactly is missing (shown as the tooltip and on 系统) */
  missing: string;
}

export const UNFINISHED = {
  exception_filters: {
    page: '总览',
    title: '待处理事项的筛选跳转',
    missing: '私信审核、待发送、被拦截、未分配线索、内容审批、评论回复、对话草稿、失败任务这几类事项跳转后，目标页面还不支持对应筛选，显示的是未筛选的完整页面；也还没有独立的私信审核队列页。',
  },
  dashboard_filters: {
    page: '总览',
    title: '总览筛选（账号、品牌、车型、地区、日期、来源、阶段）',
    missing: '后台已经能按这些条件筛，但今日页还没有筛选栏和日期范围，现在只显示今天、全门店的数据。',
  },
  goal_pause: {
    page: '总览',
    title: '暂停 / 恢复经营目标',
    missing: '后台已经能暂停和恢复，目标列表上还没有按钮。',
  },
  lead_filters_more: {
    page: '线索',
    title: '按品牌、负责账号、日期筛选线索',
    missing: '后台已经能按这几项筛，筛选栏上还没有对应的选项。',
  },
  lead_stage_negotiating: {
    page: '线索',
    title: '标记「洽谈中」',
    missing: '后台能改，但线索页上没有这个按钮，系统也不会自己把人标成洽谈中，所以漏斗里的「洽谈中」目前一直是 0。',
  },
  appointment_cancel_list: {
    page: '线索',
    title: '取消预约 · 预约列表',
    missing: '后台能取消预约、也能列出全部预约，页面上还没有取消按钮，也还没有单独的预约列表。',
  },
  post_images: {
    page: '内容',
    title: '上传 / 生成笔记配图',
    missing: '发一篇笔记至少要 1 张图，现在只能自己填图片网址、或者这台电脑上的文件位置，不能直接上传，也不会自动配图，所以自动发布会停在「等人去发」。',
  },
  own_note_reconcile: {
    page: '内容',
    title: '自家笔记自动对账（内容归因 · 评论回复）',
    missing: '系统已经能读到这个号自己发过的笔记，但还没有把它们和系统里的记录自动对上，所以「哪篇笔记真的带来了成交」和笔记下的评论回复，多数时候还是空的。',
  },
  account_persona_edit: {
    page: '账号',
    title: '编辑账号人设',
    missing: '后台能改人设、语气、主推车型、目标客户和不能碰的话题，账号卡片现在只能看；要改只能整包导入门店资料。',
  },
  account_policy_edit: {
    page: '账号',
    title: '账号审批策略与每日限额',
    missing: '后台能给单个号设「发私信要不要先给人看」和每天最多发多少，账号卡片上还没有这个设置。',
  },
  account_history_ingest: {
    page: '账号',
    title: '把以前发过的笔记算进账号数据',
    missing: '账号卡片上能看到这个号以前发的笔记，但这些笔记还没算进内容去重和数据统计里，现在只统计用这套系统发出去的。',
  },
  optimization_view: {
    page: '情报',
    title: '优化建议的展示与保存',
    missing: '跑完之后只有一句提示，没有一条条能看的建议，也不会存下来以后翻。',
  },
  lost_reason_analysis: {
    page: '情报',
    title: '流失原因分析',
    missing: '标记流失时会记录原因，但还没有按原因汇总分析。',
  },
  schedule_edit_time: {
    page: '系统',
    title: '修改排班时间',
    missing: '目前只能开关每日任务，不能调整执行时间。',
  },
  inventory_create: {
    page: '系统',
    title: '新增库存',
    missing: '已有的库存能改，新增一台车的库存现在只能靠整包导入门店资料。',
  },
  knowledge_edit: {
    page: '系统',
    title: '维护门店知识（品牌规范、禁用说法、销售人员、活动）',
    missing: '门店知识现在只能看，增删改都只能靠整包导入门店资料。',
  },
  inventory_sync: {
    page: '系统',
    title: '外部库存系统同步',
    missing: '每天 08:00 的刷新任务只检查门店资料是否过期并提醒，没有从外部库存 / DMS 系统自动同步数据。',
  },
  dealer_policy_edit: {
    page: '设置',
    title: '门店运营策略（审批、限额、跟进节奏）',
    missing: '发私信和发笔记要不要先给人看、每天最多发多少、隔几天跟进一次、AI 最多自己回几轮，这些门店级的设置现在只能靠整包导入门店资料来定，页面上改不了。',
  },
} as const satisfies Record<string, UnfinishedFeature>;

export type UnfinishedKey = keyof typeof UNFINISHED;
