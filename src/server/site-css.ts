/**
 * Stylesheet of the public site. Same brand as the console (docs/design/steer-ui-kit.html: warm neutral canvas, ink,
 * gold only for the AI's own work and the lead it produces), at a marketing page's scale and edge to edge: content
 * runs to fluid side gutters, never into a centred column.
 * Shape rule: controls 8px, surfaces and screenshots 10px, pill only for a status. No external fonts.
 * Depth: the flow from the brand kit (SMIL, frozen under reduced motion), a screenshot that straightens as it
 * scrolls in (CSS scroll timeline), the mark as a stacked solid that sways, and a fan of two real screens. The
 * script only feeds pointer position into --px/--py; nothing depends on it.
 * The case band is the page's one dark block.
 */
export const SITE_CSS = `
@property --spin{syntax:'<angle>';inherits:false;initial-value:-26deg}
:root{
  --canvas:#F7F6F2;--surface:#FFFFFF;--tint:#EFEDE7;--line:#E4E1DA;--line-strong:#CFCBC2;
  --text:#181817;--text-2:#45443F;--muted:#6B6A66;
  --gold:#B69A70;--gold-ink:#7D6440;--gold-line:#D9C8AA;--ink:#1D1D1B;--ink-text:#EEECE6;
  --band:#141413;--band-line:#2E2D2A;--band-text:#EEECE6;--band-muted:#9C998F;--band-gold:#D9BE90;
  --r-control:8px;--r-surface:10px;
  --g:clamp(20px,4.4vw,84px);
  --ease:cubic-bezier(.16,1,.3,1);
  --font:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC","Segoe UI",sans-serif;
  --num:"SF Pro Display",-apple-system,"Segoe UI",sans-serif;
  --shadow:0 1px 2px rgba(24,24,23,.05),0 30px 60px -30px rgba(40,34,24,.3);
  --shadow-deep:0 2px 4px rgba(24,24,23,.04),0 50px 110px -40px rgba(40,34,24,.5);
  --st-mark-a:#232322;--st-mark-b:#3A3A39;--st-mark-fold:#6E6D6A;--st-mark-end:#1E1E1D;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root{
  --canvas:#131312;--surface:#1B1B19;--tint:#181816;--line:#2D2C29;--line-strong:#3D3C38;
  --text:#EEECE6;--text-2:#CAC7BF;--muted:#9E9B93;
  --gold:#C4A97F;--gold-ink:#D9C198;--gold-line:#5A4C37;--ink:#EEECE6;--ink-text:#1A1A18;
  --band:#1E1D1A;--band-line:#36342F;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 30px 60px -30px rgba(0,0,0,.7);
  --shadow-deep:0 2px 4px rgba(0,0,0,.4),0 50px 110px -40px rgba(0,0,0,.85);
  --st-mark-a:#E9E6DF;--st-mark-b:#CFCBC2;--st-mark-fold:#9A968D;--st-mark-end:#6F6A61;
  color-scheme:dark;
}}
*,*::before,*::after{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:80px}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body.site{margin:0;background:var(--canvas);color:var(--text);font:17px/1.7 var(--font);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;overflow-x:clip}
h1,h2,h3,p,ul,ol,dl,dd,figure{margin:0}
ul,ol{padding:0;list-style:none}
a{color:inherit;text-decoration:none}
img{max-width:100%}
:focus-visible{outline:2px solid var(--text);outline-offset:3px;border-radius:4px}
.bleed{width:100%;padding-inline:var(--g)}
.nw{display:inline-block}
.kicker{font:500 15px/1.4 var(--num);letter-spacing:.01em;color:var(--gold-ink)}
h2{font-size:clamp(30px,3.4vw,52px);line-height:1.18;font-weight:700;letter-spacing:-.025em}
h3{font-size:19px;line-height:1.4;font-weight:600}

/* buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 18px;border-radius:var(--r-control);border:1px solid transparent;font:inherit;font-size:15px;font-weight:500;white-space:nowrap;cursor:pointer;transition:background-color .15s,border-color .15s,transform .2s var(--ease)}
.btn:active{transform:scale(.98)}
.btn-primary{background:var(--ink);color:var(--ink-text)}
.btn-primary:hover{background:color-mix(in srgb,var(--ink) 86%,var(--canvas))}
.btn-ghost{border-color:var(--line-strong);color:var(--text)}
.btn-ghost:hover{border-color:var(--text)}
.btn-lg{height:50px;padding:0 26px;font-size:16px}
.btn-block{width:100%;height:46px}

/* brand lockup: mark, 驭客, STEER */
.lockup{display:inline-flex;align-items:center;gap:10px;line-height:1}
.site-mark{width:20px;height:29px}
.lockup-zh{font-size:18px;font-weight:700;letter-spacing:.04em}
.lockup-en{padding-left:10px;border-left:1px solid var(--line-strong);font:600 11px/1 var(--num);letter-spacing:.32em;color:var(--muted)}

/* navigation */
.site-nav{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--canvas) 84%,transparent);-webkit-backdrop-filter:saturate(1.2) blur(14px);backdrop-filter:saturate(1.2) blur(14px);border-bottom:1px solid var(--line)}
.nav-inner{display:flex;align-items:center;gap:40px;height:64px}
.nav-links{display:flex;gap:28px;font-size:15px;color:var(--text-2)}
.nav-links a:hover{color:var(--text)}
.nav-cta{margin-left:auto;display:flex;gap:10px}
.nav-menu{display:none;margin-left:auto;position:relative}
.nav-menu summary{list-style:none;cursor:pointer;font-size:15px;padding:6px 12px;border:1px solid var(--line-strong);border-radius:var(--r-control)}
.nav-menu summary::-webkit-details-marker{display:none}
.nav-menu-body{position:absolute;right:0;top:calc(100% + 8px);display:grid;min-width:180px;padding:8px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-surface);box-shadow:var(--shadow)}
.nav-menu-body a{padding:10px 12px;border-radius:var(--r-control)}
.nav-menu-body a:hover{background:var(--tint)}

/* hero: poster type on the left, the promise and the way in on the right, the flow edge to edge below */
.hero{padding-top:clamp(40px,6vh,80px)}
.hero-top{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(280px,1fr);gap:5vw;align-items:end}
.hero h1{font-size:clamp(40px,6.4vw,118px);line-height:1.04;font-weight:800;letter-spacing:-.045em}
.hero-side{display:grid;gap:18px;padding-bottom:10px}
.hero-sub{font-size:18px;line-height:1.75;color:var(--text-2);max-width:26em}
.hero-cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px}

/* the flow from the brand kit, drawn with one store's real counts */
.flow{margin-top:clamp(28px,5vh,56px)}
.flow svg{display:block;width:100%;height:auto;overflow:visible}
.flow .lane{fill:none;stroke:var(--line-strong);stroke-width:1.2}
.flow .spine{fill:none;stroke:var(--muted);stroke-width:1.6;opacity:.6}
.flow .spine-out{fill:none;stroke:var(--gold);stroke-width:2.2}
.flow .p-in{fill:var(--muted)}
.flow .p-out{fill:var(--gold)}
.flow .node{fill:var(--surface);stroke:var(--line-strong);stroke-width:1.2}
.flow .halo{fill:var(--gold);opacity:0;transform-box:fill-box;transform-origin:center;animation:halo 2.6s var(--ease) infinite}
.flow .src{fill:var(--muted);font:16px var(--font)}
.flow .chip{fill:var(--surface);stroke:var(--gold-line);stroke-width:1.2;filter:drop-shadow(0 12px 18px rgba(40,34,24,.12))}
.flow .chip-t1{fill:var(--text);font:600 21px var(--font)}
.flow .chip-score{fill:var(--gold-ink);font:600 21px var(--num)}
.flow .chip-t2{fill:var(--muted);font:17px var(--font)}
.flow .static{display:none}
.flow figcaption{padding-inline:var(--g);margin-top:14px;font-size:13px;color:var(--muted)}
@keyframes halo{0%{transform:scale(1);opacity:.24}70%,100%{transform:scale(1.55);opacity:0}}

/* a real console screen in a window frame */
.shot{border-radius:var(--r-surface);overflow:hidden;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow)}
.shot-frame{display:flex;align-items:center;height:28px;padding:0 13px;background:var(--tint);border-bottom:1px solid var(--line)}
.shot-dots{display:flex;gap:6px}
.shot-dots i{width:9px;height:9px;border-radius:50%;background:var(--line-strong)}
.shot img{display:block;width:100%;height:auto}

/* the stage: the inbox lies back in perspective and stands up as it scrolls in */
.stage{padding-top:clamp(64px,9vh,112px);perspective:2400px}
.stage-inner{transform-style:preserve-3d;transform:rotateX(calc(var(--py,0) * -3deg)) rotateY(calc(var(--px,0) * 5deg));transition:transform .8s var(--ease)}
.stage-tilt{transform-origin:50% 0}
.shot-stage{box-shadow:var(--shadow-deep)}
.stage-cap{margin-top:18px;font-size:13px;color:var(--muted)}

/* the customer case: the page's one dark block, with the mark as a solid */
.case{margin-top:clamp(96px,12vh,150px);padding:clamp(80px,11vh,140px) 0;background:var(--band);color:var(--band-text);overflow:hidden}
.case-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:4vw;align-items:center}
.case-label{font-size:13px;font-weight:600;letter-spacing:.08em;color:var(--band-gold)}
.case h2{margin:18px 0;font-size:clamp(32px,3.8vw,60px);line-height:1.16;font-weight:800;letter-spacing:-.03em}
.case-store{color:var(--band-muted);font-size:16px}
.funnel{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin-top:56px;border-top:1px solid var(--band-line)}
.funnel li{display:grid;align-content:start;gap:4px;padding:26px 16px 0 0}
.funnel li+li{padding-left:16px;border-left:1px solid var(--band-line)}
.funnel b{font:600 clamp(30px,3vw,50px)/1.05 var(--num);letter-spacing:-.03em}
.funnel .unit{font-size:15px;font-weight:600}
.funnel .what{font-size:13px;line-height:1.6;color:var(--band-muted)}
.funnel li.is-end b,.funnel li.is-end .unit{color:var(--band-gold)}
.case-more{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:44px;padding-top:24px;border-top:1px solid var(--band-line)}
.case-more p{display:flex;align-items:baseline;gap:14px}
.case-more b{font:600 26px/1 var(--num);letter-spacing:-.02em;white-space:nowrap}
.case-more span{color:#CFCCC4;font-size:15px}
.case-note{margin-top:32px;font-size:13px;color:var(--band-muted)}
.solid{position:relative;display:grid;place-items:center;height:clamp(360px,42vw,640px);perspective:1500px}
.solid::after{content:"";position:absolute;left:18%;right:18%;bottom:6%;height:40px;border-radius:50%;background:radial-gradient(closest-side,rgba(0,0,0,.55),transparent);filter:blur(6px)}
.solid-spin{position:relative;width:clamp(170px,19vw,300px);aspect-ratio:256/368;transform-style:preserve-3d;transform:rotateX(calc(10deg + var(--py,0) * -16deg)) rotateY(calc(var(--spin) + var(--px,0) * 34deg));transition:transform .9s var(--ease)}
.solid-layer{position:absolute;inset:0;width:100%;height:100%;transform:translateZ(calc(var(--z) * -2.3px))}
.solid-layer:not(:first-child){filter:brightness(.36) saturate(.7)}

/* product: words on the left, two real screens fanned in depth on the right */
.product{padding:clamp(110px,14vh,170px) 0 clamp(90px,12vh,140px)}
.product-grid{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);gap:5vw;align-items:center}
.product-copy h2{margin-bottom:20px}
.product-copy>p{color:var(--text-2);max-width:30em}
.ticks{margin-top:28px;border-top:1px solid var(--line-strong)}
.ticks li{position:relative;padding:13px 0 13px 22px;border-bottom:1px solid var(--line);font-size:16px}
.ticks li::before{content:"";position:absolute;left:2px;top:24px;width:8px;height:1.5px;background:var(--gold)}
.fan{position:relative;height:clamp(380px,35vw,580px);perspective:1800px;transform-style:preserve-3d}
.fan-card{position:absolute;transition:transform .8s var(--ease)}
.fan-back{left:0;top:20%;width:80%;transform:rotateY(calc(16deg + var(--px,0) * 8deg)) rotateX(calc(5deg + var(--py,0) * -5deg)) translateZ(-90px)}
.fan-front{right:0;top:0;width:44%;transform:rotateY(calc(-12deg + var(--px,0) * 10deg)) rotateX(calc(4deg + var(--py,0) * -6deg)) translateZ(50px)}
.fan-front .shot{box-shadow:var(--shadow-deep)}
.fan:hover .fan-front{transform:rotateY(calc(-6deg + var(--px,0) * 10deg)) rotateX(calc(2deg + var(--py,0) * -6deg)) translateZ(90px)}
.caps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));column-gap:clamp(24px,3vw,56px);margin-top:clamp(90px,12vh,140px)}
.cap{padding-top:22px;border-top:1px solid var(--line-strong)}
.cap h3{font-size:14px;font-weight:600;color:var(--gold-ink)}
.cap-title{margin-top:8px;font-size:20px;line-height:1.4;font-weight:650;letter-spacing:-.01em}
.cap ul{margin-top:14px}
.cap li{padding:6px 0;font-size:15px;color:var(--text-2);line-height:1.65}

/* a day, as one line across the whole width */
.how{padding:clamp(90px,12vh,140px) 0;background:var(--tint);border-block:1px solid var(--line)}
.how-head{display:grid;gap:18px}
.how-head p{max-width:40em;color:var(--text-2)}
.how-head b{color:var(--text)}
.day{position:relative;display:grid;grid-template-columns:repeat(8,minmax(0,1fr));margin-top:64px}
.day::before{content:"";position:absolute;left:0;right:0;top:6px;height:1px;background:var(--line-strong)}
.day li{position:relative;display:grid;align-content:start;gap:6px;padding:32px 18px 0 0}
.day li::before{content:"";position:absolute;left:0;top:0;width:13px;height:13px;border-radius:50%;background:var(--tint);box-shadow:inset 0 0 0 1.5px var(--line-strong)}
.day li:last-child::before{background:var(--gold);box-shadow:none}
.day time{font:600 20px/1.3 var(--num);letter-spacing:-.01em}
.day span{font-size:14px;line-height:1.6;color:var(--text-2)}

/* sections */
.section{padding:clamp(90px,12vh,140px) 0}
.section-tint{background:var(--tint);border-block:1px solid var(--line)}

/* what it will not do: the first rule leads across the width, the other four share a row */
.trust-grid h2{margin-bottom:40px}
.rules{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));column-gap:clamp(24px,3vw,56px);border-top:1px solid var(--line-strong)}
.rule{padding:26px 0 0}
.rule p{margin-top:8px;color:var(--text-2);font-size:15px}
.rule-lead{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);column-gap:5vw;padding:36px 0 40px;margin-bottom:6px;border-bottom:1px solid var(--line)}
.rule-lead h3{font-size:clamp(26px,2.6vw,40px);font-weight:700;letter-spacing:-.02em}
.rule-lead p{margin-top:0;font-size:18px}

/* deploy */
.deploy-grid{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.6fr);gap:5vw;align-items:start}
.deploy-head h2{margin-bottom:16px}
.deploy-lede{color:var(--text-2);max-width:26em}
.deploy-groups{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:clamp(20px,2.4vw,44px)}
.deploy-groups h3{padding-bottom:10px;margin-bottom:6px;border-bottom:1px solid var(--line-strong);font-size:17px}
.deploy-groups li{padding:7px 0;font-size:15px;color:var(--text-2);line-height:1.6}

/* faq */
.faq-grid{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.6fr);gap:5vw}
.faq{border-top:1px solid var(--line-strong)}
.faq details{border-bottom:1px solid var(--line)}
.faq summary{list-style:none;cursor:pointer;display:flex;justify-content:space-between;gap:16px;padding:20px 0;font-size:18px;font-weight:600}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";font-weight:400;color:var(--muted);transition:transform .2s}
.faq details[open] summary::after{transform:rotate(45deg)}
.faq details p{padding:0 0 22px;max-width:44em;color:var(--text-2)}

/* demo request */
.demo{padding:clamp(90px,12vh,140px) 0 clamp(100px,13vh,150px);border-top:1px solid var(--line)}
.demo-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:5vw;align-items:start}
.demo .kicker{margin-bottom:16px}
.demo h2{font-size:clamp(34px,4.2vw,68px);line-height:1.1;font-weight:800;letter-spacing:-.035em;margin-bottom:22px}
.demo-copy p{color:var(--text-2);max-width:28em}
.demo-login{margin-top:28px;padding-top:20px;border-top:1px solid var(--line)}
.demo-login a{color:var(--text);font-weight:600;border-bottom:1px solid var(--line-strong)}
.demo-login a:hover{border-color:var(--text)}
.demo-card{padding:clamp(22px,2.4vw,40px);background:var(--surface);border:1px solid var(--line);border-radius:var(--r-surface);box-shadow:var(--shadow)}
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
.foot-inner{display:flex;align-items:center;gap:40px;flex-wrap:wrap}
.foot-inner nav{display:flex;gap:24px;font-size:14px;color:var(--text-2)}
.foot-inner nav a:hover{color:var(--text)}
.foot-copy{margin-left:auto;font-size:13px;color:var(--muted)}

/* motion: only when the visitor has not asked for less */
@media (prefers-reduced-motion:no-preference){
  .solid-spin{animation:sway 11s ease-in-out infinite alternate}
  @keyframes sway{from{--spin:-34deg}to{--spin:26deg}}
  .hero h1,.hero-side,.flow{animation:rise .9s var(--ease) both}
  .hero-side{animation-delay:.08s}
  .flow{animation-delay:.16s}
  @keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
  @supports (animation-timeline:view()){
    .stage-tilt{animation:stand linear both;animation-timeline:view();animation-range:entry 0% cover 42%}
    @keyframes stand{from{transform:rotateX(28deg) scale(.88) translateY(40px)}to{transform:none}}
  }
}
@media (prefers-reduced-motion:reduce){
  .flow .particles{display:none}
  .flow .static{display:inline}
  .flow .halo{animation:none}
}

/* narrower screens: fewer columns, never a sideways scroll */
@media (max-width:1180px){
  .nav-links{display:none}
  .caps,.rules{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:36px}
  .day{grid-template-columns:repeat(4,minmax(0,1fr));row-gap:40px}
  .day::before{display:none}
  .deploy-grid,.faq-grid{grid-template-columns:minmax(0,1fr);gap:36px}
}
@media (max-width:960px){
  .nav-cta .btn-ghost{display:none}
  .hero-top,.case-grid,.product-grid,.demo-grid,.rule-lead{grid-template-columns:minmax(0,1fr);gap:32px}
  .solid{height:340px}
  .funnel{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:26px}
  .funnel li:nth-child(odd){padding-left:0;border-left:0}
  .funnel li.is-end{grid-column:1/-1}
  .fan{height:clamp(360px,80vw,560px)}
}
@media (max-width:720px){
  .nav-inner{gap:12px}
  .nav-cta{display:none}
  .nav-menu{display:block}
  .lockup-en{display:none}
  .hero h1{font-size:clamp(30px,10.2vw,48px)}
  .flow{display:none}
  .hero-side{padding-bottom:0}
  .caps,.rules,.case-more,.deploy-groups,.field-row{grid-template-columns:minmax(0,1fr)}
  .day{grid-template-columns:minmax(0,1fr);row-gap:0;margin-left:6px;border-left:1px solid var(--line-strong)}
  .day li{grid-template-columns:84px 1fr;padding:12px 0 12px 22px}
  .day li::before{left:-7px;top:19px}
  .fan-back{top:auto;bottom:0;width:92%}
  .fan-front{width:62%}
  .foot-copy{margin-left:0;width:100%}
}
`;

/**
 * The public site's only script: it feeds the pointer's position over a [data-tilt] element into --px/--py
 * (-0.5..0.5), which the 3D pieces read. Fine pointers only, never under reduced motion; without it the page is whole.
 */
export const SITE_JS = `(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !matchMedia('(pointer: fine)').matches) return;
  for (const el of document.querySelectorAll('[data-tilt]')) {
    let frame = 0;
    const set = (x, y) => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { el.style.setProperty('--px', x.toFixed(3)); el.style.setProperty('--py', y.toFixed(3)); }); };
    el.addEventListener('pointermove', (e) => { const r = el.getBoundingClientRect(); set((e.clientX - r.left) / r.width - 0.5, (e.clientY - r.top) / r.height - 0.5); });
    el.addEventListener('pointerleave', () => set(0, 0));
  }
})();
`;
