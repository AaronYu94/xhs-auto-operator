# Xiaohongshu integration research (verified from source code, 2026-09)

Findings from reading the tool-definition source of the open-source projects (not only READMEs).
Items that could not be verified are marked UNVERIFIED.

## Headline
- **No open-source MCP server can send a DM or read the DM inbox.**
- Official DM access exists only for **inbound** conversations via 私信通 (pro.xiaohongshu.com/im) and approved
  三方客服 vendors (requires 蓝V + 聚光). There is **no authorized API to cold-DM arbitrary users.**
- 聚光 "私信API对接" pushes **lead records** (not messages) as JSON POST webhooks when an agent marks a valid DM lead.
- Since **2025-01-07** 专业号 messages may not contain WeChat IDs or phone numbers; contact exchange must use
  名片 / 留资卡. Sending contact details directly can fail and risks the account.
- All open-source tools drive the logged-in web account (browser automation or signed private web API).

## xpzouying/xiaohongshu-mcp (Go, most mature; recommended live adapter)
- Transport: **streamable HTTP only**, `http://localhost:18060/mcp`, stateless, plain JSON responses (clients may
  skip `initialize`). `/health`. Flags `-port :18060 -headless=true -token`. Env `AUTH_TOKEN` → `Authorization: Bearer`.
  `COOKIES_PATH` selects the login session → **one instance per managed account** (different port + cookies path).
  (The server also has proxy / fingerprint-seed options — this system deliberately does NOT use them.)
- Login: `get_login_qrcode` (text + PNG, 4-min timeout) or login binary. Same account logged in elsewhere on web kicks the session.
- Tools (18 in source):
  1. `check_login_status` → text "已登录 / 用户名: …" (or 未登录)
  2. `get_login_qrcode` → text + image/png
  3. `delete_cookies`
  4. `publish_content` {title, content, images[] (URL or abs path, required), tags[], schedule_at (ISO, 1h–14d), is_original, visibility: 公开可见|仅自己可见|仅互关好友可见, products[]} → text "内容发布成功: …" — **no note_id returned**
  5. `list_feeds` → `{feeds: [Feed], count}`
  6. `search_feeds` {keyword, filters{sort_by: 综合|最新|最多点赞|最多评论|最多收藏, note_type: 不限|视频|图文, publish_time: 不限|一天内|一周内|半年内, search_scope, location: 不限|同城|附近}} → `{feeds, count}`
  7. `get_feed_detail` {feed_id, xsec_token, load_all_comments: bool, limit=20, click_more_replies: bool, reply_limit=10, scroll_speed} → `{feed_id, data: {note, comments}}`
  8. `user_profile` {user_id, xsec_token, tab: note|fav|liked} → `{userBasicInfo{gender, ipLocation, desc, imageb, nickname, images, redId}, interactions[{type, name, count}], feeds[Feed]}`
  9. `post_comment_to_feed` {feed_id, xsec_token, content} → text
  10. `reply_comment_in_feed` {feed_id, xsec_token, content, comment_id | user_id} → text "评论回复成功 …"
  11. `publish_with_video` {title, content, video, tags, schedule_at, visibility, products}
  12. `like_feed` · 13. `favorite_feed`
  14. `get_my_profile` {tab} → same shape as user_profile (own notes with interactInfo)
  15. `get_unread_count` → `{mentions, likes, connections, unread}`
  16. `list_notifications` {tab: mentions|likes|connections, limit} → `{tab, filtered, items:[{id, type, title, time, from{user_id, nickname, xsec_token}, comment_id, comment_text, liked, feed_id, feed_xsec_token, feed_title}]}` (clears unread mark)
  17. `reply_notification` {comment_id, content} · 18. `like_notification`
- Shapes (types.go):
  - **Feed**: `{xsecToken, id, modelType, index, noteCard{type, displayTitle, user{userId, nickname, nickName, avatar}, interactInfo{liked, likedCount, sharedCount, commentCount, collectedCount, collected}, cover, video?}}` — list items have no desc/timestamp; counts are strings.
  - **note**: `{noteId, xsecToken, title, desc, type, time (ms), ipLocation, user{userId, nickname}, interactInfo{likedCount, collectedCount, commentCount, sharedCount}, imageList[], video?}`
  - **comments**: `{list:[Comment], cursor, hasMore}`; **Comment**: `{id, noteId, content, likeCount (string), createTime (int64 ms), ipLocation, liked, userInfo{userId, nickname}, subCommentCount (string), subComments[Comment], showTags[]}`. Without load_all_comments only ~10 top-level comments.
- Risk notes: each call launches a headless browser (slow; treat as one call at a time). Built-in human-like delays.
  Avoid 引流 (steering off-platform) and 搬运; new accounts may get 实名认证 prompts. Web publishing can be blocked by risk control.

## haoyu-haoyu/xhs-mcp (Python, stdio, read-only)
Tools: `xhs_search` {keywords[], sort, page, note_type}, `xhs_detail` {note_ids[], xsec_tokens[], get_comments, comment_count},
`xhs_creator` {user_ids[], note_count}, `xhs_login`, `xhs_status`. No write actions. Caches search 15 min / detail 24 h / creator 7 d.
Treats HTTP 461/471 as CAPTCHA. Non-commercial license.

## Algovate/xhs-mcp (TypeScript, npm `xhs-mcp`)
stdio or HTTP (`--mode http --port 3000`, `/mcp`). Tools: `xhs_auth_login|logout|status`, `xhs_discover_feeds`,
`xhs_search_note {keyword}`, `xhs_get_note_detail {feed_id, xsec_token}`, `xhs_comment_on_note`, `xhs_publish_content`,
`xhs_get_user_notes`, `xhs_delete_note`. No DMs, no comment replies, no notifications. Payloads are raw camelCase page state.

## puyujian/xhssx, XHS-YYDS
Tampermonkey scripts clicking through the 私信通 web inbox (reply inside existing conversations, send 留资卡/名片).
Cannot start conversations with new users. No official API.

## Official channels
- 私信通: routes incoming chats, welcome message, 留资卡 (asks user for phone/企微), 商家/社媒名片, 交易卡.
- 三方客服 vendor authorization (聚光 → 工具 → 三方客服管理): receive/reply inbound DMs via approved vendors (API surface not public, UNVERIFIED).
- 聚光 私信API对接 lead webhook fields (vendor docs, UNVERIFIED exact keys): 操作类型, 时间, 小红书号, 用户昵称, 省份/城市,
  线索标签, 电话/微信, 备注, 标注客服, 投放账号, 是否留资, 笔记链接, 广告计划/单元/创意ID, 私信接收人/ID. HTTP 200 = delivered.
- 聚光 Marketing API: campaigns/reports/lead push; no DM send/read.
