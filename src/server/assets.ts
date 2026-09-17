/**
 * Static console assets (served from /assets/*): the design-system stylesheet (docs/UI_DESIGN.md tokens) and a
 * small vanilla script for actions. No external fonts or CDNs — the console must work on a private network.
 */

export const CONSOLE_CSS = `
:root{
  color-scheme:light;
  --bg:#FAF9F6;--surface:#FFFFFF;--surface-muted:#F2F0ED;--surface-sunken:#F1F1EE;--border:#ECEAE5;--divider:#F3F2F0;--divider-dashed:#E7E5E1;
  --text:#0D0D0D;--text-2:#4E4E4F;--text-3:#5C5C5C;--text-muted:#979797;--text-faint:#9A9A9A;
  --coral:#EC6644;--coral-strong:#EA532D;--coral-soft:#FDF3EF;--coral-on:#FAD7CE;--lavender:#C5B7EE;--lavender-soft:#EFEAFC;--violet:#6852F6;--avatar:#D4C7F2;--ink:#0D0D0D;
  --green-soft:#EBF5EA;--green:#2C6A22;--amber-soft:#FDF4E2;--amber:#D95A09;--red-soft:#FCECEE;--red:#AE2219;
  --grad-title:linear-gradient(90deg,#9F84E2 0%,#CC7A8B 55%,#ED7857 100%);
  --radius-xl:28px;--radius-lg:22px;
  --font-sans:"Inter",-apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif;
  --font-mono:"JetBrains Mono","SF Mono",ui-monospace,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-sans);font-size:15px;-webkit-font-smoothing:antialiased;line-height:1.5}
a{color:inherit;text-decoration:none}
a.link{color:var(--violet)} a.link:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.container{max-width:1440px;margin:0 auto;padding-inline:clamp(16px,4vw,48px)}
.muted{color:var(--text-muted)} .small{font-size:13px} .tiny{font-size:12px}
.num{font-variant-numeric:tabular-nums}
.mono{font-family:var(--font-mono);font-size:13px;color:var(--text-3);word-break:break-all}
.nowrap{white-space:nowrap}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.spacer{flex:1}
.setup{max-width:1080px}
.setup-next{display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:#fff;border:1px solid var(--border);border-radius:14px;padding:12px 16px}
.setup-progress{display:flex;gap:20px;flex-wrap:wrap;list-style:none;margin:0;padding:0;font-size:14px;color:var(--text-muted)}
.setup-progress .done{color:var(--text-2)}
.setup-progress .done::before{content:"✓";color:var(--green);margin-right:6px}
.setup-progress .todo{color:var(--text);font-weight:600}
.setting{display:grid;grid-template-columns:200px minmax(0,1fr);gap:40px;padding-block:36px;border-top:1px solid var(--border)}
.setup-next+.setting{border-top:0;margin-top:12px}
.setup>.setting:first-child{border-top:0;padding-top:8px}
.setting-head h2{font-size:16px;font-weight:600}
.setting-head p{margin:6px 0 0;font-size:13px;line-height:1.6;color:var(--text-muted)}
.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 20px}
.fields .wide{grid-column:1/-1}
.fields label>span:first-child{color:var(--text-2)}
.opt{margin-left:6px;font-size:12px;color:var(--text-muted)}
.form-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
details.adder{margin-top:16px}
details.adder>summary{list-style:none}
details.adder>summary::-webkit-details-marker{display:none}
details.adder[open]>summary{margin-bottom:16px}
@media (max-width:760px){.setting{grid-template-columns:minmax(0,1fr);gap:16px;padding-block:28px}.fields{grid-template-columns:minmax(0,1fr)}}
.stack{display:flex;flex-direction:column;gap:12px}

.topbar{display:flex;align-items:center;gap:20px;height:84px}
.brand{display:flex;align-items:center;gap:12px;font-weight:700;font-size:22px;letter-spacing:-.01em;white-space:nowrap}
.logo{width:28px;height:28px;border-radius:50%;background:var(--coral);display:grid;place-items:center;flex:none}
.logo::after{content:"";width:10px;height:10px;border-radius:50%;background:#fff}
.mode-pill{font-size:12px;font-weight:600;padding:5px 12px;border-radius:999px;letter-spacing:.02em;white-space:nowrap}
.mode-live{background:var(--green-soft);color:var(--green)} .mode-simulation{background:var(--lavender-soft);color:var(--violet)} .mode-none{background:var(--red-soft);color:var(--red)}
.search{flex:1;max-width:420px;margin-inline:auto;height:44px;border-radius:999px;background:#fff;border:1px solid var(--border);display:flex;align-items:center;gap:10px;padding:0 18px;color:var(--text-muted)}
.search input{border:0;outline:0;background:transparent;font:inherit;flex:1;color:var(--text);min-width:0}
.top-actions{display:flex;align-items:center;gap:12px}
.pill-select{height:44px;padding:0 14px;border-radius:999px;background:#fff;border:1px solid var(--border);font:inherit;font-weight:500;max-width:220px}
.icon-btn{width:44px;height:44px;border-radius:50%;background:#fff;border:1px solid var(--border);display:grid;place-items:center;position:relative;color:var(--text)}
.icon-btn .dot{position:absolute;top:10px;right:11px;width:8px;height:8px;border-radius:50%;background:var(--coral)}
.avatar{width:44px;height:44px;border-radius:50%;background:var(--avatar);display:grid;place-items:center;font-weight:600;color:#3B2F63}

.banner{border-radius:16px;padding:12px 18px;margin:0 0 12px;font-size:14px;line-height:1.6}
.banner-amber{background:var(--amber-soft);color:#7A3A06} .banner-red{background:var(--red-soft);color:var(--red)} .banner-violet{background:var(--lavender-soft);color:#3B2F8F} .banner-green{background:var(--green-soft);color:var(--green)}

.page-head{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;padding-block:28px 40px}
h1{font-size:40px;line-height:1.1;font-weight:700;letter-spacing:-.02em;margin:0}
h2{margin:0} h3{margin:0 0 8px;font-size:18px}
.grad{background:var(--grad-title);-webkit-background-clip:text;background-clip:text;color:transparent}
.subtitle{margin:14px 0 0;color:var(--text-2);font-size:16px}
.tabs{display:flex;gap:2px;background:#fff;border:1px solid var(--border);border-radius:999px;padding:6px;overflow-x:auto;max-width:100%}
.tab{padding:10px 18px;border-radius:999px;font-size:14px;font-weight:600;letter-spacing:.08em;color:var(--text-2);white-space:nowrap}
.tab:hover{background:var(--surface-sunken)}
.tab.active{background:var(--ink);color:#fff}

.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:28px}
.kpi{position:relative;overflow:hidden;border-radius:28px;padding:28px;min-height:186px;display:flex;flex-direction:column;justify-content:space-between;transition:transform .15s ease}
.kpi:hover{transform:translateY(-1px)}
.kpi-label{font-size:14px;font-weight:600;letter-spacing:.08em}
.kpi-num{font-size:56px;line-height:1;font-weight:400;letter-spacing:-.02em;font-variant-numeric:tabular-nums;margin:22px 0 18px;white-space:nowrap}
.kpi-foot{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:500;flex-wrap:wrap;position:relative;z-index:1}
.chip{padding:3px 9px;border-radius:999px;font-size:13px;font-weight:600}
.kpi-dot{position:absolute;top:30px;right:30px;width:14px;height:14px;border-radius:50%}
.kpi.coral{background:var(--coral);color:#fff}
.kpi.coral .chip{background:rgba(255,255,255,.22);color:#fff}
.kpi.coral .kpi-dot{background:var(--coral-on)}
.kpi.coral::after{content:"";position:absolute;width:132px;height:132px;border-radius:50%;border:2px solid rgba(160,40,10,.14);right:-30px;bottom:-46px}
.kpi.lavender{background:var(--lavender);color:var(--ink)}
.kpi.lavender .chip{background:#fff;color:var(--ink)}
.kpi.lavender .kpi-dot{background:#36333E}
.kpi.ink{background:var(--ink);color:#fff}
.kpi.ink .kpi-foot{color:rgba(255,255,255,.7)}
.kpi.ink .kpi-dot{background:#fff;opacity:.85;width:10px;height:10px}
.kpi.outline{background:#fff;box-shadow:inset 0 0 0 1px var(--border)}
.kpi.outline .kpi-label{color:var(--text-muted)}
.kpi.outline .kpi-num{color:var(--coral-strong)}
.kpi.outline .kpi-foot{color:var(--text-2)}
.kpi.outline .kpi-dot{background:#F08569;width:9px;height:9px;top:32px;right:32px}

.main-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:40px;margin-top:56px;align-items:start}
.section-head{display:flex;align-items:center;gap:14px;margin-bottom:18px;flex-wrap:wrap}
.section-title{font-size:24px;font-weight:500;margin:0;letter-spacing:-.01em}
.live{font-size:13px;color:#747474;background:var(--surface-sunken);padding:3px 10px;border-radius:999px;display:inline-flex;align-items:center;gap:6px}
.live::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--coral)}
.btn{border:0;cursor:pointer;font:inherit;font-weight:500;border-radius:999px;padding:11px 22px;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;transition:background .15s,opacity .15s}
.btn:disabled{opacity:.55;cursor:not-allowed}
.btn-primary{background:var(--coral);color:#fff} .btn-primary:hover{background:var(--coral-strong)}
.btn-ink{background:var(--ink);color:#fff} .btn-ink:hover{background:#2a2a2a}
.btn-ghost{background:#fff;color:var(--text);box-shadow:inset 0 0 0 1px var(--border)} .btn-ghost:hover{background:var(--surface-sunken)}
.btn-danger{background:var(--red-soft);color:var(--red)} .btn-danger:hover{background:#f8dbe0}
.btn-sm{padding:7px 14px;font-size:13px}
.btn-muted{display:block;margin-top:20px;background:var(--surface-muted);color:#4C4C4C;text-align:center;padding:14px;border-radius:12px;font-size:14px}

.table-wrap{overflow-x:auto}
table.data{width:100%;border-collapse:collapse}
.data th{font-size:13px;font-weight:500;letter-spacing:.06em;color:var(--text-muted);text-align:left;padding:12px 16px 12px 0;white-space:nowrap}
.data td{padding:16px 16px 16px 0;border-top:1px solid var(--divider);vertical-align:middle}
.data tbody tr:last-child td{border-bottom:1px solid var(--divider)}
.data.compact td{padding:11px 14px 11px 0;font-size:14px}
.id-pill{display:inline-grid;place-items:center;min-width:46px;height:30px;padding:0 10px;border-radius:999px;border:1px solid #E4E2DD;background:#fff;font-family:var(--font-mono);font-size:13px;font-weight:500}
.id-pill.hot{border-color:#F6C3B4;color:var(--coral-strong);background:var(--coral-soft)}
.primary{font-size:17px;font-weight:500}
.secondary{font-size:13px;color:var(--text-3);margin-top:4px}
.quote-cell{color:var(--text-3);font-size:14px}
.status{display:inline-block;padding:4px 12px;border-radius:999px;font-size:13px;font-weight:500;white-space:nowrap}
.s-green{background:var(--green-soft);color:var(--green)} .s-amber{background:var(--amber-soft);color:var(--amber)} .s-red{background:var(--red-soft);color:var(--red)}
.s-violet{background:var(--lavender-soft);color:var(--violet)} .s-neutral{background:var(--surface-sunken);color:var(--text-3)}
.s-coral{background:var(--coral);color:#fff} .s-coral-soft{background:var(--coral-soft);color:var(--coral-strong)}
.circle-btn{width:40px;height:40px;border-radius:50%;border:1px solid #E4E2DD;background:#fff;display:grid;place-items:center;color:var(--text-2);transition:background .15s}
.circle-btn:hover{background:var(--surface-sunken)}

.panel{background:#fff;border-radius:28px;padding:28px}
.panel-title{font-size:22px;font-weight:700;margin:0 0 8px}
.card{background:#fff;border-radius:22px;padding:22px}
.activity{list-style:none;margin:0;padding:0}
.activity li{display:flex;gap:16px;padding:18px 0;border-bottom:1px dashed var(--divider-dashed)}
.act-icon{flex:none;width:44px;height:44px;border-radius:50%;display:grid;place-items:center}
.act-ai{background:var(--lavender-soft);color:var(--violet)} .act-alert{background:var(--coral-soft);color:var(--coral-strong)} .act-win{background:var(--green-soft);color:var(--green)}
.act-title{font-weight:700;font-size:15px}
.act-desc{font-size:13px;color:#565656;margin-top:4px;line-height:1.55;word-break:break-word}
.act-time{font-size:12px;color:var(--text-faint);margin-top:4px}

.block{margin-top:64px}
.stat-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:16px}
.stat{background:#fff;border-radius:22px;padding:18px 20px}
.stat-label{font-size:13px;color:var(--text-muted)}
.stat-num{font-size:30px;font-variant-numeric:tabular-nums;margin-top:8px;letter-spacing:-.02em}
.stat-group-title{font-size:13px;font-weight:600;letter-spacing:.08em;color:var(--text-muted);margin:24px 0 10px}
.funnel{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px}
.funnel-step{background:#fff;border-radius:18px;padding:14px 16px}
.funnel-step .num{font-size:26px}
.briefing{margin:0;padding:0;list-style:none;display:grid;gap:8px}
.briefing li{background:#fff;border-radius:14px;padding:10px 16px;font-size:14px}

.lead-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.lead-card{background:#fff;border-radius:22px;padding:24px;display:flex;flex-direction:column;gap:14px}
.lead-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.lead-score{font-size:40px;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.02em;margin-right:4px}
.lead-score.hot{color:var(--coral-strong)}
.lead-owner{margin-left:auto;font-size:14px;color:var(--text-2);font-weight:500}
.lead-model{font-size:17px;font-weight:500}
.quote{background:var(--bg);border-left:3px solid var(--coral);border-radius:0 14px 14px 0;padding:12px 16px}
.quote p{margin:0;font-size:15px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.quote small{display:block;color:var(--text-muted);margin-top:6px;font-size:12px}
.merged{font-size:13px;color:var(--text-2);background:var(--lavender-soft);border-radius:12px;padding:10px 14px;line-height:1.5}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.ev{font-size:12px;padding:4px 10px;border-radius:999px;background:var(--lavender-soft);color:var(--violet)}
.chip-neutral{font-size:12px;padding:4px 10px;border-radius:999px;background:var(--surface-sunken);color:var(--text-3)}
details.breakdown summary{cursor:pointer;font-size:13px;color:var(--text-2)}
.bar-row{display:grid;grid-template-columns:96px 1fr 52px;gap:10px;align-items:center;font-size:12px;color:var(--text-3);margin-top:10px}
.bar-reason{font-size:12px;color:var(--text-faint);margin:2px 0 0 106px;line-height:1.4}
.bar{height:6px;background:var(--surface-sunken);border-radius:999px;overflow:hidden;display:block}
.bar i{display:block;height:100%;background:var(--coral);border-radius:999px}
.next{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--divider);padding-top:14px;font-size:14px;color:var(--text-2);flex-wrap:wrap}
.next b{font-weight:600;color:var(--text)}

.detail-grid{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:28px;align-items:start}
.kv{display:grid;grid-template-columns:120px 1fr;gap:8px 16px;font-size:14px}
.kv dt{color:var(--text-muted)} .kv dd{margin:0;word-break:break-word}
.timeline{list-style:none;margin:0;padding:0}
.timeline li{padding:12px 0;border-bottom:1px dashed var(--divider-dashed);font-size:14px}
.guards{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:6px}
.guards li{font-size:13px;display:flex;gap:8px;align-items:flex-start}
.guards .g-ok{color:var(--green)} .guards .g-review{color:var(--amber)} .guards .g-block{color:var(--red)}

.acct-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}
.acct{background:#fff;border-radius:22px;padding:22px;display:flex;flex-direction:column;gap:12px}
.acct-top{display:flex;gap:12px;align-items:center}
.acct-avatar{width:44px;height:44px;border-radius:50%;background:var(--lavender-soft);color:var(--violet);display:grid;place-items:center;font-weight:700;flex:none}
.acct-pos{margin:0;font-size:13px;color:var(--text-2);line-height:1.55}
.acct-meta{font-size:12px;color:var(--text-muted);display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 12px}
.acct-foot{display:flex;gap:8px;flex-wrap:wrap;margin-top:auto;align-items:center}
.density{display:flex;align-items:center;gap:10px}
.density .bar{width:110px}

.thread{display:flex;flex-direction:column;gap:12px}
.msg{max-width:78%;padding:12px 16px;border-radius:18px;font-size:14px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.msg-in{background:#fff;align-self:flex-start;border-top-left-radius:6px}
.msg-out{background:var(--lavender-soft);align-self:flex-end;border-top-right-radius:6px}
.msg-meta{font-size:12px;color:var(--text-faint);margin-top:6px;white-space:normal}

.calendar{display:grid;grid-template-columns:160px repeat(7,minmax(120px,1fr));gap:8px;min-width:1100px}
.cal-head{font-size:13px;color:var(--text-muted);padding:6px}
.cal-acct{font-size:14px;font-weight:500;padding:10px 6px}
.cal-cell{background:#fff;border-radius:14px;padding:8px;min-height:70px;display:flex;flex-direction:column;gap:6px}
.cal-post{font-size:12px;line-height:1.4;border-radius:10px;padding:6px 8px;background:var(--surface-sunken)}

form.stack label,.field{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--text-2)}
input[type=text],input[type=password],input[type=number],input[type=url],input[type=datetime-local],select,textarea{font:inherit;font-size:14px;color:var(--text);background:#fff;border:1px solid #E2E0DA;border-radius:12px;padding:10px 12px;width:100%}
textarea{min-height:96px;resize:vertical;line-height:1.55}
textarea.code{font-family:var(--font-mono);font-size:12px;min-height:220px}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;align-items:end}
.inline-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.inline-form input,.inline-form select{width:auto;min-width:120px}

.modal{position:fixed;inset:0;background:rgba(13,13,13,.36);display:grid;place-items:center;z-index:50;padding:16px}
.modal-card{background:#fff;border-radius:24px;padding:28px;max-width:420px;width:100%;text-align:center}
.qr-img{width:240px;height:240px;image-rendering:pixelated;margin:12px auto;display:block;border-radius:12px;border:1px solid var(--border)}
.toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);background:var(--ink);color:#fff;padding:12px 20px;border-radius:999px;font-size:14px;opacity:0;pointer-events:none;transition:all .2s;z-index:60;max-width:calc(100% - 32px)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast.err{background:var(--red)} .toast.ok{background:var(--green)}
.login-card{max-width:420px;margin:12vh auto 0;background:#fff;border-radius:28px;padding:36px}
.empty{background:#fff;border-radius:22px;padding:28px;color:var(--text-muted);text-align:center;font-size:14px}
.footnote{margin:56px 0 48px;color:var(--text-muted);font-size:13px;line-height:1.8;max-width:960px}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:18px}
.filters select,.filters input{width:auto;min-width:110px;border-radius:999px;padding:8px 14px}
.pager{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}

@media (max-width:1100px){
  .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .main-grid,.detail-grid{grid-template-columns:1fr}
  .stat-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .acct-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .lead-grid{grid-template-columns:1fr}
}
@media (max-width:760px){
  .search,.mode-pill{display:none}
  .topbar{gap:10px;height:68px}
  .brand{font-size:17px;gap:8px}
  .top-actions{gap:8px;margin-left:auto;min-width:0}
  .top-actions .pill-select{max-width:140px;min-width:0;height:38px}
  .top-actions a.small{display:none}
  .acct-grid{grid-template-columns:1fr}
  .stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  h1{font-size:32px}
  .kpi-num{font-size:46px}
  .kv{grid-template-columns:1fr}
  .data thead{display:none}
  .data tr{display:block;padding:12px 0;border-top:1px solid var(--divider)}
  .data td{display:block;border:0;padding:4px 0}
  .msg{max-width:92%}
}
@media (max-width:640px){.kpis{grid-template-columns:1fr}}
`;

export const CONSOLE_JS = `(() => {
  'use strict';
  const HEADERS = { 'content-type': 'application/json', 'x-console-request': '1' };
  function toast(msg, kind) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg;
    el.className = 'toast show ' + (kind || '');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = 'toast'; }, 3600);
  }
  async function call(url, method, body) {
    const res = await fetch(url, { method, headers: HEADERS, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('请先登录'); }
    if (!res.ok) throw new Error(data && data.error ? data.error.message : '请求失败（' + res.status + '）');
    return data;
  }
  function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) { if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = value;
  }
  function collect(root) {
    const out = {};
    if (!root) return out;
    const els = root.elements ? root.elements : root.querySelectorAll('input,select,textarea');
    for (const el of els) {
      if (!el.name || el.disabled) continue;
      if (el.type === 'checkbox') { setPath(out, el.name, el.checked); continue; }
      if (el.type === 'radio' && !el.checked) continue;
      if (el.type === 'file') continue;
      let value = el.value;
      const type = el.dataset.type;
      if (value === '' && el.hasAttribute('data-optional')) continue;
      if (type === 'number' || el.type === 'number') { if (value === '') continue; value = Number(value); }
      else if (type === 'json') { if (value.trim() === '') continue; try { value = JSON.parse(value); } catch (e) { throw new Error((el.dataset.label || el.name) + ' 不是有效的 JSON'); } }
      else if (type === 'lines') { value = value.split('\\n').map((s) => s.trim()).filter(Boolean); }
      else if (type === 'bool') { value = value === 'true'; }
      else if (type === 'datetime' && value) { value = new Date(value).toISOString(); }
      setPath(out, el.name, value);
    }
    return out;
  }
  function after(el, data) {
    if (el.dataset.success) toast(el.dataset.success, 'ok');
    const redirect = el.dataset.redirect;
    if (redirect === 'none') return;
    if (redirect) { location.href = redirect.replace('{id}', data && data.id ? encodeURIComponent(data.id) : ''); return; }
    setTimeout(() => location.reload(), el.dataset.success ? 500 : 0);
  }
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-api]');
    if (!form) return;
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    try {
      if (btn) btn.disabled = true;
      const body = collect(form);
      const fileInput = form.querySelector('input[type=file][data-json-into]');
      if (fileInput && fileInput.files && fileInput.files[0]) {
        const text = await fileInput.files[0].text();
        try { setPath(body, fileInput.dataset.jsonInto, JSON.parse(text)); } catch (err) { throw new Error('文件不是有效的 JSON'); }
      }
      const data = await call(form.dataset.api, form.dataset.method || 'POST', body);
      const out = form.querySelector('[data-result]');
      if (out) { out.textContent = JSON.stringify(data, null, 2); out.hidden = false; }
      after(form, data);
    } catch (err) { toast(err.message, 'err'); }
    finally { if (btn) btn.disabled = false; }
  });
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'copy') {
      e.preventDefault();
      const src = document.querySelector(el.dataset.target);
      const text = src ? (typeof src.value === 'string' ? src.value : src.textContent) : '';
      try { await navigator.clipboard.writeText(text); toast('已复制，请到对应账号的小红书 App 中粘贴发送', 'ok'); }
      catch (err) { if (src && src.select) src.select(); toast('浏览器不允许自动复制，已选中文本，请手动复制'); }
      return;
    }
    if (action === 'call') {
      e.preventDefault();
      if (el.dataset.confirm && el.dataset.armed !== '1') {
        el.dataset.armed = '1';
        el.dataset.label = el.textContent;
        el.textContent = el.dataset.confirm;
        setTimeout(() => { if (el.dataset.armed === '1') { el.dataset.armed = ''; el.textContent = el.dataset.label; } }, 4000);
        return;
      }
      el.dataset.armed = '';
      try {
        let body = {};
        if (el.dataset.body) body = JSON.parse(el.dataset.body);
        if (el.dataset.form) Object.assign(body, collect(document.querySelector(el.dataset.form)));
        el.disabled = true;
        const data = await call(el.dataset.url, el.dataset.method || 'POST', body);
        after(el, data);
      } catch (err) { toast(err.message, 'err'); }
      finally { el.disabled = false; if (el.dataset.label) el.textContent = el.dataset.label; }
      return;
    }
    if (action === 'qr-login') { e.preventDefault(); qrLogin(el); return; }
    if (action === 'close-modal') { e.preventDefault(); closeModal(); }
  });
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-dealer-switch]');
    if (!sel) return;
    const u = new URL(location.href);
    u.searchParams.set('dealer', sel.value);
    location.href = u.pathname + '?' + u.searchParams.toString();
  });
  let pollTimer = null;
  function closeModal() { const m = document.getElementById('modal'); if (m) m.remove(); if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function modal() {
    closeModal();
    const m = document.createElement('div');
    m.id = 'modal'; m.className = 'modal';
    const card = document.createElement('div'); card.className = 'modal-card';
    m.appendChild(card);
    m.addEventListener('click', (ev) => { if (ev.target === m) closeModal(); });
    document.body.appendChild(m);
    return card;
  }
  function el(tag, attrs, text) { const x = document.createElement(tag); for (const k in (attrs || {})) x.setAttribute(k, attrs[k]); if (text !== undefined) x.textContent = text; return x; }
  function closeBtn(label) { return el('button', { class: 'btn btn-ghost', 'data-action': 'close-modal', type: 'button' }, label || '关闭'); }
  async function qrLogin(btn) {
    const card = modal();
    card.appendChild(el('h3', {}, '扫码登录小红书'));
    card.appendChild(el('p', { class: 'muted' }, '正在向该账号的 xiaohongshu-mcp 实例请求登录二维码…'));
    try {
      const data = await call(btn.dataset.url, 'POST', {});
      card.textContent = '';
      if (data.already_logged_in) {
        card.appendChild(el('h3', {}, '已登录'));
        card.appendChild(el('p', {}, data.detail || '该实例已处于登录状态'));
        card.appendChild(closeBtn());
        if (btn.dataset.syncUrl) call(btn.dataset.syncUrl, 'POST', {}).then(() => setTimeout(() => location.reload(), 600)).catch(() => {});
        return;
      }
      card.appendChild(el('h3', {}, '用小红书 App 扫码登录'));
      const who = (btn.dataset.account || '') + (data.expires_at ? ' · 请在 ' + new Date(data.expires_at).toLocaleTimeString('zh-CN') + ' 前扫码' : '');
      card.appendChild(el('p', { class: 'muted' }, who));
      if (typeof data.image_data_url === 'string' && data.image_data_url.indexOf('data:image/') === 0) card.appendChild(el('img', { class: 'qr-img', alt: '登录二维码', src: data.image_data_url }));
      card.appendChild(el('p', { class: 'small muted' }, '请使用该账号本人的小红书 App 扫码。二维码只显示在此窗口，不会被保存。'));
      const status = el('p', { class: 'small', id: 'qr-status' }, '等待扫码…');
      card.appendChild(status);
      card.appendChild(closeBtn());
      const deadline = data.expires_at ? Date.parse(data.expires_at) : Date.now() + 240000;
      pollTimer = setInterval(async () => {
        if (Date.now() > deadline) { status.textContent = '二维码已过期，请关闭后重新获取'; clearInterval(pollTimer); pollTimer = null; return; }
        if (!btn.dataset.syncUrl) return;
        try {
          const r = await call(btn.dataset.syncUrl, 'POST', {});
          if (r && r.auth_state === 'authenticated') { status.textContent = '登录成功，正在刷新…'; clearInterval(pollTimer); pollTimer = null; setTimeout(() => location.reload(), 800); }
          else if (r && r.reason) status.textContent = '等待扫码… ' + r.reason;
        } catch (err) { status.textContent = err.message; }
      }, 5000);
    } catch (err) {
      card.textContent = '';
      card.appendChild(el('h3', {}, '无法获取二维码'));
      card.appendChild(el('p', {}, err.message));
      card.appendChild(closeBtn());
    }
  }
})();
`;
