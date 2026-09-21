/**
 * Stylesheet of the public site. Same brand as the console (docs/design/steer-ui-kit.html: warm neutral canvas, ink,
 * gold only for the AI's own work), but a marketing page's scale: larger type, more air, one accent.
 * Shape rule: controls 8px, surfaces 14px, pill only for a status. No external fonts: the system CJK stack.
 * Real screenshots sit in a quiet window frame; the customer case is the page's one dark band. Grouping is by rules
 * and space, not cards: a bordered surface is kept for the screenshots and the form.
 */
export const SITE_CSS = `
:root{
  --canvas:#F7F6F2;--surface:#FFFFFF;--tint:#EFEDE7;--line:#E4E1DA;--line-strong:#CFCBC2;
  --text:#181817;--text-2:#45443F;--muted:#6B6A66;
  --gold:#B69A70;--gold-ink:#7D6440;--gold-soft:#F4EEE4;--ink:#1D1D1B;--ink-text:#EEECE6;--ink-muted:#A8A59D;
  --ok:#37704A;--warn:#9A6414;
  --r-control:8px;--r-surface:14px;
  --font:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC","Segoe UI",sans-serif;
  --num:"SF Pro Display",-apple-system,"Segoe UI",sans-serif;
  --shadow:0 1px 2px rgba(24,24,23,.05),0 28px 56px -28px rgba(40,34,24,.28);
  --st-mark-a:#232322;--st-mark-b:#3A3A39;--st-mark-fold:#6E6D6A;--st-mark-end:#1E1E1D;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root{
  --canvas:#131312;--surface:#1B1B19;--tint:#191917;--line:#2D2C29;--line-strong:#3D3C38;
  --text:#EEECE6;--text-2:#CAC7BF;--muted:#9E9B93;
  --gold:#C4A97F;--gold-ink:#D9C198;--gold-soft:#29241C;--ink:#EEECE6;--ink-text:#1A1A18;--ink-muted:#57554F;
  --ok:#82B794;--warn:#DDA85C;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 28px 56px -28px rgba(0,0,0,.7);
  --st-mark-a:#E9E6DF;--st-mark-b:#CFCBC2;--st-mark-fold:#9A968D;--st-mark-end:#6F6A61;
  color-scheme:dark;
}}
*,*::before,*::after{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:80px}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body.site{margin:0;background:var(--canvas);color:var(--text);font:17px/1.7 var(--font);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1,h2,h3,p,ul,ol,dl,dd,figure{margin:0}
ul,ol{padding:0;list-style:none}
a{color:inherit;text-decoration:none}
:focus-visible{outline:2px solid var(--text);outline-offset:3px;border-radius:4px}
.wrap{width:100%;max-width:1200px;margin:0 auto;padding:0 32px}

/* buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 18px;border-radius:var(--r-control);border:1px solid transparent;font:inherit;font-size:15px;font-weight:500;white-space:nowrap;cursor:pointer;transition:background-color .15s,border-color .15s,transform .15s}
.btn:active{transform:scale(.98)}
.btn-primary{background:var(--ink);color:var(--ink-text)}
.btn-primary:hover{background:color-mix(in srgb,var(--ink) 86%,var(--canvas))}
.btn-ghost{border-color:var(--line-strong);color:var(--text)}
.btn-ghost:hover{border-color:var(--text)}
.btn-lg{height:48px;padding:0 24px;font-size:16px}
.btn-block{width:100%;height:46px}

/* navigation */
.site-nav{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--canvas) 86%,transparent);-webkit-backdrop-filter:saturate(1.2) blur(12px);backdrop-filter:saturate(1.2) blur(12px);border-bottom:1px solid var(--line)}
.nav-inner{display:flex;align-items:center;gap:32px;height:64px}
.nav-links{display:flex;gap:26px;font-size:15px;color:var(--text-2)}
.nav-links a:hover{color:var(--text)}
.nav-cta{margin-left:auto;display:flex;gap:10px}
.nav-menu{display:none;margin-left:auto;position:relative}
.nav-menu summary{list-style:none;cursor:pointer;font-size:15px;padding:6px 12px;border:1px solid var(--line-strong);border-radius:var(--r-control)}
.nav-menu summary::-webkit-details-marker{display:none}
.nav-menu-body{position:absolute;right:0;top:calc(100% + 8px);display:grid;min-width:180px;padding:8px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-surface);box-shadow:var(--shadow)}
.nav-menu-body a{padding:10px 12px;border-radius:var(--r-control)}
.nav-menu-body a:hover{background:var(--tint)}

/* brand lockup: mark, 驭客, STEER */
.lockup{display:inline-flex;align-items:center;gap:10px;line-height:1}
.lockup .site-mark{width:20px;height:29px}
.lockup-zh{font-size:18px;font-weight:700;letter-spacing:.04em}
.lockup-en{padding-left:10px;border-left:1px solid var(--line-strong);font:600 11px/1 var(--num);letter-spacing:.32em;color:var(--muted)}
.kicker{font:500 15px/1.4 var(--num);letter-spacing:.01em;color:var(--gold-ink)}
.eyebrow{font-size:13px;font-weight:600;letter-spacing:.08em;color:var(--gold-ink);margin-bottom:14px}

/* hero: the claim, then the product itself */
.hero{padding:96px 0 104px}
.hero-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:64px;align-items:end}
.hero .kicker{margin-bottom:20px}
.hero h1{font-size:clamp(40px,5.6vw,76px);line-height:1.1;font-weight:700;letter-spacing:-.03em}
.hero-sub{font-size:18px;line-height:1.75;color:var(--text-2)}
.hero-cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}

/* a real console screen in a window frame */
.shot{margin:0}
.shot-frame{display:flex;align-items:center;height:30px;padding:0 14px;background:var(--tint);border:1px solid var(--line);border-bottom:0;border-radius:var(--r-surface) var(--r-surface) 0 0}
.shot-dots{display:flex;gap:6px}
.shot-dots i{width:9px;height:9px;border-radius:50%;background:var(--line-strong)}
.shot img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:0 0 var(--r-surface) var(--r-surface);background:var(--surface)}
.shot-frame,.shot img{box-shadow:var(--shadow)}
.shot figcaption{margin-top:14px;font-size:13px;color:var(--muted)}
.shot-hero{margin-top:72px}
.shot-hero .shot-frame,.shot-hero img{box-shadow:0 2px 4px rgba(24,24,23,.04),0 60px 120px -48px rgba(40,34,24,.45)}

/* the customer case: the page's one dark band */
.case{padding:112px 0;background:#161614;color:#EEECE6;--line:#2F2E2B;--muted:#9C998F}
@media (prefers-color-scheme:dark){.case{background:#1E1D1A;border-block:1px solid #34322D}}
.case-label{font-size:13px;font-weight:600;letter-spacing:.08em;color:#C9AE82}
.case h2{margin:18px 0 18px;font-size:clamp(30px,3.6vw,48px);line-height:1.22;font-weight:700;letter-spacing:-.02em;max-width:18em}
.case-store{color:var(--muted);font-size:16px}
.funnel{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin-top:64px;border-top:1px solid var(--line)}
.funnel li{display:grid;align-content:start;gap:4px;padding:28px 20px 0 0}
.funnel li+li{padding-left:20px;border-left:1px solid var(--line)}
.funnel b{font:600 clamp(34px,4vw,56px)/1.05 var(--num);letter-spacing:-.03em}
.funnel .unit{font-size:15px;font-weight:600}
.funnel .what{font-size:14px;line-height:1.6;color:var(--muted)}
.funnel li.is-end b,.funnel li.is-end .unit{color:#D9BE90}
.case-more{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:56px;padding-top:28px;border-top:1px solid var(--line)}
.case-more p{display:flex;align-items:baseline;gap:16px}
.case-more b{font:600 28px/1 var(--num);letter-spacing:-.02em;white-space:nowrap}
.case-more span{color:#CFCCC4;font-size:15px}
.case-note{margin-top:40px;font-size:13px;color:var(--muted)}

/* sections */
.section{padding:104px 0}
.section-tint{background:var(--tint);border-block:1px solid var(--line)}
.section h2{font-size:clamp(28px,3vw,40px);line-height:1.25;font-weight:650;letter-spacing:-.015em;margin-bottom:40px}
.section h3{font-size:19px;line-height:1.4;font-weight:600}
.nw{display:inline-block}

/* product: real screens next to the words */
.feature{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);gap:72px;align-items:center}
.feature+.feature{margin-top:128px}
.feature-copy h2{margin-bottom:18px}
.feature-copy>p{color:var(--text-2);max-width:30em}
.feature-wide{grid-template-columns:minmax(0,1fr)}
.feature-wide .feature-copy{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:72px;align-items:end}
.feature-wide .feature-copy h2{margin-bottom:0}
.shot-tall{max-width:560px;justify-self:end;width:100%}
.ticks{margin-top:28px;border-top:1px solid var(--line-strong)}
.ticks li{position:relative;padding:13px 0 13px 22px;border-bottom:1px solid var(--line);font-size:16px}
.ticks li::before{content:"";position:absolute;left:2px;top:24px;width:8px;height:1.5px;background:var(--gold)}
.caps{margin-top:136px}
.caps-title{margin-bottom:8px!important}
.caps-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:72px}
.cap{padding:36px 0 8px;border-top:1px solid var(--line-strong);margin-top:32px}
.cap .eyebrow{margin-bottom:10px}
.cap ul{margin-top:14px}
.cap li{padding:7px 0;font-size:15px;color:var(--text-2);line-height:1.65}

/* a day */
.how-grid{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:64px;align-items:start}
.how-copy h2{margin-bottom:20px}
.how-copy p{color:var(--text-2);max-width:30em}
.how-you{margin-top:24px;padding:16px 18px;border-left:2px solid var(--gold);background:var(--surface);border-radius:0 var(--r-control) var(--r-control) 0;color:var(--text)!important}
.day{position:relative;border-left:1px solid var(--line-strong);margin-left:6px}
.day li{position:relative;display:grid;grid-template-columns:96px 1fr;gap:16px;padding:14px 0 14px 26px}
.day li::before{content:"";position:absolute;left:-4px;top:24px;width:7px;height:7px;border-radius:50%;background:var(--canvas);box-shadow:inset 0 0 0 1.5px var(--line-strong)}
.day time{font:600 15px/1.8 var(--num);color:var(--text-2)}

/* what it will not do: ruled, the first rule leads */
.rules{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:72px;border-top:1px solid var(--line-strong)}
.rule{padding:28px 0;border-bottom:1px solid var(--line)}
.rule p{margin-top:8px;color:var(--text-2);font-size:16px;max-width:32em}
.rule-lead{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:72px;padding:36px 0}
.rule-lead h3{font-size:clamp(24px,2.4vw,32px);letter-spacing:-.01em}
.rule-lead p{margin-top:0;font-size:17px}

/* deploy */
.deploy-head{margin-bottom:44px}
.deploy-head h2{margin-bottom:14px}
.deploy-lede{color:var(--text-2);max-width:34em}
.deploy-groups{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px}
.deploy-groups h3{padding-bottom:10px;margin-bottom:6px;border-bottom:1px solid var(--line-strong);font-size:17px}
.deploy-groups li{padding:7px 0;font-size:15px;color:var(--text-2);line-height:1.6}

/* faq */
.faq-grid{display:grid;grid-template-columns:minmax(0,.7fr) minmax(0,1.3fr);gap:64px}
.faq{border-top:1px solid var(--line-strong)}
.faq details{border-bottom:1px solid var(--line)}
.faq summary{list-style:none;cursor:pointer;display:flex;justify-content:space-between;gap:16px;padding:20px 0;font-size:18px;font-weight:600}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";font-weight:400;color:var(--muted);transition:transform .2s}
.faq details[open] summary::after{transform:rotate(45deg)}
.faq details p{padding:0 0 22px;max-width:40em;color:var(--text-2)}

/* demo request */
.demo{padding:112px 0 128px;border-top:1px solid var(--line)}
.demo .kicker{margin-bottom:16px}
.demo h2{font-size:clamp(28px,3vw,40px);line-height:1.25;font-weight:700;letter-spacing:-.015em;margin-bottom:18px}
.demo-grid{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:64px;align-items:start}
.demo-copy p{color:var(--text-2);max-width:28em}
.demo-login{margin-top:28px;padding-top:20px;border-top:1px solid var(--line)}
.demo-login a{color:var(--text);font-weight:600;border-bottom:1px solid var(--line-strong)}
.demo-login a:hover{border-color:var(--text)}
.demo-card{padding:32px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-surface);box-shadow:var(--shadow)}
.demo-form{display:grid;gap:18px}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.field{display:grid;gap:6px;font-size:14px;font-weight:500;color:var(--text-2)}
.field-label{display:flex;align-items:baseline;gap:8px}
.field .opt{font-size:12px;font-weight:400;color:var(--muted)}
.field input,.field select,.field textarea{width:100%;height:44px;padding:0 12px;border:1px solid var(--line-strong);border-radius:var(--r-control);background:var(--surface);color:var(--text);font:inherit;font-size:16px}
.field textarea{height:auto;padding:10px 12px;resize:vertical;line-height:1.6}
.field input:focus,.field select:focus,.field textarea:focus{outline:0;border-color:var(--text-2);box-shadow:0 0 0 3px color-mix(in srgb,var(--text) 10%,transparent)}
.form-error{padding:10px 14px;border-radius:var(--r-control);background:color-mix(in srgb,#A8403A 10%,transparent);color:#A8403A;font-size:15px}
.form-note{font-size:13px;color:var(--muted);text-align:center}
.form-done h3{font-size:22px}
.form-done p{margin-top:10px;color:var(--text-2)}

/* footer */
.site-foot{border-top:1px solid var(--line);padding:36px 0 48px}
.foot-inner{display:flex;align-items:center;gap:32px;flex-wrap:wrap}
.foot-inner nav{display:flex;gap:22px;font-size:14px;color:var(--text-2)}
.foot-inner nav a:hover{color:var(--text)}
.foot-copy{margin-left:auto;font-size:13px;color:var(--muted)}

/* narrow screens: one column, the nav folds into a menu */
@media (max-width:960px){
  .nav-links,.nav-cta .btn-ghost{display:none}
  .hero-grid,.feature,.how-grid,.faq-grid,.demo-grid,.feature-wide .feature-copy,.rule-lead{grid-template-columns:minmax(0,1fr);gap:28px}
  .shot-tall{justify-self:start}
  .funnel{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:28px}
  .funnel li:nth-child(odd){padding-left:0;border-left:0}
  .funnel li.is-end{grid-column:1/-1}
  .caps-grid,.rules,.case-more{grid-template-columns:minmax(0,1fr)}
  .deploy-groups{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:720px){
  .wrap{padding:0 20px}
  .nav-inner{gap:12px}
  .nav-cta{display:none}
  .nav-menu{display:block}
  .hero{padding:48px 0 64px}
  .section{padding:72px 0}
  .case{padding:72px 0}
  .shot-hero{margin-top:44px}
  .feature+.feature,.caps{margin-top:88px}
  .lockup-en{display:none}
  .field-row{grid-template-columns:minmax(0,1fr)}
  .day li{grid-template-columns:84px 1fr;padding-left:20px}
  .demo-card{padding:22px}
  .foot-copy{margin-left:0;width:100%}
}
`;
