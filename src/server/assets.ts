import { createHash } from 'node:crypto';

/**
 * Static console assets (served from /assets/*): the 驭客 Steer stylesheet (docs/UI_DESIGN.md, docs/design/steer-ui-kit.html) and a
 * small vanilla script for actions. No external fonts or CDNs — the console must work on a private network.
 */

export const CONSOLE_CSS = `
/* 驭客 Steer console: tokens and components from docs/design/steer-ui-kit.html (binding spec: docs/UI_DESIGN.md) */
:root{
  --st-canvas:#F7F6F2;--st-surface:#FFFFFF;--st-surface-2:#FAF9F6;--st-sunken:#F0EEE8;--st-line:#E8E6E0;--st-line-strong:#D5D2CA;
  --st-text:#181817;--st-text-2:#45443F;--st-muted:#6B6A66;
  --st-gold:#B69A70;--st-gold-ink:#7D6440;--st-gold-soft:#F4EEE4;--st-gold-line:#E3D6C0;
  --st-ok:#37704A;--st-ok-soft:#EAF2EC;--st-warn:#9A6414;--st-warn-soft:#F8EFDF;--st-bad:#A8403A;--st-bad-soft:#F7E9E7;
  --st-primary-bg:#181817;--st-primary-fg:#FFFFFF;--st-primary-hover:#2E2D2A;
  --st-mark-a:#232322;--st-mark-b:#3A3A39;--st-mark-fold:#6E6D6A;--st-mark-end:#1E1E1D;
  /* Three radii, one rule: controls 6, surfaces 10, and a pill ONLY for a status badge. */
  --st-r-control:6px;--st-r-surface:10px;--st-r-pill:999px;
  --st-r-xl:var(--st-r-surface);--st-r-lg:var(--st-r-surface);--st-r-md:var(--st-r-control);--st-r-sm:var(--st-r-control);
  /* Six type steps. Nothing lives between them. */
  --st-fs-micro:11px;--st-fs-meta:12px;--st-fs-body:13px;--st-fs-item:15px;--st-fs-head:17px;--st-fs-page:21px;--st-fs-metric:26px;
  /* Two control heights, everywhere. */
  --st-ctl:32px;--st-ctl-sm:26px;
  --st-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC","Segoe UI",sans-serif;
  --st-font-num:"SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
  --st-font-mono:"SF Mono",ui-monospace,Menlo,Consolas,monospace;
  --st-ease:cubic-bezier(.2,.8,.2,1);--st-t-fast:150ms;--st-t-base:200ms;--st-t-slow:250ms;
  --st-lift:0 1px 2px rgba(24,24,23,.05);
  --st-sidebar-w:216px;--st-sidebar-rail:60px;--st-rail-w:320px;
  color-scheme:light;
  /* legacy aliases still referenced by inline styles in page templates */
  --border:var(--st-line);--amber:var(--st-warn);--red:var(--st-bad);--green:var(--st-ok);
}
:root[data-theme="dark"]{
  --st-canvas:#131312;--st-surface:#1A1A18;--st-surface-2:#1F1F1D;--st-sunken:#262623;--st-line:#2D2C29;--st-line-strong:#3D3C38;
  --st-text:#EEECE6;--st-text-2:#CAC7BF;--st-muted:#9E9B93;
  --st-gold:#C4A97F;--st-gold-ink:#D9C198;--st-gold-soft:#2A251D;--st-gold-line:#4A3F2E;
  --st-ok:#82B794;--st-ok-soft:#1C2A21;--st-warn:#DDA85C;--st-warn-soft:#2D2518;--st-bad:#E38D85;--st-bad-soft:#2F1D1B;
  --st-primary-bg:#EEECE6;--st-primary-fg:#1A1A18;--st-primary-hover:#D9D6CE;
  --st-mark-a:#E9E6DF;--st-mark-b:#CFCBC2;--st-mark-fold:#9A968D;--st-mark-end:#6F6A61;
  --st-lift:0 1px 2px rgba(0,0,0,.35);
  color-scheme:dark;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --st-canvas:#131312;--st-surface:#1A1A18;--st-surface-2:#1F1F1D;--st-sunken:#262623;--st-line:#2D2C29;--st-line-strong:#3D3C38;
    --st-text:#EEECE6;--st-text-2:#CAC7BF;--st-muted:#9E9B93;
    --st-gold:#C4A97F;--st-gold-ink:#D9C198;--st-gold-soft:#2A251D;--st-gold-line:#4A3F2E;
    --st-ok:#82B794;--st-ok-soft:#1C2A21;--st-warn:#DDA85C;--st-warn-soft:#2D2518;--st-bad:#E38D85;--st-bad-soft:#2F1D1B;
    --st-primary-bg:#EEECE6;--st-primary-fg:#1A1A18;--st-primary-hover:#D9D6CE;
    --st-mark-a:#E9E6DF;--st-mark-b:#CFCBC2;--st-mark-fold:#9A968D;--st-mark-end:#6F6A61;
    --st-lift:0 1px 2px rgba(0,0,0,.35);
    color-scheme:dark;
  }
}

/* base */
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0}
body{background:var(--st-canvas);color:var(--st-text);font:var(--st-fs-body)/1.55 var(--st-font);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1,h2,h3,p,dl,dd,blockquote{margin:0}
h1,h2,h3{font-weight:600}
h3{font-size:var(--st-fs-item);margin-bottom:8px}
button,input,textarea,select{font:inherit;color:inherit}
a{color:inherit;text-decoration:none}
a.link{color:var(--st-text-2);border-bottom:1px solid var(--st-line-strong)}
a.link:hover{color:var(--st-text);border-color:var(--st-text)}
:focus-visible{outline:2px solid var(--st-text);outline-offset:2px;border-radius:var(--st-r-control)}
.muted{color:var(--st-muted)} .small{font-size:var(--st-fs-body)} .tiny{font-size:var(--st-fs-meta)}
.num,.st-num{font-family:var(--st-font-num);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.mono{font-family:var(--st-font-mono);font-size:var(--st-fs-meta);color:var(--st-text-2);word-break:break-all}
.nowrap{white-space:nowrap}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.spacer{flex:1}
.stack{display:flex;flex-direction:column;gap:12px}
.grad{color:inherit}
.st-icon{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.st-icon-sm{width:14px;height:14px}

/* shell: a labelled rail that collapses to icons (cookie st_rail, so it never renders wide and snaps shut) */
body.app{display:grid;grid-template-columns:var(--st-sidebar-w) minmax(0,1fr);min-height:100vh;min-height:100dvh}
body.app.is-rail{--st-sidebar-w:var(--st-sidebar-rail)}
.sidebar{position:sticky;top:0;height:100vh;height:100dvh;display:flex;flex-direction:column;padding:0 0 10px;border-right:1px solid var(--st-line);background:var(--st-surface-2);z-index:20}
.sidebar-head{display:flex;align-items:center;gap:8px;height:52px;padding:0 10px 0 14px;flex:none}
.brand{display:flex;align-items:center;gap:9px;min-width:0;color:var(--st-text)}
.brand svg{width:17px;height:24px;flex:none}
.brand-name{font-size:var(--st-fs-body);font-weight:600;letter-spacing:.01em;white-space:nowrap}
.rail-btn{margin-left:auto}
.nav{display:flex;flex-direction:column;gap:14px;padding:6px 8px 0;overflow-y:auto;scrollbar-width:none}
.nav::-webkit-scrollbar{display:none}
.nav-group{display:flex;flex-direction:column;gap:1px}
.nav-group-label{padding:0 8px 5px;font-size:var(--st-fs-micro);font-weight:500;color:var(--st-muted);letter-spacing:.06em;white-space:nowrap}
.nav-item{position:relative;display:flex;align-items:center;gap:9px;height:30px;padding:0 8px;border-radius:var(--st-r-control);color:var(--st-text-2);font-size:var(--st-fs-body);white-space:nowrap;transition:background-color var(--st-t-fast) var(--st-ease),color var(--st-t-fast) var(--st-ease)}
.nav-glyph{display:grid;place-items:center;width:18px;height:18px;flex:none;color:var(--st-muted)}
.nav-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.nav-item:hover{background:var(--st-sunken);color:var(--st-text)}
.nav-item:hover .nav-glyph{color:var(--st-text-2)}
.nav-item.active{background:var(--st-surface);color:var(--st-text);font-weight:600;box-shadow:inset 0 0 0 1px var(--st-line)}
.nav-item.active .nav-glyph{color:var(--st-text)}
.nav-badge{margin-left:auto;min-width:17px;height:17px;padding:0 5px;border-radius:var(--st-r-pill);background:var(--st-primary-bg);color:var(--st-primary-fg);font-size:var(--st-fs-micro);font-weight:600;display:grid;place-items:center;font-family:var(--st-font-num)}
body.is-rail .brand-name,body.is-rail .nav-label,body.is-rail .nav-group-label{display:none}
body.is-rail .sidebar-head{padding:0;justify-content:center}
body.is-rail .rail-btn{display:none}
body.is-rail .nav{align-items:center;gap:10px}
body.is-rail .nav-group{width:100%;align-items:center}
body.is-rail .nav-group+.nav-group{padding-top:10px;border-top:1px solid var(--st-line)}
body.is-rail .nav-item{width:34px;justify-content:center;padding:0;gap:0}
body.is-rail .nav-badge{position:absolute;top:-2px;right:-4px;margin:0}
.sidebar-foot{margin-top:auto;display:flex;align-items:center;gap:6px;padding:10px 12px 0;border-top:1px solid var(--st-line)}
body.is-rail .sidebar-foot{flex-direction:column;padding-inline:0}
.icon-btn{display:grid;place-items:center;width:28px;height:28px;border-radius:var(--st-r-control);border:1px solid transparent;background:none;color:var(--st-muted);cursor:pointer;transition:color var(--st-t-fast) var(--st-ease),background-color var(--st-t-fast) var(--st-ease)}
.icon-btn:hover{color:var(--st-text);background:var(--st-sunken)}
.operator{display:grid;place-items:center;width:26px;height:26px;margin-left:auto;border-radius:50%;background:var(--st-sunken);color:var(--st-text-2);font-size:var(--st-fs-micro);font-weight:600}
body.is-rail .operator{margin:0}
.operator:hover{box-shadow:0 0 0 1px var(--st-line-strong)}

.workspace{min-width:0;display:flex;flex-direction:column}
.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:14px;height:52px;padding:0 24px;background:color-mix(in srgb,var(--st-canvas) 90%,transparent);-webkit-backdrop-filter:saturate(1.2) blur(10px);backdrop-filter:saturate(1.2) blur(10px);border-bottom:1px solid var(--st-line)}
.agent-now{display:flex;align-items:center;gap:8px;min-width:0;font-size:var(--st-fs-meta);color:var(--st-text-2)}
.agent-text{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent-text b{font-weight:600;color:var(--st-text);margin-left:.25em}
.agent-ago{color:var(--st-muted);white-space:nowrap}
.topbar-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.search{display:flex;align-items:center;gap:6px;width:210px;height:var(--st-ctl);padding:0 10px;border:1px solid var(--st-line);border-radius:var(--st-r-control);background:var(--st-surface);color:var(--st-muted)}
.search:focus-within{border-color:var(--st-line-strong);box-shadow:0 0 0 3px var(--st-sunken)}
.search svg{width:14px;height:14px}
.search input{flex:1;min-width:0;border:0;outline:0;background:transparent;font-size:var(--st-fs-body);color:var(--st-text)}
.search input::placeholder{color:var(--st-muted)}
.store-pill{display:inline-flex;align-items:center;height:var(--st-ctl);padding:0 2px 0 10px;border:1px solid var(--st-line);border-radius:var(--st-r-control);background:var(--st-surface)}
.store-select{border:0;background:transparent;font-size:var(--st-fs-body);height:calc(var(--st-ctl) - 2px);padding:0 4px 0 0;max-width:180px;color:var(--st-text);cursor:pointer;min-height:0}
.store-select:focus{outline:0}
.store-empty{font-size:var(--st-fs-body);color:var(--st-muted);padding-right:8px}
.content{width:100%;max-width:1560px;margin:0 auto;padding:24px 28px 64px;display:flex;flex-direction:column;gap:0}
.page-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:24px}
h1{font-size:var(--st-fs-page);line-height:1.25;letter-spacing:-.015em}
.h1-meta{font-size:var(--st-fs-item);font-weight:500;color:var(--st-muted)}
.subtitle{color:var(--st-muted);font-size:var(--st-fs-meta)}
.page-head .subtitle::before{content:"";display:inline-block;width:1px;height:11px;margin-right:10px;background:var(--st-line-strong);vertical-align:-1px}
@media (max-width:1180px) and (min-width:901px){
  body.app{grid-template-columns:var(--st-sidebar-rail) minmax(0,1fr)}
  .brand-name,.nav-label,.nav-group-label{display:none}
  .sidebar-head{padding:0;justify-content:center}
  .rail-btn{display:none}
  .nav{align-items:center}
  .nav-group{width:100%;align-items:center}
  .nav-group+.nav-group{padding-top:10px;border-top:1px solid var(--st-line)}
  .nav-item{width:34px;justify-content:center;padding:0;gap:0}
  .nav-badge{position:absolute;top:-2px;right:-4px;margin:0}
  .sidebar-foot{flex-direction:column;padding-inline:0}
  .search{width:150px}
}

/* status dot (semantic state only) */
.st-dot{position:relative;display:inline-block;width:8px;height:8px;border-radius:50%;flex:none;background:var(--st-muted)}
.st-dot-ok{background:var(--st-ok)} .st-dot-warn{background:var(--st-warn)} .st-dot-bad{background:var(--st-bad)}
.st-dot-idle{background:none;box-shadow:inset 0 0 0 1.5px var(--st-muted)}
.st-dot-ai{background:var(--st-gold)}
.st-dot-ai.is-running::after{content:"";position:absolute;inset:-4px;border-radius:50%;background:var(--st-gold);opacity:0;animation:st-breathe 2.4s var(--st-ease) infinite}

/* banners */
.banner{display:block;padding:12px 16px;border-radius:var(--st-r-surface);font-size:var(--st-fs-body);border:1px solid;margin:0 0 12px;color:var(--st-text);line-height:1.6}
.banner-amber{background:var(--st-warn-soft);border-color:color-mix(in srgb,var(--st-warn) 28%,transparent)}
.banner-red{background:var(--st-bad-soft);border-color:color-mix(in srgb,var(--st-bad) 28%,transparent)}
.banner-violet{background:var(--st-gold-soft);border-color:var(--st-gold-line)}
.banner-green{background:var(--st-ok-soft);border-color:color-mix(in srgb,var(--st-ok) 28%,transparent)}
.banner a.link{margin-left:6px;white-space:nowrap}

/* surfaces */
.card{background:var(--st-surface);border:1px solid var(--st-line);border-radius:var(--st-r-surface);padding:16px 18px}
.panel{padding:0}
.panel+.panel{margin-top:28px}
.panel-title{font-size:var(--st-fs-body);font-weight:600;margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid var(--st-line-strong)}
.panel>details>summary.panel-title{margin-bottom:10px}
.block{margin-top:40px}
.section-head{display:flex;align-items:baseline;gap:12px;margin-bottom:12px;padding-bottom:9px;border-bottom:1px solid var(--st-line-strong);flex-wrap:wrap}
.section-title{font-size:var(--st-fs-head);font-weight:600;letter-spacing:-.012em;color:var(--st-text)}
.section-head .muted.small,.section-head .st-help{color:var(--st-muted)}
.section-head+.toolbar{margin-top:2px}
.section-head .muted.small{font-size:var(--st-fs-meta)}
/* A toolbar is one row: what you are looking at on the left, what you can do on the right. */
.toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.toolbar .filters-more{flex-basis:auto;margin:0}
.toolbar>.spacer{flex:1 1 auto;min-width:0}
.live{display:inline-flex;align-items:center;gap:5px;font-size:var(--st-fs-meta);color:var(--st-muted)}
.live::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--st-ok)}
.empty{padding:26px 20px;border:1px solid var(--st-line);border-radius:var(--st-r-surface);background:var(--st-surface-2);color:var(--st-muted);font-size:var(--st-fs-body);text-align:left}
.footnote{margin:28px 0 0;color:var(--st-muted);font-size:var(--st-fs-meta);line-height:1.7;max-width:960px}
.st-help{font-size:var(--st-fs-meta);color:var(--st-muted)}
.st-link{display:inline-flex;align-items:center;gap:4px;color:var(--st-text-2);font-size:var(--st-fs-meta);border-bottom:1px solid var(--st-line-strong);line-height:1.3}
.st-link:hover{color:var(--st-text);border-color:var(--st-text)}
.section-head .st-link{margin-left:auto}

/* KPI tiles */
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;background:var(--st-surface);border:1px solid var(--st-line);border-radius:var(--st-r-surface)}
.kpi{padding:14px 18px;display:flex;flex-direction:column;gap:5px;min-width:0;border-left:1px solid var(--st-line)}
.kpi:first-child{border-left:0}
.kpi-dot{display:none}
.kpi-label{font-size:var(--st-fs-meta);font-weight:500;color:var(--st-muted);order:-1}
.kpi-num{font-family:var(--st-font-num);font-variant-numeric:tabular-nums;letter-spacing:-.025em;font-size:var(--st-fs-metric);font-weight:600;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:var(--st-fs-meta);color:var(--st-muted)}
@media (max-width:1100px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi:nth-child(3){border-left:0}.kpi:nth-child(n+3){border-top:1px solid var(--st-line)}}
.chip{height:20px;display:inline-flex;align-items:center;padding:0 7px;border-radius:var(--st-r-control);font-size:var(--st-fs-micro);font-weight:500;background:var(--st-sunken);color:var(--st-text-2)}
.kpi.outline .kpi-num{color:var(--st-gold-ink)}
.main-grid{display:grid;grid-template-columns:minmax(0,1fr) var(--st-rail-w);gap:28px;margin-top:0;align-items:start}

/* buttons: primary (one per view) · ink/ghost (secondary) · danger */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:var(--st-ctl);padding:0 12px;border-radius:var(--st-r-control);border:1px solid transparent;background:none;cursor:pointer;font-size:var(--st-fs-body);font-weight:500;white-space:nowrap;transition:background-color var(--st-t-fast) var(--st-ease),border-color var(--st-t-fast) var(--st-ease),color var(--st-t-fast) var(--st-ease)}
.btn:active:not(:disabled){transform:scale(.985)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn-primary{background:var(--st-primary-bg);color:var(--st-primary-fg)} .btn-primary:hover:not(:disabled){background:var(--st-primary-hover)}
.btn-ink{border-color:var(--st-line-strong);color:var(--st-text);background:var(--st-surface)} .btn-ink:hover:not(:disabled){border-color:var(--st-text)}
.btn-ghost{border-color:var(--st-line);color:var(--st-text-2);background:var(--st-surface)} .btn-ghost:hover:not(:disabled){border-color:var(--st-line-strong);color:var(--st-text)}
.btn-danger{border-color:color-mix(in srgb,var(--st-bad) 30%,transparent);color:var(--st-bad);background:var(--st-surface)} .btn-danger:hover:not(:disabled){background:var(--st-bad-soft)}
.btn-sm{height:var(--st-ctl-sm);padding:0 9px;font-size:var(--st-fs-meta)}
.btn-lg{height:38px;padding:0 16px}
.btn-muted{display:flex;align-items:center;justify-content:center;height:var(--st-ctl);margin-top:8px;border:1px solid var(--st-line);border-radius:var(--st-r-control);font-size:var(--st-fs-meta);color:var(--st-text-2)}
.btn-muted:hover{border-color:var(--st-line-strong);color:var(--st-text)}
.circle-btn{width:var(--st-ctl-sm);height:var(--st-ctl-sm);border-radius:var(--st-r-control);border:1px solid var(--st-line);background:var(--st-surface);display:grid;place-items:center;color:var(--st-muted)}
.circle-btn:hover{border-color:var(--st-line-strong);color:var(--st-text)}

/* tables */
.table-wrap{overflow-x:auto}
table.data{width:100%;border-collapse:collapse}
.data th{font-size:var(--st-fs-micro);font-weight:500;color:var(--st-muted);text-align:left;padding:0 16px 7px 0;white-space:nowrap;border-bottom:1px solid var(--st-line-strong);letter-spacing:.02em}
.data td{padding:10px 16px 10px 0;border-bottom:1px solid var(--st-line);vertical-align:middle;font-size:var(--st-fs-body)}
.data th:last-child,.data td:last-child{padding-right:0}
.data tbody tr:last-child td{border-bottom:0}
.data tbody tr:hover td{background:color-mix(in srgb,var(--st-sunken) 55%,transparent)}
.data tbody tr:hover td:first-child{box-shadow:inset 2px 0 0 var(--st-line-strong)}
.data.compact td{padding:8px 14px 8px 0;font-size:var(--st-fs-meta)}
.id-pill{display:inline-grid;place-items:center;min-width:30px;height:20px;padding:0 6px;border-radius:var(--st-r-control);border:1px solid var(--st-line-strong);font-family:var(--st-font-num);font-variant-numeric:tabular-nums;font-size:var(--st-fs-meta);font-weight:600;color:var(--st-text-2)}
.id-pill.hot{border-color:var(--st-gold-line);color:var(--st-gold-ink);background:var(--st-gold-soft)}
.primary{font-size:var(--st-fs-body);font-weight:600}
.secondary{font-size:var(--st-fs-meta);color:var(--st-muted);margin-top:1px}
.quote-cell{color:var(--st-text-2);font-size:var(--st-fs-body)}

/* badges (pill): gold = key state / AI executing, never decoration */
.status{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:var(--st-r-pill);font-size:var(--st-fs-micro);font-weight:500;white-space:nowrap;vertical-align:middle;background:var(--st-sunken);color:var(--st-text-2)}
.s-green{background:var(--st-ok-soft);color:var(--st-ok)} .s-amber{background:var(--st-warn-soft);color:var(--st-warn)} .s-red{background:var(--st-bad-soft);color:var(--st-bad)}
.s-violet,.s-coral{background:var(--st-gold-soft);color:var(--st-gold-ink);box-shadow:inset 0 0 0 1px var(--st-gold-line)}
.s-coral-soft{background:none;color:var(--st-text-2);box-shadow:inset 0 0 0 1px var(--st-line-strong)}
.s-neutral{background:var(--st-sunken);color:var(--st-text-2)}
.mode-pill{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:var(--st-r-pill);font-size:var(--st-fs-micro);font-weight:500;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.mode-live{box-shadow:inset 0 0 0 1px var(--st-line-strong);color:var(--st-text-2)}
.mode-simulation{background:var(--st-gold-soft);color:var(--st-gold-ink);box-shadow:inset 0 0 0 1px var(--st-gold-line)}
.mode-none{background:var(--st-bad-soft);color:var(--st-bad)}

/* unfinished-feature placeholders: dashed, neutral, never look actionable */
.ph-tag{display:inline-flex;align-items:center;height:20px;padding:0 8px;margin-left:6px;border:1px dashed var(--st-line-strong);border-radius:var(--st-r-control);font-size:var(--st-fs-micro);font-weight:500;color:var(--st-muted);background:var(--st-surface-2);white-space:nowrap;vertical-align:middle;cursor:help}
.btn-placeholder{background:var(--st-surface-2);color:var(--st-muted);border:1px dashed var(--st-line-strong);cursor:help}
.btn-placeholder:disabled{opacity:1;cursor:help}
.btn-placeholder .ph-tag{border:0;background:transparent;padding:0;margin-left:4px;height:auto}
.ph-block{border:1px dashed var(--st-line-strong);border-radius:var(--st-r-lg);background:var(--st-surface-2);padding:16px 18px;color:var(--st-muted);font-size:var(--st-fs-body);line-height:1.6}
.ph-block p{margin:4px 0 0}
.ph-head{display:flex;align-items:center;gap:6px}
.ph-title{font-size:var(--st-fs-body);font-weight:600;color:var(--st-text-2)}
.ph-head .ph-tag{margin-left:0}

/* activity stream (Steer 动态) */
.activity{list-style:none;margin:0;padding:0;position:relative}
.activity::before{content:"";position:absolute;left:4px;top:10px;bottom:16px;width:1px;background:var(--st-line)}
.activity li{position:relative;padding:10px 0 12px 22px;display:grid;gap:4px}
.activity li::before{content:"";position:absolute;left:0;top:16px;width:9px;height:9px;border-radius:50%;background:var(--st-surface);box-shadow:inset 0 0 0 1.5px var(--st-line-strong)}
.activity li:first-child::before{background:var(--st-gold);box-shadow:0 0 0 3px var(--st-gold-soft)}
.act-icon{display:none}
.act-title{font-size:var(--st-fs-body);line-height:1.5;font-weight:500}
.act-desc{font-size:var(--st-fs-meta);color:var(--st-text-2);line-height:1.55;word-break:break-word}
.act-time{font-family:var(--st-font-mono);font-size:var(--st-fs-micro);color:var(--st-muted);order:-1}
.rail{position:sticky;top:72px;display:flex;flex-direction:column;gap:12px;padding-left:24px;border-left:1px solid var(--st-line)}
.rail-card{padding:0}
.rail-head{display:flex;align-items:center;gap:7px;margin-bottom:6px;padding-bottom:7px;border-bottom:1px solid var(--st-line-strong)}
.rail-head h2{font-size:var(--st-fs-body);font-weight:600}
.rail-head .live{margin-left:auto}
.rail-note{font-size:var(--st-fs-meta);color:var(--st-muted);line-height:1.6;padding:0 4px}

/* metrics */
.stat-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:0;border-top:1px solid var(--st-line-strong);border-bottom:1px solid var(--st-line)}
.stat{padding:11px 16px 12px 0}
.stat+.stat{padding-left:16px;border-left:1px solid var(--st-line)}
.stat-label{font-size:var(--st-fs-meta);color:var(--st-muted)}
.stat-num{font-family:var(--st-font-num);font-variant-numeric:tabular-nums;letter-spacing:-.025em;font-size:var(--st-fs-item);font-weight:600;margin-top:2px}
.stat-group-title{font-size:var(--st-fs-item);font-weight:600;margin:24px 0 10px}
@media (max-width:1100px){.stat-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.stat:nth-child(4){border-left:0}.stat:nth-child(n+4){border-top:1px solid var(--st-line)}}
.stat-group-title:first-child{margin-top:0}
.funnel{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));border-top:1px solid var(--st-line-strong);border-bottom:1px solid var(--st-line);overflow-x:auto}
.funnel-step{position:relative;padding:12px 16px 13px 0;display:grid;gap:1px}
.funnel-step+.funnel-step{padding-left:16px;border-left:1px solid var(--st-line)}
.funnel-step .num{font-size:var(--st-fs-metric);font-weight:600;line-height:1.15;font-family:var(--st-font-num);font-variant-numeric:tabular-nums;letter-spacing:-.025em}
.briefing{margin:0;padding:0;list-style:none;border-top:1px solid var(--st-line-strong)}
.briefing li{padding:10px 0;font-size:var(--st-fs-body);border-bottom:1px solid var(--st-line)}
.briefing li:last-child{border-bottom:0}

/* leads */
.lead-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px}
.lead-list{background:var(--st-surface);border:1px solid var(--st-line);border-radius:var(--st-r-lg);overflow:hidden}
.lead-head,.lead-row{display:grid;grid-template-columns:56px minmax(0,1fr) 190px 190px 110px 108px;gap:14px;align-items:center}
.lead-head{padding:8px 16px;border-bottom:1px solid var(--st-line);background:var(--st-surface-2);font-size:var(--st-fs-micro);color:var(--st-muted);letter-spacing:.04em}
.lead-row{position:relative;padding:10px 16px;border-bottom:1px solid var(--st-line);transition:background var(--st-t-fast) var(--st-ease)}
.lead-row:last-child{border-bottom:none}
.lead-row:hover{background:var(--st-surface-2)}
.lead-row:has(.lead-open:focus-visible){background:var(--st-surface-2);outline:2px solid var(--st-text);outline-offset:-2px}
.lead-open::after{content:"";position:absolute;inset:0;z-index:0}
.lead-open{color:inherit;text-decoration:none}
.lead-col-score{display:flex;flex-direction:column;align-items:flex-start;gap:1px}
.lead-row .lead-score{font-size:var(--st-fs-page);font-weight:500;color:var(--st-text-2);margin:0}
.lead-row.is-hot .lead-score{color:var(--st-gold-ink);font-weight:600}
.lead-tier{font-size:var(--st-fs-micro);color:var(--st-muted)}
.lead-col-signal{display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-rows:auto auto;column-gap:9px;row-gap:3px;align-items:center;min-width:0}
.lead-col-signal .avatar{grid-row:1/3}
.avatar{position:relative;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:0 0 auto;border-radius:50%;background:var(--st-sunken);color:var(--st-muted);font-size:var(--st-fs-meta);overflow:hidden}
.avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.avatar-sm{width:22px;height:22px;font-size:var(--st-fs-micro)}
.avatar-lg{width:40px;height:40px;font-size:var(--st-fs-item)}
.lead-row-quote{font-size:var(--st-fs-body);line-height:1.45;color:var(--st-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lead-row-meta{display:flex;align-items:center;gap:6px;font-size:var(--st-fs-micro);color:var(--st-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row-flag{border:1px solid var(--st-line-strong);border-radius:var(--st-r-control);padding:0 5px;line-height:15px;font-size:var(--st-fs-micro);color:var(--st-text-2)}
.lead-col-why{display:flex;flex-wrap:wrap;gap:4px;min-width:0}
.lead-col-why .ev{max-width:100%;overflow:hidden;text-overflow:ellipsis}
.lead-col-origin{display:flex;flex-direction:column;gap:2px;min-width:0;font-size:var(--st-fs-micro);color:var(--st-muted)}
.lead-origin-post{color:var(--st-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lead-origin-query{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lead-col-origin .link{position:relative;z-index:1}
.lead-col-owner{display:flex;align-items:center;gap:6px;min-width:0;font-size:var(--st-fs-meta);color:var(--st-text-2)}
.lead-owner-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lead-col-status{display:flex;flex-direction:column;align-items:flex-end;gap:1px;font-size:var(--st-fs-meta);color:var(--st-muted);text-align:right;white-space:nowrap}
.lead-col-status.is-wait{color:var(--st-gold-ink)}
.lead-col-status.is-stop{color:var(--st-bad)}
.lead-stage{font-size:var(--st-fs-micro);color:var(--st-muted)}
@media (max-width:1400px){
  .lead-head,.lead-row{grid-template-columns:56px minmax(0,1fr) 190px 110px 108px}
  .lead-head span:nth-child(3),.lead-col-why{display:none}
}
@media (max-width:1120px){
  .lead-head,.lead-row{grid-template-columns:56px minmax(0,1fr) 108px}
  .lead-head span:nth-child(4),.lead-head span:nth-child(5),.lead-col-origin,.lead-col-owner{display:none}
}
.chips{display:flex;flex-wrap:wrap;gap:5px}
.ev-lines{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:3px}
.ev-lines li{position:relative;padding-left:12px;font-size:var(--st-fs-meta);color:var(--st-text-2);line-height:1.55}
.ev-lines li::before{content:"";position:absolute;left:3px;top:8px;width:3px;height:3px;border-radius:50%;background:var(--st-line-strong)}
.ev,.chip-neutral{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:var(--st-r-control);border:1px solid var(--st-line);background:var(--st-surface-2);color:var(--st-text-2);font-size:var(--st-fs-micro);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
details.breakdown summary{cursor:pointer;font-size:var(--st-fs-meta);color:var(--st-text-2);list-style:none;display:inline-flex;align-items:center;gap:6px;height:var(--st-ctl-sm);padding:0 9px;border-radius:var(--st-r-control);border:1px solid var(--st-line);background:var(--st-surface-2)}
details.breakdown summary::-webkit-details-marker{display:none}
details.breakdown[open] summary{border-color:var(--st-text);color:var(--st-text)}
details.breakdown[open]>*:not(summary){animation:st-enter var(--st-t-base) var(--st-ease)}
.bar-row{display:grid;grid-template-columns:96px 1fr 52px;gap:10px;align-items:center;font-size:var(--st-fs-meta);color:var(--st-text-2);margin-top:10px}
.bar-reason{font-size:var(--st-fs-meta);color:var(--st-muted);margin:2px 0 0 106px;line-height:1.4}
.bar{height:4px;background:var(--st-sunken);border-radius:999px;overflow:hidden;display:block}
.bar i{display:block;height:100%;background:var(--st-gold);border-radius:999px}
.next{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--st-line);padding-top:10px;margin-top:2px;font-size:var(--st-fs-meta);color:var(--st-text-2);flex-wrap:wrap}
.ev-more{cursor:help}
.next b{font-weight:600;color:var(--st-text)}

.detail-grid{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:0 32px;align-items:start}
.detail-grid>*+*{padding-left:32px;margin-left:-32px;border-left:1px solid var(--st-line)}
@media (max-width:1000px){.detail-grid{grid-template-columns:minmax(0,1fr);gap:28px}.detail-grid>*+*{padding-left:0;margin-left:0;border-left:0}}
.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:0;font-size:var(--st-fs-body);margin:0}
.kv dt{padding:7px 18px 7px 0;color:var(--st-muted);font-size:var(--st-fs-meta);white-space:nowrap;border-bottom:1px solid var(--st-line)}
.kv dd{margin:0;padding:7px 0;word-break:break-word;border-bottom:1px solid var(--st-line)}
.kv dt:last-of-type,.kv dd:last-of-type{border-bottom:0}
.kv-missing{margin:10px 0 0;font-size:var(--st-fs-meta);color:var(--st-muted)}
.timeline{list-style:none;margin:0;padding:0}
.timeline li{padding:10px 0;border-bottom:1px solid var(--st-line);font-size:var(--st-fs-body)}
.timeline li:last-child{border-bottom:0}
.guards{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:4px}
.guards li{font-size:var(--st-fs-meta);display:flex;gap:8px;align-items:flex-start}
.guards .g-ok{color:var(--st-ok)} .guards .g-review{color:var(--st-warn)} .guards .g-block{color:var(--st-bad)}

/* accounts */
.acct-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.acct{background:var(--st-surface);border:1px solid var(--st-line);border-radius:var(--st-r-surface);padding:16px 18px;display:flex;flex-direction:column;gap:12px;min-width:0}
.acct-top{display:flex;gap:14px;align-items:center}
.acct-avatar{position:relative;display:grid;place-items:center;flex:none;width:46px;height:46px;border-radius:50%;background:var(--st-sunken);color:var(--st-text-2);font-weight:600;font-size:var(--st-fs-head)}
.acct-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%}
.acct-avatar .st-dot{position:absolute;right:3px;bottom:3px;width:10px;height:10px;box-shadow:0 0 0 2px var(--st-surface);z-index:1}
.acct-avatar .st-dot-idle{background:var(--st-surface);box-shadow:0 0 0 2px var(--st-surface),inset 0 0 0 1.5px var(--st-muted)}
.acct-xhs{display:flex;flex-direction:column;gap:10px}
.acct-bio{margin:0;font-size:var(--st-fs-body);color:var(--st-text-2);line-height:1.55}
.acct-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:var(--st-fs-meta);color:var(--st-muted)}
.acct-stats span{display:grid}
.acct-stats b{order:-1;font-family:var(--st-font-num);font-variant-numeric:tabular-nums;letter-spacing:-.02em;font-size:var(--st-fs-page);color:var(--st-text);font-weight:600}
.acct-notes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.acct-note{display:flex;flex-direction:column;gap:4px;min-width:0}
.acct-note img,.acct-note-empty{width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:var(--st-r-surface);background:var(--st-sunken);display:block}
.acct-note:hover .acct-note-title{color:var(--st-text)}
.acct-note-title{font-size:var(--st-fs-meta);line-height:1.35;color:var(--st-text-2);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.acct-pos{margin:0;font-size:var(--st-fs-meta);color:var(--st-muted);line-height:1.55}
.acct-meta{font-size:var(--st-fs-meta);color:var(--st-muted);display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 12px}
.acct-foot{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto;align-items:center;padding-top:14px;border-top:1px solid var(--st-line)}
.density{display:flex;align-items:center;gap:10px}
.density .bar{width:110px}

/* conversations */
.thread{display:flex;flex-direction:column;gap:10px}
.msg{max-width:78%;padding:10px 14px;border-radius:var(--st-r-surface);font-size:var(--st-fs-body);line-height:1.6;white-space:pre-wrap;word-break:break-word}
.msg-in{background:var(--st-surface);border:1px solid var(--st-line);align-self:flex-start;border-top-left-radius:4px}
.msg-out{background:var(--st-sunken);align-self:flex-end;border-top-right-radius:4px}
.msg-meta{font-size:var(--st-fs-meta);color:var(--st-muted);margin-top:4px;white-space:normal}

/* content calendar */
.calendar{display:grid;grid-template-columns:160px repeat(7,minmax(120px,1fr));gap:8px;min-width:1100px}
.cal-head{font-size:var(--st-fs-meta);color:var(--st-muted);padding:4px 6px}
.cal-acct{font-size:var(--st-fs-body);font-weight:600;padding:8px 6px}
.cal-cell{background:var(--st-surface);border:1px solid var(--st-line);border-radius:var(--st-r-surface);padding:8px;min-height:68px;display:flex;flex-direction:column;gap:6px}
.cal-post{font-size:var(--st-fs-meta);line-height:1.4;border-radius:var(--st-r-control);padding:5px 8px;background:var(--st-surface-2);border:1px solid var(--st-line)}

/* forms */
form.stack label,.field{display:flex;flex-direction:column;gap:5px;font-size:var(--st-fs-meta);font-weight:500;color:var(--st-text-2)}
input[type=text],input[type=password],input[type=number],input[type=url],input[type=datetime-local],input[type=search],select,textarea{font-size:var(--st-fs-body);font-weight:400;color:var(--st-text);background:var(--st-surface);border:1px solid var(--st-line-strong);border-radius:var(--st-r-control);padding:0 10px;height:var(--st-ctl);width:100%;transition:border-color var(--st-t-fast) var(--st-ease),box-shadow var(--st-t-fast) var(--st-ease)}
select{padding-right:6px;cursor:pointer}
input:focus,select:focus,textarea:focus{outline:0;border-color:var(--st-text-2);box-shadow:0 0 0 3px var(--st-sunken)}
input::placeholder,textarea::placeholder{color:var(--st-muted)}
textarea{min-height:84px;height:auto;padding:8px 10px;resize:vertical;line-height:1.6}
textarea.code{font-family:var(--st-font-mono);font-size:var(--st-fs-meta);min-height:200px}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px 14px;align-items:end}
.inline-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.inline-form input,.inline-form select{width:auto;min-width:140px}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.filters input,.filters select{width:auto;min-width:0}
.filters-more{flex-basis:auto;margin:0}
.filters-more[open]{flex-basis:100%}
.filters-more summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px;height:var(--st-ctl-sm);padding:0 9px;border:1px solid var(--st-line);border-radius:var(--st-r-control);background:var(--st-surface);color:var(--st-text-2);font-size:var(--st-fs-meta)}
.filters-more summary::-webkit-details-marker{display:none}
.filters-more[open] summary{border-style:solid;border-color:var(--st-text);color:var(--st-text)}
.filters-more-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.section-head .filters-more{margin-left:auto}
.section-head .filters-more[open] .filters-more-row{position:absolute;right:0;top:calc(100% + 6px);z-index:30;width:max-content;max-width:min(560px,80vw);padding:10px;background:var(--st-surface);border:1px solid var(--st-line);border-radius:var(--st-r-surface);box-shadow:var(--st-lift),0 16px 36px -20px rgba(0,0,0,.3)}
.section-head .filters-more{position:relative}
/* 对话: a Xiaohongshu-shaped inbox — people on the left, the thread on the right, the composer under it */
.im{display:grid;grid-template-columns:316px minmax(0,1fr);height:min(760px,calc(100dvh - 250px));min-height:460px;border:1px solid var(--st-line);border-radius:var(--st-r-lg);background:var(--st-surface);overflow:hidden}
.im-list{display:flex;flex-direction:column;min-width:0;border-right:1px solid var(--st-line);background:var(--st-surface)}
.im-list-head{display:flex;align-items:center;gap:10px;padding:14px 16px 10px}
.im-list-title{font-size:var(--st-fs-item);font-weight:600}
.im-tabs{display:inline-flex;gap:2px;margin-left:auto;padding:2px;border:1px solid var(--st-line);border-radius:var(--st-r-control);background:var(--st-surface-2)}
.im-tab{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:4px;color:var(--st-text-2);font-size:var(--st-fs-meta)}
.im-tab:hover{color:var(--st-text)}
.im-tab.is-on{background:var(--st-surface);color:var(--st-text);font-weight:600;box-shadow:0 1px 1px rgba(0,0,0,.04),inset 0 0 0 1px var(--st-line)}
.view-tabs .im-tab{height:var(--st-ctl-sm);padding:0 11px;font-size:var(--st-fs-body)}
.im-people{flex:1;overflow-y:auto;padding:4px 8px 8px}
.im-person{display:flex;gap:10px;align-items:flex-start;padding:10px;border-radius:var(--st-r-surface);color:inherit}
.im-person:hover{background:var(--st-surface-2)}
.im-person.is-open{background:var(--st-sunken)}
.im-person-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.im-person-top{display:flex;align-items:baseline;gap:8px}
.im-person-name{flex:1;min-width:0;font-size:var(--st-fs-body);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.im-person-time{flex:none;font-size:var(--st-fs-micro);color:var(--st-muted)}
.im-person-preview{font-size:var(--st-fs-meta);color:var(--st-text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.im-person-foot{display:flex;align-items:center;gap:6px;font-size:var(--st-fs-micro);color:var(--st-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.im-flag{flex:none;padding:0 6px;border-radius:999px;background:var(--st-sunken);color:var(--st-text-2);font-size:var(--st-fs-micro);line-height:16px}
.im-flag-warn{background:var(--st-warn-soft);color:var(--st-warn)}
.im-flag-quiet{background:transparent;border:1px solid var(--st-line);color:var(--st-muted)}
.im-new{display:block;padding:12px 16px;border-top:1px solid var(--st-line);color:var(--st-text-2);font-size:var(--st-fs-meta)}
.im-new:hover{background:var(--st-surface-2);color:var(--st-text)}
.im-list-empty{margin:24px 16px;color:var(--st-muted);font-size:var(--st-fs-meta);line-height:1.7}
.im-main{display:flex;flex-direction:column;min-width:0;background:var(--st-surface-2)}
.im-head{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--st-line);background:var(--st-surface)}
.im-head-body{min-width:0}
.im-head-name{display:flex;align-items:center;gap:8px;font-size:var(--st-fs-body);font-weight:600}
.im-head-meta{font-size:var(--st-fs-micro);color:var(--st-muted);margin-top:2px}
.im-back{display:none;font-size:var(--st-fs-body);color:var(--st-text-2)}
.im-handoff{padding:10px 18px;background:var(--st-warn-soft);border-bottom:1px solid color-mix(in srgb,var(--st-warn) 26%,transparent);color:var(--st-warn);font-size:var(--st-fs-meta)}
.im-extract{border-bottom:1px solid var(--st-line);background:var(--st-surface)}
.im-extract summary{cursor:pointer;list-style:none;padding:9px 18px;font-size:var(--st-fs-meta);color:var(--st-text-2)}
.im-extract summary::-webkit-details-marker{display:none}
.im-extract[open] summary{color:var(--st-text)}
.im-extract-body{padding:0 18px 14px}
.im-thread{flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:12px}
.im-day{align-self:center;font-size:var(--st-fs-micro);color:var(--st-muted);margin:6px 0}
.im-msg{display:flex;gap:8px;align-items:flex-end;max-width:76%}
.im-msg.is-out{flex-direction:row-reverse;align-self:flex-end}
.im-msg-body{min-width:0}
.im-bubble{padding:9px 13px;border-radius:var(--st-r-surface);font-size:var(--st-fs-body);line-height:1.65;white-space:pre-wrap;word-break:break-word;background:var(--st-surface);border:1px solid var(--st-line);border-bottom-left-radius:5px}
.is-out .im-bubble{background:var(--st-primary-bg);color:var(--st-primary-fg);border-color:transparent;border-bottom-left-radius:14px;border-bottom-right-radius:5px}
.im-msg-meta{margin-top:4px;font-size:var(--st-fs-micro);color:var(--st-muted)}
.is-out .im-msg-meta{text-align:right}
.im-draft{padding:10px 12px;border-radius:var(--st-r-surface);background:var(--st-gold-soft);border:1px solid var(--st-gold-line)}
.im-draft-head{font-size:var(--st-fs-micro);font-weight:600;color:var(--st-gold-ink);margin-bottom:6px}
.im-draft textarea{min-height:76px;font-size:var(--st-fs-body);background:var(--st-surface)}
.im-compose{border-top:1px solid var(--st-line);background:var(--st-surface);padding:12px 18px 14px}
.im-compose-label{display:block;font-size:var(--st-fs-meta);color:var(--st-text-2);margin-bottom:6px}
.im-compose textarea{min-height:70px;border-radius:var(--st-r-surface);background:var(--st-surface-2);font-size:var(--st-fs-body)}
.im-compose-foot{display:flex;align-items:center;gap:12px;margin-top:8px}
.im-compose-foot .st-help{flex:1;min-width:0}
.im-compose.is-blocked{color:var(--st-muted);font-size:var(--st-fs-meta)}
.im-compose-new .form-grid{margin-bottom:10px}
.im-explain{align-items:center;justify-content:center;padding:28px}
.im-explain-body{max-width:640px}
.im-explain-title{margin:0 0 6px;font-size:var(--st-fs-head);font-weight:600}
.im-explain-text{margin:0 0 18px;color:var(--st-text-2);font-size:var(--st-fs-body);line-height:1.7}
.im-explain .flow{margin-bottom:16px}
@media (max-width:900px){
  .im{grid-template-columns:1fr;height:auto;min-height:0}
  .im-head{flex-wrap:wrap;row-gap:6px;padding:10px 14px}
  .im-back,.im-head .link{white-space:nowrap}
  .im-head-body{flex:1 1 auto;min-width:150px}
  .im-list{border-right:0;border-bottom:1px solid var(--st-line)}
  .im-people{max-height:340px}
  .im.has-open .im-list{display:none}
  .im.has-open .im-back{display:inline}
  .im-thread{max-height:60dvh}
  .im-msg{max-width:88%}
}
/* 「?」: the explanation stays out of the page until someone asks for it */
.hint{display:inline-block;position:relative;vertical-align:middle;margin-left:6px}
.hint>summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;border:1px solid var(--st-line-strong);color:var(--st-muted);font-size:var(--st-fs-micro);font-weight:600;line-height:1}
.hint>summary::-webkit-details-marker{display:none}
.hint>summary:hover{color:var(--st-text);border-color:var(--st-text-2)}
.hint[open]>summary{background:var(--st-sunken);color:var(--st-text)}
.hint-body{position:absolute;z-index:60;top:22px;left:-8px;width:min(340px,78vw);padding:10px 12px;border:1px solid var(--st-line);border-radius:var(--st-r-md);background:var(--st-surface);box-shadow:var(--st-lift);font-size:var(--st-fs-meta);line-height:1.7;font-weight:400;color:var(--st-text-2);text-align:left;white-space:normal}
.hint-body p{margin:0 0 6px}
.hint-body p:last-child{margin:0}
@media (max-width:720px){.hint-body{left:auto;right:-8px}}

.acct-voice, .acct-adv{margin-top:2px}
.acct-voice>summary, .acct-adv>summary{cursor:pointer;list-style:none}
.acct-voice>summary::-webkit-details-marker, .acct-adv>summary::-webkit-details-marker{display:none}
.acct-voice>summary::before, .acct-adv>summary::before{content:"▸ ";color:var(--st-muted)}
.acct-voice[open]>summary::before, .acct-adv[open]>summary::before{content:"▾ "}
.acct-voice .veh-list{margin-top:6px;font-size:var(--st-fs-meta)}

/* 车型库: the line-up as photo cards — facts on the left of a card page, AI material on the right */
.veh-stat-row{display:flex;gap:16px;flex-wrap:wrap;margin:0}
.veh-stat{font-size:var(--st-fs-meta);color:var(--st-muted)}
.veh-stat b{font-family:var(--st-font-num);font-size:var(--st-fs-body);font-weight:600;color:var(--st-text);margin-right:3px}
.veh-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(246px,1fr));gap:16px}
.veh{display:flex;flex-direction:column;border:1px solid var(--st-line);border-radius:var(--st-r-lg);background:var(--st-surface);color:inherit;overflow:hidden;transition:border-color var(--st-t-fast) var(--st-ease),box-shadow var(--st-t-fast) var(--st-ease)}
.veh:hover{border-color:var(--st-line-strong);box-shadow:var(--st-lift)}
.veh.is-archived{opacity:.62}
.veh-cover{position:relative;aspect-ratio:16/10;background:var(--st-sunken);overflow:hidden}
.veh-cover img{width:100%;height:100%;object-fit:cover;display:block}
.veh-cover.is-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:10px;text-align:center}
.veh-cover-text{font-size:var(--st-fs-head);font-weight:600;color:var(--st-text-2);letter-spacing:.02em}
.veh-cover-note{font-size:var(--st-fs-micro);color:var(--st-muted)}
.veh-body{display:flex;flex-direction:column;gap:6px;padding:11px 12px 12px;min-width:0;flex:1}
.veh-name{font-size:var(--st-fs-body);font-weight:600;line-height:1.4}
.veh-trim{display:block;font-size:var(--st-fs-meta);font-weight:400;color:var(--st-muted);margin-top:2px}
.veh-price-row{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}
.veh-price{font-family:var(--st-font-num);font-size:var(--st-fs-head);font-weight:600}
.veh-price-lg .veh-price{font-size:var(--st-fs-metric)}
.veh-price-note{font-size:var(--st-fs-micro);color:var(--st-muted)}
.veh-price-was{font-size:var(--st-fs-meta);color:var(--st-muted);text-decoration:line-through}
.veh-cut{font-size:var(--st-fs-micro);color:var(--st-bad);background:var(--st-bad-soft);border-radius:var(--st-r-control);padding:1px 6px}
.veh-spec-line{font-size:var(--st-fs-meta);color:var(--st-text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.veh-foot{display:flex;align-items:center;gap:6px;font-size:var(--st-fs-micro);color:var(--st-muted);white-space:nowrap;overflow:hidden;margin-top:auto;padding-top:2px}
.veh-foot>span+span::before,.veh-foot>.veh-stock+span::before{content:"·";margin-right:6px;color:var(--st-line-strong)}
.veh-stock.is-on{color:var(--st-ok)}
.veh-stock.is-off{color:var(--st-muted)}
.veh-flag{border:1px solid var(--st-line);border-radius:var(--st-r-control);padding:1px 6px;font-size:var(--st-fs-micro)}
.veh-flag.is-ai{border-color:var(--st-gold-line);color:var(--st-gold-ink);background:var(--st-gold-soft)}
.veh-flag.is-todo{color:var(--st-warn)}
.veh-flag.is-off{color:var(--st-muted)}
.veh-detail{display:flex;flex-direction:column;gap:16px}
.veh-hero{display:grid;grid-template-columns:minmax(0,340px) minmax(0,1fr);gap:18px;align-items:start}
.veh-hero-cover{position:relative;aspect-ratio:16/10;border-radius:var(--st-r-lg);background:var(--st-sunken);overflow:hidden;border:1px solid var(--st-line)}
.veh-hero-cover img{width:100%;height:100%;object-fit:cover;display:block}
.veh-hero-cover.is-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;text-align:center}
.veh-hero-body{display:flex;flex-direction:column;gap:10px;min-width:0}
.veh-hero-name{margin:0;font-size:var(--st-fs-page);font-weight:600;line-height:1.35}
.veh-gallery{display:flex;gap:10px;overflow-x:auto;padding-bottom:4px}
.veh-gallery img{width:180px;height:112px;object-fit:cover;border-radius:var(--st-r-md);border:1px solid var(--st-line);flex:none}
.veh-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start}
.veh-block{display:flex;flex-direction:column;gap:7px}
.veh-block h3{margin:0;font-size:var(--st-fs-meta);font-weight:600;color:var(--st-muted);letter-spacing:.04em}
.veh-specs{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px}
.veh-specs>div{display:flex;flex-direction:column;gap:2px;padding:9px 11px;border-radius:var(--st-r-md);background:var(--st-sunken)}
.veh-spec-label{font-size:var(--st-fs-micro);color:var(--st-muted)}
.veh-spec-value{font-family:var(--st-font-num);font-size:var(--st-fs-head);font-weight:600}
.veh-spec-value i{font-style:normal;font-size:var(--st-fs-micro);font-weight:400;color:var(--st-muted);margin-left:2px}
.veh-colors{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.veh-colors li{display:flex;align-items:center;gap:8px;font-size:var(--st-fs-body)}
.veh-color-name{min-width:96px}
.veh-offers{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px;font-size:var(--st-fs-body);line-height:1.6}
.veh-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px;font-size:var(--st-fs-body);line-height:1.6}
.veh-desc{margin:0;font-size:var(--st-fs-body);line-height:1.75;white-space:pre-wrap}
.veh-faq{margin:0;font-size:var(--st-fs-body)}
.veh-faq dt{font-weight:600;margin-top:9px}
.veh-faq dt:first-child{margin-top:0}
.veh-faq dd{margin:3px 0 0;color:var(--st-text-2);line-height:1.7}
@media (max-width:980px){.veh-hero{grid-template-columns:1fr}.veh-cols{grid-template-columns:1fr}}

/* 消息中心: the three notification tabs, one wide list of what other people did to us */
.ntf-pane{display:flex;flex-direction:column;gap:10px}
.ntf-head{display:flex;align-items:center;gap:10px;padding-bottom:6px}
.ntf-head-title{font-size:var(--st-fs-body);font-weight:600}
.ntf-list{display:flex;flex-direction:column;gap:8px}
.ntf{display:flex;gap:12px;padding:13px 14px;border:1px solid var(--st-line);border-radius:var(--st-r-lg);background:var(--st-surface)}
.ntf.is-new{border-color:var(--st-line-strong)}
.ntf.is-new::before{content:"";width:6px;height:6px;margin-top:17px;border-radius:50%;background:var(--st-warn);flex:none}
.ntf-body{display:flex;flex-direction:column;gap:7px;min-width:0;flex:1}
.ntf-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ntf-name{font-size:var(--st-fs-body);font-weight:600}
.ntf-said{font-size:var(--st-fs-meta);color:var(--st-muted)}
.ntf-time{font-family:var(--st-font-num);font-size:var(--st-fs-micro);color:var(--st-muted);white-space:nowrap}
.ntf-text{margin:0;padding:9px 12px;border-left:2px solid var(--st-line-strong);border-radius:0 8px 8px 0;background:var(--st-sunken);font-size:var(--st-fs-body);line-height:1.6;white-space:pre-wrap;word-break:break-word}
.ntf-foot{font-size:var(--st-fs-micro);color:var(--st-muted)}
.ntf-note{color:var(--st-text-2)}
.ntf-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}
.ntf-reply{display:inline-block}
.ntf-reply>summary{display:inline-flex;align-items:center;list-style:none;cursor:pointer}
.ntf-reply>summary::-webkit-details-marker{display:none}
.ntf-reply[open]>summary{border-color:var(--st-line-strong)}
.ntf-reply-body{display:flex;flex-direction:column;gap:8px;margin-top:8px;width:min(520px,100%)}
.ntf-reply-body textarea{min-height:64px}
@media (max-width:720px){.ntf{padding:11px}.ntf-actions{gap:6px}}

/* 内容: one line of flow, tab views, and notes that look like the notes they will become */
.view-tabs{display:inline-flex;align-self:flex-start;width:fit-content;max-width:100%;gap:2px;flex-wrap:wrap;margin:0;padding:2px;border:1px solid var(--st-line);border-radius:var(--st-r-control);background:var(--st-surface-2)}
.view-tabs>a{display:inline-flex;align-items:center;gap:6px;height:var(--st-ctl-sm);padding:0 11px;border-radius:4px;color:var(--st-text-2);font-size:var(--st-fs-body);white-space:nowrap;transition:background-color var(--st-t-fast) var(--st-ease),color var(--st-t-fast) var(--st-ease)}
.view-tabs>a:hover{color:var(--st-text)}
.view-tabs>a.is-on{background:var(--st-surface);color:var(--st-text);font-weight:600;box-shadow:0 1px 1px rgba(0,0,0,.04),inset 0 0 0 1px var(--st-line)}
.tab-n{margin-left:6px;font-family:var(--st-font-num);font-size:var(--st-fs-micro);color:var(--st-muted)}
.im-tab.is-on .tab-n{color:var(--st-text)}
.note-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}
.note{display:flex;flex-direction:column;gap:8px;padding:8px;border:1px solid var(--st-line);border-radius:var(--st-r-lg);background:var(--st-surface);color:inherit}
.note:hover{border-color:var(--st-line-strong);box-shadow:var(--st-lift)}
.note-cover{position:relative;display:flex;align-items:flex-end;aspect-ratio:4/5;padding:11px;border-radius:var(--st-r-surface);background:var(--st-sunken);overflow:hidden}
.note-cover-text{font-size:var(--st-fs-item);font-weight:600;line-height:1.45;color:var(--st-text-2);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.note-cover.is-blank{align-items:center;justify-content:center}
.note-cover-note{font-size:var(--st-fs-micro);color:var(--st-muted)}
.note-body{display:flex;flex-direction:column;gap:5px;min-width:0}
.note-title{font-size:var(--st-fs-body);font-weight:600;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.note-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.note-meta-text{font-size:var(--st-fs-micro);color:var(--st-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.note-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}
.note-checks{display:flex;gap:8px;flex-wrap:wrap;font-size:var(--st-fs-micro);color:var(--st-ok)}
.note-check.is-bad{color:var(--st-bad)}
.note-stats{display:flex;gap:14px;flex-wrap:wrap;margin-top:2px}
.note-stat{display:flex;flex-direction:column;line-height:1.25;font-size:var(--st-fs-micro);color:var(--st-muted)}
.note-stat b{font-family:var(--st-font-num);font-size:var(--st-fs-item);font-weight:600;color:var(--st-text)}
.board{display:grid;grid-template-columns:132px repeat(7,minmax(126px,1fr));gap:7px;min-width:1010px}
.board-head{font-size:var(--st-fs-meta);color:var(--st-muted);padding:2px 6px}
.board-head.is-today{color:var(--st-text);font-weight:600}
.board-date{margin-left:6px;font-family:var(--st-font-num);font-size:var(--st-fs-micro)}
.board-acct{display:flex;flex-direction:column;gap:2px;padding:10px 6px}
.board-acct-name{font-size:var(--st-fs-body);font-weight:600}
.board-cell{display:flex;flex-direction:column;gap:8px;min-height:96px;padding:8px;border:1px solid var(--st-line);border-radius:var(--st-r-surface);background:var(--st-surface-2)}
.board-cell.is-today{border-color:var(--st-line-strong);background:var(--st-surface)}
.board-cell .note{padding:6px;background:var(--st-surface)}
.board-cell .note-cover{aspect-ratio:5/4;padding:7px}
.board-cell .note-cover-text{font-size:var(--st-fs-meta);-webkit-line-clamp:3}
.board-empty{color:var(--st-line-strong);font-size:var(--st-fs-body);padding:4px 2px}
.reply-list{display:flex;flex-direction:column;gap:12px}
.reply-card{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:1px solid var(--st-line);border-radius:var(--st-r-lg);background:var(--st-surface)}
.reply-quote{font-size:var(--st-fs-body);line-height:1.6}
.reply-text{font-size:var(--st-fs-body);color:var(--st-text-2);line-height:1.6}
.reply-card textarea{min-height:64px}
@media (max-width:700px){.note-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}}
/* 对话 / 内容: the flow strip. 内容 adds live counts and makes each step a filter link */
.cal-head.is-today{color:var(--st-text);font-weight:600}
.cal-date{margin-left:6px;font-family:var(--st-font-num);font-size:var(--st-fs-micro);color:var(--st-muted)}
/* 对话: the four-step flow strip shown when no thread is open */
@media (max-width:1180px){.flow.flow-5{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:760px){.flow.flow-5{grid-template-columns:repeat(2,minmax(0,1fr))}}
.empty-title{margin:0 0 6px;font-size:var(--st-fs-body);font-weight:600;color:var(--st-text)}
.empty p{margin:0 0 10px;max-width:62ch;line-height:1.7}
.empty .btn{margin-top:2px}
@media (max-width:900px){.flow{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.flow{grid-template-columns:1fr}}
/* In the section head it is a control, so it opens as a popover instead of pushing the list down. */
.legend{position:relative;margin:0}
.section-head .legend{margin-left:auto}
.legend[open] .legend-body{position:absolute;right:0;top:calc(100% + 8px);z-index:40;width:min(680px,80vw);box-shadow:var(--st-lift),0 18px 40px -20px rgba(0,0,0,.35)}
.legend summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px;font-size:var(--st-fs-meta);color:var(--st-text-2)}
.legend summary::-webkit-details-marker{display:none}
.legend summary::before{content:"?";display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;border:1px solid var(--st-line-strong);font-size:var(--st-fs-micro)}
.legend[open] summary{color:var(--st-text)}
.legend-body{margin-top:10px;padding:14px 16px;background:var(--st-surface);border:1px solid var(--st-line);border-radius:var(--st-r-lg)}
.legend-head{margin:0 0 6px;font-size:var(--st-fs-meta);font-weight:600;color:var(--st-text-2)}
.legend-head:not(:first-child){margin-top:14px}
.legend-grid{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 14px;font-size:var(--st-fs-meta);color:var(--st-text-2)}
.legend-term{display:flex;align-items:baseline;gap:6px;color:var(--st-text);font-weight:600;white-space:nowrap}
.legend-n{font-family:var(--st-font-num);font-variant-numeric:tabular-nums;font-weight:400;color:var(--st-muted);font-size:var(--st-fs-micro)}
.legend-note{margin:14px 0 0;font-size:var(--st-fs-meta);color:var(--st-muted);line-height:1.6}
@media (max-width:640px){.legend-grid{grid-template-columns:minmax(0,1fr);gap:2px}.legend-term{margin-top:8px}}
.filters select,.filters input{width:auto;min-width:112px;height:var(--st-ctl);padding:0 10px;border-radius:var(--st-r-control);border-color:var(--st-line);background:var(--st-surface);font-size:var(--st-fs-body)}
.filters input[type=text],.filters input[type=search]{width:190px}
.pager{display:flex;gap:6px;justify-content:flex-end;margin-top:14px}

/* setup */
.setup{max-width:1080px}
.setup-next{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:var(--st-surface);border:1px solid var(--st-line);border-radius:var(--st-r-lg);padding:14px 18px}
.setup-progress{display:flex;gap:18px;flex-wrap:wrap;list-style:none;margin:0;padding:0;font-size:var(--st-fs-body);color:var(--st-muted)}
.setup-progress .done{color:var(--st-text-2)}
.setup-progress .done::before{content:"✓";color:var(--st-ok);margin-right:6px}
.setup-progress .todo{color:var(--st-text);font-weight:600}
.setting{display:grid;grid-template-columns:200px minmax(0,1fr);gap:32px;padding-block:28px;border-top:1px solid var(--st-line)}
.setup-next+.setting{border-top:0;margin-top:8px}
.setup>.setting:first-child{border-top:0;padding-top:8px}
.setting-head h2{font-size:var(--st-fs-item)}
.setting-head p{margin:6px 0 0;font-size:var(--st-fs-meta);line-height:1.6;color:var(--st-muted)}
.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px}
.fields .wide{grid-column:1/-1}
.fields label>span:first-child{color:var(--st-text-2)}
.opt{margin-left:6px;font-size:var(--st-fs-meta);font-weight:400;color:var(--st-muted)}
.form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
details.adder{margin-top:14px}
details.adder>summary{list-style:none}
details.adder>summary::-webkit-details-marker{display:none}
details.adder[open]>summary{margin-bottom:14px}

/* overlays */
.modal{position:fixed;inset:0;background:rgba(19,19,18,.45);display:grid;place-items:center;z-index:50;padding:16px}
.modal-card{background:var(--st-surface);border:1px solid var(--st-line);border-radius:var(--st-r-xl);padding:24px;max-width:420px;width:100%;text-align:center;box-shadow:var(--st-lift)}
.modal-card h3{font-size:var(--st-fs-item)}
.qr-img{width:240px;height:240px;image-rendering:pixelated;margin:12px auto;display:block;border-radius:var(--st-r-surface);border:1px solid var(--st-line);background:#fff}
.toast{position:fixed;left:50%;bottom:28px;z-index:60;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:var(--st-r-surface);background:var(--st-primary-bg);color:var(--st-primary-fg);font-size:var(--st-fs-body);box-shadow:var(--st-lift);transform:translate(-50%,12px);opacity:0;pointer-events:none;transition:transform var(--st-t-base) var(--st-ease),opacity var(--st-t-base) var(--st-ease);max-width:calc(100% - 32px)}
.toast.show{transform:translate(-50%,0);opacity:1}
.toast.err{background:var(--st-bad);color:#fff} .toast.ok{background:var(--st-ok);color:#fff}

/* bare pages (login, errors) */
body.bare{background:var(--st-canvas)}
.bare-main{padding:0 16px}
.login-card{max-width:400px;margin:14vh auto 0;background:var(--st-surface);border:1px solid var(--st-line);border-radius:var(--st-r-xl);padding:32px}
.login-brand{display:flex;align-items:center;gap:12px;font-size:var(--st-fs-head);font-weight:600}
.login-brand svg{width:22px;height:32px}

/* ───────── 今日 (kit: agent hero, command bar, needs-you bento, pipeline, fleet) ───────── */
.today{display:grid;grid-template-columns:minmax(0,1fr) var(--st-rail-w);gap:28px;align-items:start}
.today-main{display:flex;flex-direction:column;gap:28px;min-width:0}
.st-card{background:var(--st-surface);border:1px solid var(--st-line);border-radius:var(--st-r-lg);transition:border-color var(--st-t-fast) var(--st-ease),transform var(--st-t-base) var(--st-ease),box-shadow var(--st-t-base) var(--st-ease)}
.st-card.is-interactive:hover{border-color:var(--st-line-strong);transform:translateY(-1px);box-shadow:var(--st-lift)}
/* Space between sections is larger than space inside one: that ratio is what makes a page readable without boxes. */
.st-section{display:flex;flex-direction:column;gap:12px}
.today-main>.st-section+.st-section{margin-top:40px}
.st-section>*{min-width:0}
/* 待办清单: one row, one job. The count is a number, not a badge; the action is a link, not an icon button. */
.todo-list{display:flex;flex-direction:column;border-top:1px solid var(--st-line-strong)}
.todo{display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:center;gap:14px;padding:12px 2px;border-bottom:1px solid var(--st-line);color:inherit;transition:background-color var(--st-t-fast) var(--st-ease)}
.todo:hover{background:color-mix(in srgb,var(--st-sunken) 55%,transparent)}
.todo-n{font-size:var(--st-fs-head);font-weight:600;line-height:1;text-align:right;color:var(--st-text-2);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.todo.is-urgent .todo-n{color:var(--st-gold-ink)}
.todo-title{font-size:var(--st-fs-body);font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.todo-go{display:inline-flex;align-items:center;gap:3px;font-size:var(--st-fs-meta);color:var(--st-muted);transition:color var(--st-t-fast) var(--st-ease)}
.todo-go svg{width:13px;height:13px;transition:transform var(--st-t-fast) var(--st-ease)}
.todo:hover .todo-go,.todo:focus-visible .todo-go{color:var(--st-text)}
.todo:hover .todo-go svg{transform:translateX(2px)}

.st-lede{max-width:74ch;color:var(--st-text-2)}
.st-lede .st-num{color:var(--st-text);font-weight:600}
.funnel-step.is-final .num{color:var(--st-gold-ink)}
.st-command{padding:16px 18px;background:var(--st-surface);border:1px solid var(--st-line);border-radius:var(--st-r-surface)}
.st-command form{display:grid;gap:10px}
.st-label{font-size:var(--st-fs-meta);font-weight:500;color:var(--st-text-2)}
.st-command-box{display:flex;align-items:center;gap:10px;padding:0 4px 0 12px;border-radius:var(--st-r-control);border:1px solid var(--st-line-strong);background:var(--st-surface);transition:border-color var(--st-t-fast) var(--st-ease),box-shadow var(--st-t-fast) var(--st-ease)}
.st-command-box:focus-within{border-color:var(--st-text-2);box-shadow:0 0 0 3px var(--st-sunken)}
.st-command-box svg.st-mark{width:13px;height:18px;flex:none;color:var(--st-muted)}
input.st-command-input{flex:1;min-width:0;border:0;background:none;font-size:var(--st-fs-body);height:38px;padding:0;box-shadow:none}
input.st-command-input:focus{outline:0;box-shadow:none}
.st-suggest{display:flex;flex-wrap:wrap;gap:6px}
.st-chip{display:inline-flex;align-items:center;height:var(--st-ctl-sm);padding:0 9px;border-radius:var(--st-r-control);border:1px solid var(--st-line);background:var(--st-surface-2);color:var(--st-text-2);font-size:var(--st-fs-meta);white-space:nowrap;cursor:pointer;transition:border-color var(--st-t-fast) var(--st-ease),color var(--st-t-fast) var(--st-ease)}
.st-chip:hover{border-color:var(--st-line-strong);color:var(--st-text)}
/* 现在的情况: the people get the column, the one-number facts get a ruled stack. No boxes. */
.now{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(260px,1fr);gap:0 32px;align-items:start}
.now-main{min-width:0}
.now-head{display:flex;align-items:baseline;gap:10px;padding-bottom:7px;border-bottom:1px solid var(--st-line-strong)}
.now-title{font-size:var(--st-fs-body);font-weight:600;margin:0}
.now-n{font-size:var(--st-fs-item);font-weight:600;letter-spacing:-.02em}
.now-note{font-size:var(--st-fs-meta);color:var(--st-muted)}
.now-note b{color:var(--st-text-2);font-weight:600}
.now-head .st-link{margin-left:auto}
.now-leads{display:flex;flex-direction:column}
.now-side{display:flex;flex-direction:column;border-top:1px solid var(--st-line-strong)}
.fact{display:flex;flex-direction:column;gap:5px;padding:12px 2px;border-bottom:1px solid var(--st-line);color:inherit;transition:background-color var(--st-t-fast) var(--st-ease)}
a.fact:hover{background:color-mix(in srgb,var(--st-sunken) 55%,transparent)}
.fact-head{display:flex;align-items:baseline;gap:10px}
.fact-label{font-size:var(--st-fs-meta);color:var(--st-muted)}
.fact-n{margin-left:auto;font-size:var(--st-fs-item);font-weight:600;line-height:1;letter-spacing:-.02em}
.fact-n-sep{margin:0 4px;color:var(--st-muted);font-weight:400}
.fact-body{display:block;font-size:var(--st-fs-meta);color:var(--st-text-2);line-height:1.55;overflow:hidden;text-overflow:ellipsis}
.fact-quiet{color:var(--st-muted)}
.fact-meta{display:block;margin-top:2px;font-size:var(--st-fs-micro);color:var(--st-muted)}
.st-mini-lead{display:grid;grid-template-columns:46px minmax(0,1fr);gap:14px;padding:11px 2px;border-bottom:1px solid var(--st-line);color:inherit;transition:background-color var(--st-t-fast) var(--st-ease)}
.st-mini-lead:hover{background:color-mix(in srgb,var(--st-sunken) 55%,transparent)}
.st-mini-score{font-size:var(--st-fs-item);font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.st-mini-score small{display:block;font-family:var(--st-font);font-size:var(--st-fs-micro);font-weight:400;letter-spacing:0;color:var(--st-muted)}
.st-mini-body{display:block;min-width:0}
.st-mini-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:3px 8px;font-size:var(--st-fs-meta);color:var(--st-muted)}
.st-mini-line strong{font-size:var(--st-fs-body);color:var(--st-text);font-weight:600}
.st-mini-quote{display:block;margin-top:3px;font-size:var(--st-fs-meta);color:var(--st-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st-empty-inline{padding:14px 2px;font-size:var(--st-fs-meta);color:var(--st-muted)}
.st-segs{display:flex;gap:3px}
.st-seg{flex:1;height:4px;border-radius:2px}
.st-seg-done{background:var(--st-text)} .st-seg-review{background:var(--st-gold)} .st-seg-draft{box-shadow:inset 0 0 0 1.5px var(--st-line-strong)}
@media (max-width:1100px){.now{grid-template-columns:minmax(0,1fr);gap:24px}}

.st-pipeline{display:grid;grid-template-columns:repeat(7,minmax(92px,1fr));overflow-x:auto;border-top:1px solid var(--st-line-strong);border-bottom:1px solid var(--st-line)}
.st-pipe{padding:12px 16px 13px 0;display:grid;gap:1px}
.st-pipe+.st-pipe{padding-left:16px;border-left:1px solid var(--st-line)}
.st-pipe-label{font-size:var(--st-fs-meta);color:var(--st-muted)}
.st-pipe-num{font-size:var(--st-fs-metric);font-weight:600;line-height:1.15;letter-spacing:-.025em}
.st-pipe-delta{font-size:var(--st-fs-micro);color:var(--st-muted)}
.st-pipe.is-won .st-pipe-num{color:var(--st-gold-ink)}
.st-fleet{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.st-fleet-item{padding:13px 15px;display:grid;gap:7px;align-content:start}
.st-fleet-top{display:flex;align-items:center;gap:12px}
.st-avatar{position:relative;display:grid;place-items:center;flex:none;width:34px;height:34px;border-radius:50%;background:var(--st-sunken);color:var(--st-text-2);font-weight:600;font-size:var(--st-fs-body)}
.st-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%}
.st-avatar .st-dot{position:absolute;right:1px;bottom:1px;box-shadow:0 0 0 2px var(--st-surface);z-index:1}
.st-avatar .st-dot-idle{background:var(--st-surface);box-shadow:0 0 0 2px var(--st-surface),inset 0 0 0 1.5px var(--st-muted)}
.st-fleet-name{font-size:var(--st-fs-body);font-weight:600;line-height:1.3}
.st-fleet-role{font-size:var(--st-fs-meta);color:var(--st-muted)}
.st-fleet-state{display:flex;align-items:center;gap:6px;font-size:var(--st-fs-meta);color:var(--st-text-2)}
.st-fleet-task{font-size:var(--st-fs-meta);color:var(--st-muted);line-height:1.5}
.st-fleet-task b{color:var(--st-text);font-weight:500}
.st-empty-inline{padding:14px 0;border-top:1px solid var(--st-line);color:var(--st-muted);font-size:var(--st-fs-body)}

/* workflow run progress (系统 → 任务进度) */
.run-summary{padding:24px 24px 20px;display:flex;flex-direction:column;gap:14px;border-radius:var(--st-r-xl)}
.run-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}
.run-head-text{flex:1;min-width:0;display:grid;gap:6px}
.run-meta{font-size:var(--st-fs-body);color:var(--st-muted)}
.run-headline{font-size:var(--st-fs-page);line-height:1.3;letter-spacing:-.01em}
.run-summary.is-bad .run-headline{color:var(--st-bad)}
.run-summary.is-ok .run-headline{color:var(--st-ok)}
.run-goal{font-size:var(--st-fs-body);color:var(--st-text-2)}
.run-actions{display:flex;gap:8px;flex-wrap:wrap}
.run-progress{display:flex;gap:4px}
.run-seg{flex:1;height:8px;border-radius:4px;background:var(--st-sunken)}
.run-seg.is-done{background:var(--st-text)}
.run-seg.is-skipped{background:repeating-linear-gradient(135deg,var(--st-line-strong) 0 3px,var(--st-sunken) 3px 6px)}
.run-seg.is-running{background:linear-gradient(90deg,var(--st-gold) 0%,var(--st-gold-line) 50%,var(--st-gold) 100%);background-size:200% 100%;animation:st-shimmer 1.6s linear infinite}
.run-seg.is-failed{background:var(--st-bad)}
.run-seg.is-waiting{background:none;box-shadow:inset 0 0 0 1.5px var(--st-line-strong)}
.run-progress-text{display:flex;align-items:baseline;gap:10px;font-size:var(--st-fs-body);color:var(--st-muted)}
.run-progress-text b{font-size:var(--st-fs-head);color:var(--st-text);font-weight:600}
.run-live{margin-left:auto;font-size:var(--st-fs-meta)}
.run-summary .banner{margin:0}
.run-section{margin-top:28px}
.run-steps{list-style:none;margin:0;padding:6px 20px;background:var(--st-surface);border:1px solid var(--st-line);border-radius:var(--st-r-lg);position:relative}
.run-step{position:relative;display:grid;grid-template-columns:22px minmax(0,1fr);gap:14px;padding:14px 0}
.run-step+.run-step{border-top:1px solid var(--st-line)}
.run-step-mark{margin-top:1px;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:var(--st-fs-meta);font-weight:700;box-shadow:inset 0 0 0 1.5px var(--st-line-strong);color:var(--st-muted)}
.run-step.is-done .run-step-mark{background:var(--st-text);box-shadow:none;color:var(--st-primary-fg)}
.run-step.is-done .run-step-mark::after{content:"✓"}
.run-step.is-failed .run-step-mark{background:var(--st-bad);box-shadow:none;color:#fff}
.run-step.is-failed .run-step-mark::after{content:"!"}
.run-step.is-skipped .run-step-mark::after{content:"−"}
.run-step.is-running .run-step-mark{box-shadow:inset 0 0 0 1.5px var(--st-gold)}
.run-step.is-running .run-step-mark::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--st-gold);animation:st-pulse 1.4s var(--st-ease) infinite}
.run-step-body{display:grid;gap:4px;min-width:0}
.run-step-top{display:flex;align-items:baseline;gap:10px}
.run-step-title{font-size:var(--st-fs-body);font-weight:600}
.run-step.is-waiting .run-step-title{color:var(--st-muted);font-weight:500}
.run-step-state{margin-left:auto;font-size:var(--st-fs-meta);color:var(--st-muted);white-space:nowrap}
.run-step.is-failed .run-step-state{color:var(--st-bad)}
.run-step.is-running .run-step-state{color:var(--st-gold-ink)}
.run-step-summary{font-size:var(--st-fs-body);color:var(--st-text-2)}
.run-step-problem{font-size:var(--st-fs-body);color:var(--st-bad)}
.run-step.is-skipped .run-step-problem{color:var(--st-muted)}
.run-step-purpose{font-size:var(--st-fs-meta);color:var(--st-muted)}
.tech-details{margin-top:28px;border:1px dashed var(--st-line-strong);border-radius:var(--st-r-lg);padding:12px 18px;background:var(--st-surface-2)}
.tech-details>summary{cursor:pointer;font-size:var(--st-fs-body);color:var(--st-text-2);font-weight:500}
.tech-details[open]>summary{margin-bottom:12px}
.tech-details .table-wrap{margin-top:12px}
@keyframes st-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}
@keyframes st-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}

/* motion */
@keyframes st-breathe{0%{transform:scale(.6);opacity:.45}70%,100%{transform:scale(1.6);opacity:0}}
@keyframes st-enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
/* A work tool does not animate its own content on every page load; only the things that open do. */
details.hint[open] .hint-body,details.breakdown[open]>*:not(summary){animation:st-enter var(--st-t-fast) var(--st-ease)}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none!important;transition-duration:1ms!important}
}

/* responsive */
@media (max-width:1280px){
  .today,.main-grid{grid-template-columns:minmax(0,1fr)}
  .rail{position:static}
}
@media (max-width:1100px){
  .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .detail-grid,.lead-grid{grid-template-columns:minmax(0,1fr)}
  .lead-head{display:none}
  .lead-row{grid-template-columns:40px minmax(0,1fr);row-gap:4px}
  .lead-col-status{grid-column:2;align-items:flex-start;text-align:left}
  .stat-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .acct-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (max-width:900px){
  body.app,body.app.is-rail{grid-template-columns:minmax(0,1fr)}
  .sidebar{position:static;height:auto;flex-direction:row;align-items:center;gap:10px;padding:8px 16px;border-right:0;border-bottom:1px solid var(--st-line);overflow-x:auto;scrollbar-width:none}
  .sidebar::-webkit-scrollbar{display:none}
  .sidebar-head{height:auto;padding:0;flex:none}
  .brand-name,.rail-btn,.nav-group-label{display:none}
  .brand{margin:0}
  .nav{flex-direction:row;align-items:center;gap:8px;padding:0;width:auto;overflow:visible}
  .nav-group{flex-direction:row;gap:2px}
  .nav-group+.nav-group{margin-left:2px;padding-left:10px;border-left:1px solid var(--st-line)}
  .nav-item,body.is-rail .nav-item{width:auto;height:28px;flex-direction:row;gap:6px;padding:0 9px;white-space:nowrap}
  .nav-label{display:inline}
  .nav-badge,body.is-rail .nav-badge{position:static;margin-left:2px}
  .sidebar-foot,body.is-rail .sidebar-foot{flex-direction:row;margin:0 0 0 auto;padding:0;border:0}
  .operator{margin:0}
  .topbar{position:static;padding:0 16px;height:auto;min-height:56px;flex-wrap:wrap;gap:8px 12px;padding-block:8px}
  .search,.mode-pill{display:none}
  .content{padding:20px 16px 40px}
  .st-bento{grid-template-columns:minmax(0,1fr)}
  .st-tile-leads{grid-row:auto}
  .setting{grid-template-columns:minmax(0,1fr);gap:14px;padding-block:22px}
  .fields{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:640px){
  .funnel{grid-template-columns:repeat(2,minmax(0,1fr))}
  .funnel-step:nth-child(odd){border-left:0}
  .funnel-step:nth-child(n+3){border-top:1px solid var(--st-line)}
  .st-command-btn-label{display:none}
  .kpi{padding:14px 16px}
  .kpi-num{font-size:var(--st-fs-metric)}
  .acct-grid{grid-template-columns:minmax(0,1fr)}
  .stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .agent-ago{display:none}
  .kv{grid-template-columns:minmax(0,1fr)}
  .data thead{display:none}
  .data tr{display:block;padding:10px 0;border-bottom:1px solid var(--st-line)}
  .data td{display:block;border:0;padding:3px 0}
  .msg{max-width:92%}
}
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
  async function call(url, method, body, signal) {
    const res = await fetch(url, { method, headers: HEADERS, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body), signal });
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
    // data-success-detail: prefer what the server actually did (e.g. how many leads went back to the pool).
    const detail = el.dataset.successDetail && data && typeof data.detail === 'string' ? data.detail : '';
    if (detail) toast(detail, 'ok');
    else if (el.dataset.success) toast(el.dataset.success, 'ok');
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
      try { await navigator.clipboard.writeText(text); toast('已复制，请用负责账号粘贴发送', 'ok'); }
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
        // A slow action (starting an instance) says so instead of looking stuck.
        if (el.dataset.pending) { el.dataset.label = el.dataset.label || el.textContent; el.textContent = el.dataset.pending; }
        const data = await call(el.dataset.url, el.dataset.method || 'POST', body);
        after(el, data);
      } catch (err) { toast(err.message, 'err'); }
      finally { el.disabled = false; if (el.dataset.label) el.textContent = el.dataset.label; }
      return;
    }
    if (action === 'theme') {
      e.preventDefault();
      const root = document.documentElement;
      const current = root.getAttribute('data-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = current === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      document.cookie = 'st_theme=' + next + '; path=/; max-age=31536000; samesite=lax';
      return;
    }
    if (action === 'rail') {
      e.preventDefault();
      // Collapsed state is a cookie, not localStorage: the server renders the right width on the next page.
      const collapsed = document.body.classList.toggle('is-rail');
      document.cookie = 'st_rail=' + (collapsed ? '1' : '0') + '; path=/; max-age=31536000; samesite=lax';
      return;
    }
    if (action === 'suggest') {
      e.preventDefault();
      const input = document.querySelector(el.dataset.target);
      if (input) { input.value = el.textContent.trim(); input.focus(); }
      return;
    }
    if (action === 'qr-login') { e.preventDefault(); qrLogin(el); return; }
    if (action === 'window-login') { e.preventDefault(); windowLogin(el); return; }
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
  let pollAbort = null;
  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (pollAbort) { pollAbort.abort(); pollAbort = null; }
  }
  function closeModal() { const m = document.getElementById('modal'); if (m) m.remove(); stopPolling(); }
  // One request at a time: the next check is scheduled only after the previous one answered (a login check drives a
  // browser on the instance and can take a minute; overlapping checks would pile up). step(signal) → true = poll again.
  function poll(step, intervalMs) {
    stopPolling();
    const abort = new AbortController();
    pollAbort = abort;
    const tick = async () => {
      pollTimer = null;
      if (abort.signal.aborted) return;
      let again = true;
      try { again = await step(abort.signal); } catch (err) { again = !abort.signal.aborted; }
      if (again && !abort.signal.aborted) pollTimer = setTimeout(tick, intervalMs);
    };
    pollTimer = setTimeout(tick, intervalMs);
  }
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
  // Relative times rendered by the server ("3分钟前") stay current without a reload.
  function agoText(iso) {
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (!Number.isFinite(mins)) return '';
    if (mins < 2) return '刚刚';
    if (mins < 60) return mins + '分钟前';
    if (mins < 1440) return Math.round(mins / 60) + '小时前';
    return Math.round(mins / 1440) + '天前';
  }
  function tickSince() {
    document.querySelectorAll('[data-since]').forEach((node) => {
      const t = agoText(node.dataset.since);
      if (t) node.textContent = '· ' + t + (node.dataset.suffix || '');
    });
  }
  setInterval(tickSince, 30000);
  // Live progress: pages that show running work reload themselves until the work is done.
  const auto = document.querySelector('[data-autorefresh]');
  if (auto) setTimeout(() => { if (!document.getElementById('modal')) location.reload(); }, Number(auto.dataset.autorefresh) || 5000);
  function closeBtn(label) { return el('button', { class: 'btn btn-ghost', 'data-action': 'close-modal', type: 'button' }, label || '关闭'); }
  async function qrLogin(btn) {
    const card = modal();
    card.appendChild(el('h3', {}, '扫码登录小红书'));
    card.appendChild(el('p', { class: 'muted' }, '正在获取登录二维码…'));
    try {
      const data = await call(btn.dataset.url, 'POST', {});
      card.textContent = '';
      if (data.already_logged_in) {
        card.appendChild(el('h3', {}, '已登录'));
        card.appendChild(el('p', {}, '这个账号已经是登录状态，不用再扫码'));
        card.appendChild(closeBtn());
        if (btn.dataset.syncUrl) call(btn.dataset.syncUrl, 'POST', {}).then(() => setTimeout(() => location.reload(), 600)).catch(() => {});
        return;
      }
      card.appendChild(el('h3', {}, '用小红书 App 扫码登录'));
      const who = (btn.dataset.account || '') + (data.expires_at ? ' · 请在 ' + new Date(data.expires_at).toLocaleTimeString('zh-CN') + ' 前扫码' : '');
      card.appendChild(el('p', { class: 'muted' }, who));
      if (typeof data.image_data_url === 'string' && data.image_data_url.indexOf('data:image/') === 0) card.appendChild(el('img', { class: 'qr-img', alt: '登录二维码', src: data.image_data_url }));
      card.appendChild(el('p', { class: 'small muted' }, '请使用该账号本人的小红书 App 扫码。二维码只显示在此窗口，不会被保存。'));
      card.appendChild(el('p', { class: 'small muted' }, '如果手机提示登录失败：请关掉这个窗口，改用「扫码登录（登录窗口）」，在弹出的窗口里扫码。'));
      const status = el('p', { class: 'small', id: 'qr-status' }, '等待扫码…');
      card.appendChild(status);
      card.appendChild(closeBtn());
      const deadline = data.expires_at ? Date.parse(data.expires_at) : Date.now() + 240000;
      if (!btn.dataset.syncUrl) return;
      poll(async (signal) => {
        if (Date.now() > deadline) { status.textContent = '二维码已过期，请关闭后重新获取'; return false; }
        try {
          const r = await call(btn.dataset.syncUrl, 'POST', {}, signal);
          if (r && r.auth_state === 'authenticated') { status.textContent = '登录成功，正在刷新…'; setTimeout(() => location.reload(), 800); return false; }
          if (r && (r.reason || r.detail)) status.textContent = '等待扫码… ' + (r.reason || r.detail);
        } catch (err) { if (!signal.aborted) status.textContent = err.message; }
        return true;
      }, 5000);
    } catch (err) {
      card.textContent = '';
      card.appendChild(el('h3', {}, '无法获取二维码'));
      card.appendChild(el('p', {}, err.message));
      card.appendChild(closeBtn());
    }
  }
  // Visible login window on the console's host: the window writes the instance's cookies, then we re-check the login.
  async function windowLogin(btn) {
    const card = modal();
    card.appendChild(el('h3', {}, '在登录窗口中扫码'));
    const info = el('p', { class: 'muted' }, '正在打开登录窗口…');
    card.appendChild(info);
    try {
      const data = await call(btn.dataset.url, 'POST', {});
      const job = data && data.job;
      info.textContent = (btn.dataset.account || '') + ' · 已经打开了一个登录窗口，可能被其他窗口挡住了。';
      card.appendChild(el('p', { class: 'small muted' }, '请在该窗口中用该账号本人的小红书 App 扫码并确认。扫码后不要关闭窗口，保存登录后它会自动关闭。' + (job && job.expires_at ? '请在 ' + new Date(job.expires_at).toLocaleTimeString('zh-CN') + ' 前完成。' : '')));
      const status = el('p', { class: 'small', id: 'qr-status' }, '等待扫码…');
      card.appendChild(status);
      card.appendChild(closeBtn());
      poll(async (signal) => {
        try {
          const r = await call(btn.dataset.statusUrl, 'POST', {}, signal);
          const j = r && r.job;
          if (!j || j.state === 'running') return true;
          if (j.state === 'failed') { status.textContent = '登录没完成，请重试'; return false; }
          status.textContent = '登录已保存，正在检测登录状态…';
          const s = btn.dataset.syncUrl ? await call(btn.dataset.syncUrl, 'POST', {}, signal) : null;
          status.textContent = s && s.auth_state === 'authenticated' ? '登录成功，正在刷新…' : '扫码完成了，但还没检测到登录，请稍后再点「检测登录状态」';
          setTimeout(() => location.reload(), 1500);
          return false;
        } catch (err) { if (!signal.aborted) status.textContent = err.message; return true; }
      }, 3000);
    } catch (err) {
      card.textContent = '';
      card.appendChild(el('h3', {}, '无法打开登录窗口'));
      card.appendChild(el('p', {}, err.message));
      card.appendChild(closeBtn());
    }
  }
  // A thread opens where a chat opens: at the newest message.
  for (const box of document.querySelectorAll('[data-scroll-bottom]')) box.scrollTop = box.scrollHeight;

})();
`;

/** Content hash appended to asset URLs: a changed stylesheet or script is never served from a stale browser cache. */
export const ASSET_VERSION = createHash('sha256').update(CONSOLE_CSS).update(CONSOLE_JS).digest('hex').slice(0, 10);
