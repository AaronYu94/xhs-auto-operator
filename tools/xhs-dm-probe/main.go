// xhs-dm-probe: READ-ONLY reconnaissance of the direct-message surfaces of ONE logged-in account.
//
// It exists to find the exact controls tools/xhs-dm-send must drive: the 私信 control in a user's profile header and
// the conversation's composer. It only reads the DOM and takes screenshots — it never clicks a send control, never
// types, and never opens another person's conversation beyond the profile it was given.
//
// Usage: COOKIES_PATH=<instance dir>/cookies.json xhs-dm-probe -profile <url> [-shot <dir>]
// Build: go build -o <out> ./cmd/xhs-dm-probe (inside the xiaohongshu-mcp source, which provides the browser setup).
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/browser"
	"github.com/xpzouying/xiaohongshu-mcp/configs"
	"github.com/xpzouying/xiaohongshu-mcp/cookies"
)

func main() {
	logrus.SetLevel(logrus.ErrorLevel)
	profile := flag.String("profile", "", "a user profile url to inspect (required)")
	shotDir := flag.String("shot", "", "directory for screenshots (optional)")
	headless := flag.Bool("headless", true, "run headless")
	flag.Parse()
	if *profile == "" {
		fmt.Println("PROBE_FAILED: -profile is required")
		os.Exit(2)
	}

	path := cookies.GetCookiesFilePath()
	store := cookies.NewLoadCookie(path)
	b := browser.NewBrowser(*headless, browser.WithFingerprintSeed(configs.ResolveFingerprintSeed(store)))
	defer b.Close()
	inspect(b, *profile, *shotDir)
}

func inspect(b interface{ NewPage() *rod.Page }, profileURL, shotDir string) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Printf("PROBE_FAILED: %v\n", r)
		}
	}()
	page := b.NewPage()
	defer page.Close()
	page.MustSetViewport(1440, 900, 1, false)
	page.Timeout(60 * time.Second).MustNavigate(profileURL).MustWaitLoad()
	time.Sleep(4 * time.Second)

	// The header holds 关注 and, next to it, the 私信 control. Dump its markup so the sender can target it exactly.
	for _, sel := range []string{".user-info", ".user-interaction", ".info-part", ".basic-info", "#userPageContainer .user"} {
		els, err := page.Elements(sel)
		if err != nil || len(els) == 0 {
			continue
		}
		html, err := els[0].HTML()
		if err != nil {
			continue
		}
		fmt.Printf("[header] %s\n%s\n\n", sel, clip(html, 4000))
		break
	}

	// What the composer offers: every control around the message box, plus any file input the page hides there.
	composer := `() => {
      const out = { controls: [], fileInputs: [], contentEditable: 0 };
      const box = document.querySelector('div[class*=chat] div[contenteditable=true]') || document.querySelector('div[contenteditable=true]');
      out.contentEditable = document.querySelectorAll('[contenteditable=true]').length;
      const near = box ? box.getBoundingClientRect() : null;
      for (const el of document.querySelectorAll('button, svg use, [class*=icon], [class*=btn], label')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (near && (r.top < near.top - 120 || r.top > near.bottom + 120)) continue;
        const cls = (el.getAttribute('class') || '') + ' ' + (el.getAttribute('href') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '');
        const txt = (el.textContent || '').trim().slice(0, 14);
        out.controls.push({ tag: el.tagName.toLowerCase(), cls: cls.trim().slice(0, 90), txt, x: Math.round(r.x), y: Math.round(r.y) });
        if (out.controls.length > 26) break;
      }
      for (const f of document.querySelectorAll('input[type=file]')) {
        out.fileInputs.push({ accept: f.getAttribute('accept') || '', multiple: f.hasAttribute('multiple'), cls: (f.getAttribute('class') || '').slice(0, 60) });
      }
      return JSON.stringify(out);
    }`
	if res, err := page.Eval(composer); err == nil {
		fmt.Printf("[composer] %s\n", clip(res.Value.Str(), 3000))
	}

	// Open the composer's one action button (表情) and see what it offers: read-only, nothing is inserted or sent.
	if btn, err := page.Element("button.xhs-im-input-bar-action-btn"); err == nil && btn != nil {
		if err := btn.Click(proto.InputMouseButtonLeft, 1); err == nil {
			time.Sleep(1500 * time.Millisecond)
			panel := `() => {
              const out = { tabs: [], sampleTitles: [], images: 0, items: 0 };
              for (const el of document.querySelectorAll('[class*=emoji], [class*=sticker], [class*=panel], [class*=popover], [class*=tab]')) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const cls = (el.getAttribute('class') || '').slice(0, 60);
                const txt = (el.textContent || '').trim().slice(0, 12);
                if (txt && out.tabs.length < 12) out.tabs.push({ cls, txt });
              }
              const imgs = document.querySelectorAll('[class*=emoji] img, [class*=sticker] img');
              out.images = imgs.length;
              for (const img of imgs) {
                const t = img.getAttribute('alt') || img.getAttribute('title') || '';
                if (t && out.sampleTitles.length < 8) out.sampleTitles.push(t);
              }
              out.items = document.querySelectorAll('[class*=emoji] li, [class*=emoji] span, [class*=sticker] li').length;
              return JSON.stringify(out);
            }`
			if res, err := page.Eval(panel); err == nil {
				fmt.Printf("[emoji-panel] %s\n", clip(res.Value.Str(), 2000))
			}
			if shotDir != "" {
				_ = os.MkdirAll(shotDir, 0o700)
				page.MustScreenshot(filepath.Join(shotDir, "emoji-panel.png"))
			}
		}
	}

	// Anything that looks like the DM entry point, with enough context to write a selector for it.
	js := `() => {
      const out = [];
      const nodes = document.querySelectorAll('button, div, span, a, svg use');
      for (const el of nodes) {
        const cls = (el.getAttribute('class') || '') + ' ' + (el.getAttribute('href') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '');
        const txt = (el.textContent || '').trim().slice(0, 12);
        if (!/chat|message|私信|msg/i.test(cls) && !/私信/.test(txt)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        out.push({ tag: el.tagName.toLowerCase(), cls: cls.trim().slice(0, 120), txt, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), path: el.closest('.user-info') ? 'in-header' : (el.closest('.side-bar, nav, aside') ? 'in-nav' : 'other') });
        if (out.length > 30) break;
      }
      return JSON.stringify(out);
    }`
	if res, err := page.Eval(js); err == nil {
		fmt.Printf("[candidates] %s\n", clip(res.Value.Str(), 4000))
	}
	if shotDir != "" {
		_ = os.MkdirAll(shotDir, 0o700)
		out := filepath.Join(shotDir, "profile-header.png")
		page.MustScreenshot(out)
		fmt.Printf("[screenshot] %s\n", out)
	}
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
