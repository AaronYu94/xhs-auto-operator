// xhs-dm-read: read the direct-message inbox of ONE managed account from its own logged-in session.
//
// Xiaohongshu has no DM API a store can call (the official IM API is open only to approved 客服服务商), but the
// account's own web session can open its own inbox at /chat — the same surface tools/xhs-dm-send already opens to
// deliver and read back one reviewed message. This tool only ever READS.
//
// Guarantees this tool keeps:
//   - It never types, never clicks a send control, and never writes the session's cookies back.
//   - -probe only loads the conversation LIST and reports its structure. It opens no conversation, so nothing the
//     account has not already seen is marked as read.
//
// Usage: COOKIES_PATH=<instance dir>/cookies.json xhs-dm-read -probe [-shot <dir>]
// Output contains exactly one of PROBE_OK / PROBE_FAILED / REQUIRES_AUTH.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/browser"
	"github.com/xpzouying/xiaohongshu-mcp/configs"
	"github.com/xpzouying/xiaohongshu-mcp/cookies"
)

const inboxURL = "https://www.xiaohongshu.com/chat"

func main() {
	logrus.SetLevel(logrus.ErrorLevel)
	probe := flag.Bool("probe", false, "report the structure of the conversation list; opens no conversation")
	shotDir := flag.String("shot", "", "directory for screenshots (optional)")
	headless := flag.Bool("headless", true, "run headless")
	flag.Parse()
	if !*probe {
		fmt.Println("PROBE_FAILED: only -probe is implemented; reading is added once the list structure is known")
		os.Exit(2)
	}

	path := cookies.GetCookiesFilePath()
	if _, err := os.Stat(path); err != nil {
		fmt.Println("REQUIRES_AUTH: no session file for this account; log it in first")
		os.Exit(1)
	}
	store := cookies.NewLoadCookie(path)
	b := browser.NewBrowser(*headless, browser.WithFingerprintSeed(configs.ResolveFingerprintSeed(store)))
	defer b.Close()
	runProbe(b, *shotDir)
}

func runProbe(b interface{ NewPage() *rod.Page }, shotDir string) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Printf("PROBE_FAILED: %v\n", r)
		}
	}()
	page := b.NewPage()
	defer page.Close()
	page.MustSetViewport(1440, 900, 1, false)
	page.Timeout(60 * time.Second).MustNavigate(inboxURL).MustWaitLoad()
	time.Sleep(5 * time.Second)

	info := page.MustInfo()
	fmt.Printf("final_url=%s\n", info.URL)
	fmt.Printf("title=%s\n", info.Title)
	shot(page, shotDir, "1-inbox")

	// A logged-out session is sent to a login surface: that is REQUIRES_AUTH, never "an empty inbox".
	loginJS := `() => {
	  const q = (s) => document.querySelector(s);
	  const modal = q('.login-container') || q('[class*=login-modal]') || q('.qrcode-img') || q('[class*=login-box]');
	  return JSON.stringify({ login_modal: !!modal, path: location.pathname });
	}`
	if res, err := page.Eval(loginJS); err == nil {
		fmt.Printf("[login] %s\n", res.Value.Str())
	}

	// Structure only. Repeated siblings that each carry an avatar are the conversation rows; we report their class
	// path and the shape of what is inside (which child holds a name, a preview, a time, an unread badge), with every
	// piece of text cut to a few characters: enough to tell a name from a timestamp, not enough to read a message.
	structJS := `() => {
	  const cut = (t) => { t = (t || '').trim().replace(/\s+/g, ' '); return t.length > 6 ? t.slice(0, 6) + '…' : t; };
	  const cls = (el) => (el.getAttribute('class') || '').trim().split(/\s+/).slice(0, 3).join('.');
	  const path = (el) => { const out = []; for (let n = el; n && n !== document.body && out.length < 6; n = n.parentElement) out.unshift(n.tagName.toLowerCase() + (cls(n) ? '.' + cls(n) : '')); return out.join(' > '); };
	  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
	  // containers whose visible children mostly contain an <img>: the list of people
	  const lists = [];
	  for (const el of document.querySelectorAll('div, ul, section')) {
	    const kids = [...el.children].filter(visible);
	    if (kids.length < 2) continue;
	    const withImg = kids.filter((k) => k.querySelector('img'));
	    if (withImg.length >= Math.max(2, Math.ceil(kids.length * 0.7))) {
	      const r = el.getBoundingClientRect();
	      lists.push({ path: path(el), rows: kids.length, x: Math.round(r.x), w: Math.round(r.width), el });
	    }
	  }
	  // keep the innermost candidates on the left side of the page (the inbox column)
	  const inner = lists.filter((l) => !lists.some((o) => o !== l && l.el.contains(o.el) && o.rows >= 2));
	  const report = inner.slice(0, 4).map((l) => {
	    const rows = [...l.el.children].filter(visible).slice(0, 3).map((row) => {
	      const leaves = [];
	      for (const n of row.querySelectorAll('*')) {
	        if (n.children.length === 0 && (n.textContent || '').trim()) leaves.push({ cls: cls(n), text: cut(n.textContent) });
	        if (leaves.length >= 8) break;
	      }
	      const badge = row.querySelector('[class*=unread], [class*=badge], [class*=count], [class*=dot], [class*=red]');
	      return { row_cls: cls(row), leaves, badge: badge ? { cls: cls(badge), text: cut(badge.textContent) } : null, href: row.getAttribute('href') || (row.querySelector('a') || {}).getAttribute?.('href') || null };
	    });
	    return { path: l.path, rows: l.rows, x: l.x, w: l.w, sample: rows };
	  });
	  // anything that looks like an unread total (tab badges, the sidebar dot)
	  const totals = [...document.querySelectorAll('[class*=unread], [class*=badge]')].filter(visible).slice(0, 8).map((n) => ({ cls: cls(n), text: cut(n.textContent) }));
	  return JSON.stringify({ lists: report, unread_markers: totals }, null, 1);
	}`
	res, err := page.Eval(structJS)
	if err != nil {
		fmt.Printf("PROBE_FAILED: could not read the page structure: %v\n", err)
		return
	}
	fmt.Printf("[structure]\n%s\n", clip(res.Value.Str(), 9000))

	// Second pass, now that the row is known (.xhs-im-conv-item): where the preview line and the unread badge live,
	// and whether the page's own data carries the other person's user id (so a conversation can be matched to a lead
	// without opening it). Values are reported by SHAPE only — type, length, "24-hex" — never printed.
	rowJS := `() => {
	  const cut = (t) => { t = (t || '').trim().replace(/\s+/g, ' '); return t.length > 6 ? t.slice(0, 6) + '…' : t; };
	  const cls = (el) => (el.getAttribute('class') || '').trim().split(/\s+/).slice(0, 3).join('.');
	  const shape = (v) => {
	    if (v === null || v === undefined) return String(v);
	    if (typeof v === 'string') return /^[0-9a-f]{24}$/i.test(v) ? 'str:24hex' : 'str:' + v.length;
	    if (typeof v === 'number' || typeof v === 'boolean') return typeof v;
	    if (Array.isArray(v)) return 'array:' + v.length;
	    return 'object{' + Object.keys(v).slice(0, 14).join(',') + '}';
	  };
	  const idish = /(user|uid|id|peer|target|guest|host|conv|session|chat)/i;
	  const propsOf = (el) => {
	    const out = {};
	    for (let n = el, depth = 0; n && depth < 4; n = n.parentElement, depth++) {
	      const c = n.__vueParentComponent;
	      const sources = [c && c.props, c && c.vnode && c.vnode.props, n.__vue__ && n.__vue__.$props];
	      for (const src of sources) {
	        if (!src) continue;
	        for (const k of Object.keys(src)) {
	          const v = src[k];
	          if (idish.test(k)) out[k] = shape(v);
	          else if (v && typeof v === 'object' && !Array.isArray(v)) {
	            for (const kk of Object.keys(v)) if (idish.test(kk)) out[k + '.' + kk] = shape(v[kk]);
	          }
	        }
	      }
	      if (Object.keys(out).length) break;
	    }
	    return out;
	  };
	  const rows = [...document.querySelectorAll('.xhs-im-conv-item')].slice(0, 8).map((row) => {
	    const content = row.querySelector('.xhs-im-conv-item__content') || row;
	    const parts = [...content.querySelectorAll('*')]
	      .filter((n) => n.children.length === 0 || n.querySelector('img'))
	      .filter((n) => !/__name|__time/.test(n.getAttribute('class') || ''))
	      .filter((n) => (n.textContent || '').trim() || n.querySelector('img'))
	      .slice(0, 4)
	      .map((n) => ({ cls: cls(n), text: cut(n.textContent) }));
	    const data = [...row.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.name + '=' + shape(a.value));
	    const badge = row.querySelector('[class*=badge], [class*=unread], [class*=count], [class*=dot]');
	    const name = (row.querySelector('.xhs-im-conv-item__name') || {}).textContent || '';
	    return {
	      stranger_folder: name.trim() === '陌生人消息',
	      preview: parts,
	      badge: badge ? { cls: cls(badge), text: cut(badge.textContent), visible: badge.getBoundingClientRect().width > 0 } : null,
	      data_attrs: data,
	      component_props: propsOf(row),
	    };
	  });
	  // the page's store, if it exposes one (Pinia / Vuex): only which keys look like a conversation list
	  const app = document.querySelector('#app') || document.querySelector('[data-v-app]');
	  const gp = app && app.__vue_app__ && app.__vue_app__.config && app.__vue_app__.config.globalProperties;
	  const pinia = gp && gp.$pinia;
	  const stores = pinia && pinia.state && pinia.state.value ? Object.keys(pinia.state.value) : [];
	  const convStores = stores.filter((k) => /im|chat|msg|message|conv/i.test(k)).map((k) => k + ':' + shape(pinia.state.value[k]));
	  return JSON.stringify({ rows, stores: stores.slice(0, 30), conversation_stores: convStores }, null, 1);
	}`
	if res2, err := page.Eval(rowJS); err == nil {
		fmt.Printf("[rows]\n%s\n", clip(res2.Value.Str(), 12000))
	} else {
		fmt.Printf("[rows] could not read: %v\n", err)
	}

	// Third pass: what the page already holds about each conversation's LAST message (Pinia store lastConversation),
	// and whether a row's data-conv-id is the other person's user id. Again shapes and booleans only.
	mapJS := `() => {
	  const shape = (v) => {
	    if (v === null || v === undefined) return String(v);
	    if (typeof v === 'string') return /^[0-9a-f]{24}$/i.test(v) ? 'str:24hex' : 'str:' + v.length;
	    if (typeof v === 'number' || typeof v === 'boolean') return typeof v;
	    if (Array.isArray(v)) return 'array:' + v.length;
	    return 'object{' + Object.keys(v).slice(0, 20).join(',') + '}';
	  };
	  const deep = (obj, prefix, out, depth) => {
	    if (!obj || typeof obj !== 'object' || depth > 2) return;
	    for (const k of Object.keys(obj).slice(0, 40)) {
	      const v = obj[k];
	      out[prefix + k] = shape(v);
	      if (v && typeof v === 'object' && !Array.isArray(v)) deep(v, prefix + k + '.', out, depth + 1);
	    }
	  };
	  const app = document.querySelector('#app') || document.querySelector('[data-v-app]');
	  const pinia = app && app.__vue_app__ && app.__vue_app__.config.globalProperties.$pinia;
	  const state = pinia && pinia.state && pinia.state.value;
	  const map = state && state.lastConversation && state.lastConversation.conversationMap;
	  const convIds = [...document.querySelectorAll('.xhs-im-conv-item')].map((r) => r.getAttribute('data-conv-id')).filter(Boolean);
	  const kinds = [...new Set([...document.querySelectorAll('.xhs-im-conv-item')].map((r) => r.getAttribute('data-conv-kind')))];
	  const rowCount = document.querySelectorAll('.xhs-im-conv-item').length;
	  const names = [...document.querySelectorAll('.xhs-im-conv-item__name')].map((n) => (n.textContent || '').trim());
	  const report = { row_count: rowCount, conv_kinds: kinds, stranger_folder_present: names.some((n) => /陌生人/.test(n)) };
	  if (!map) return JSON.stringify({ ...report, conversation_map: 'absent' }, null, 1);
	  const keys = Object.keys(map);
	  report.map_size = keys.length;
	  report.map_key_shape = keys.length ? shape(keys[0]) : null;
	  report.map_keys_match_conv_ids = convIds.filter((id) => keys.includes(id)).length + '/' + convIds.length;
	  // the shape of one entry, and whether any user-id-like field inside it equals the row's conv id
	  const first = convIds.find((id) => map[id]);
	  if (first) {
	    const fields = {};
	    deep(map[first], '', fields, 0);
	    report.entry_fields = fields;
	    const eq = [];
	    const scan = (obj, prefix, depth) => {
	      if (!obj || typeof obj !== 'object' || depth > 3) return;
	      for (const k of Object.keys(obj)) {
	        const v = obj[k];
	        if (typeof v === 'string' && v === first) eq.push(prefix + k);
	        else if (v && typeof v === 'object') scan(v, prefix + k + '.', depth + 1);
	      }
	    };
	    scan(map[first], '', 0);
	    report.fields_equal_to_conv_id = eq;
	    // is the logged-in account's own id one of the entry's id fields? (tells sender from receiver)
	    const me = state.user && (state.user.userInfo || state.user.userPageData || {});
	    const myId = me && (me.userId || me.user_id || (me.basicInfo && me.basicInfo.userId));
	    report.own_user_id_known = !!myId;
	    if (myId) {
	      const mine = [];
	      const scanMe = (obj, prefix, depth) => {
	        if (!obj || typeof obj !== 'object' || depth > 3) return;
	        for (const k of Object.keys(obj)) {
	          const v = obj[k];
	          if (typeof v === 'string' && v === myId) mine.push(prefix + k);
	          else if (v && typeof v === 'object') scanMe(v, prefix + k + '.', depth + 1);
	        }
	      };
	      scanMe(map[first], '', 0);
	      report.fields_equal_to_own_id = mine;
	      report.conv_id_is_own_id = first === myId;
	    }
	  }
	  return JSON.stringify(report, null, 1);
	}`
	if res3, err := page.Eval(mapJS); err == nil {
		fmt.Printf("[last_messages]\n%s\n", clip(res3.Value.Str(), 12000))
	} else {
		fmt.Printf("[last_messages] could not read: %v\n", err)
	}
	fmt.Println("PROBE_OK: inbox list read; no conversation opened, nothing typed, nothing marked read")
}

func shot(page *rod.Page, dir, name string) {
	if dir == "" {
		return
	}
	_ = os.MkdirAll(dir, 0o700)
	out := filepath.Join(dir, name+".png")
	page.MustScreenshot(out)
	fmt.Printf("[screenshot] %s\n", out)
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

var _ = strings.TrimSpace
