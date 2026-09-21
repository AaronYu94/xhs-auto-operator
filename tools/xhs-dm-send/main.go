// xhs-dm-send: send ONE reviewed direct message from ONE managed account's own logged-in session.
//
// Xiaohongshu has no authorized DM API for a 专业号 (the official IM API is open only to approved third-party 客服
// 服务商), so the only way the operator's console can deliver a reviewed message is the same technique the rest of
// this system already uses for publishing notes and replying to comments: drive the account's own logged-in browser
// session. This tool does exactly one send, for one recipient, with text the console already reviewed.
//
// Guarantees this tool keeps (the console depends on them):
//   - -dry-run stops before the send button and only reports what it found: the surfaces, the input box and the
//     send control. Nothing reaches the recipient.
//   - A send is reported OK only after the message is read back in the conversation thread (SEND_OK <id>).
//     When the outcome cannot be established it reports SEND_UNKNOWN and the caller must NOT retry — a retry could
//     double-message a real person.
//   - It never opens, reads or exports other conversations, and never writes anything but the given text.
//
// Usage: COOKIES_PATH=<instance dir>/cookies.json DM_TEXT=<message> xhs-dm-send -profile <url> [-dry-run] [-shot dir]
// Output contains exactly one of SEND_OK / SEND_FAILED / SEND_UNKNOWN / DRYRUN_OK / DRYRUN_FAILED.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/input"
	"github.com/go-rod/rod/lib/proto"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/browser"
	"github.com/xpzouying/xiaohongshu-mcp/configs"
	"github.com/xpzouying/xiaohongshu-mcp/cookies"
	"github.com/xpzouying/xiaohongshu-mcp/humanize"
)

// Candidate selectors, tried in order. Xiaohongshu's web app changes class names, so every step keeps fallbacks and
// reports which one matched; the console logs that so a broken selector is visible instead of silently "sent".
var (
	// The 私信 control in the profile header, as Xiaohongshu's web app renders it today:
	//   <div class="info-right-area"> <button class="follow-button">关注</button> <button class="xhs-user-im-btn" title="发消息"> …
	// Deliberately narrow: a loose [class*=chat] also matches the sidebar's AI chat, which is not a conversation with
	// this person. If none of these match, the tool stops instead of clicking something else.
	chatButtonSelectors = []string{
		"button.xhs-user-im-btn",
		`button[title="发消息"]`,
		".info-right-area button.xhs-user-im-btn",
	}
	inputSelectors = []string{
		"div.chat-input div[contenteditable=true]",
		"div[class*=chat] div[contenteditable=true]",
		"div[class*=input] div[contenteditable=true]",
		"div[contenteditable=true]",
		"textarea",
	}
	// A message element carries an id of its own; a page container ("global", "app") identifies nothing and is ignored.
	messageIDRe = regexp.MustCompile(`(?i)msg|message|chat|bubble|item|\d{6,}`)
	sendButtonSelectors = []string{
		"div.chat-input button",
		"button[class*=send]",
		"div[class*=send-btn]",
		"span[class*=send]",
	}
)

func main() {
	logrus.SetLevel(logrus.ErrorLevel)
	profile := flag.String("profile", "", "recipient profile url (required)")
	dryRun := flag.Bool("dry-run", false, "stop before sending and report the surfaces found")
	headless := flag.Bool("headless", true, "run headless")
	shotDir := flag.String("shot", "", "directory for screenshots (optional)")
	timeout := flag.Duration("timeout", 90*time.Second, "overall deadline")
	flag.Parse()

	// The message body comes through the environment, never argv: a DM belongs in this process, not in `ps` output.
	text := os.Getenv("DM_TEXT")
	if *profile == "" || (text == "" && !*dryRun) {
		fmt.Println("SEND_FAILED: -profile and DM_TEXT are required")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	path := cookies.GetCookiesFilePath()
	store := cookies.NewLoadCookie(path)
	b := browser.NewBrowser(*headless, browser.WithFingerprintSeed(configs.ResolveFingerprintSeed(store)))
	defer b.Close()

	code := run(ctx, b, *profile, text, *dryRun, *shotDir)
	os.Exit(code)
}

func run(ctx context.Context, b interface{ NewPage() *rod.Page }, profileURL, text string, dryRun bool, shotDir string) (code int) {
	defer func() {
		if r := recover(); r != nil {
			// A panic after the send button was clicked leaves the outcome unknown: say so, never guess.
			fmt.Printf("SEND_UNKNOWN: crashed while sending: %v\n", r)
			code = 3
		}
	}()
	page := b.NewPage()
	defer page.Close()
	page.MustSetViewport(1440, 900, 1, false)

	shot := func(name string) {
		if shotDir == "" {
			return
		}
		_ = os.MkdirAll(shotDir, 0o700)
		page.MustScreenshot(filepath.Join(shotDir, name+".png"))
	}

	// The conversation with one person has a stable address (the 发消息 button opens exactly this), so go there
	// directly; the profile route below is the fallback for when that page does not come up with a composer.
	if uid := userIDOf(profileURL); uid != "" {
		page.Timeout(60 * time.Second).MustNavigate(chatURL(uid)).MustWaitLoad()
		humanize.Delay(ctx, humanize.AfterNavigate)
		time.Sleep(2 * time.Second)
		shot("1-chat")
	}
	box, inputSel := pick(page, inputSelectors, true)
	if box == nil {
		page.Timeout(60 * time.Second).MustNavigate(profileURL).MustWaitLoad()
		humanize.Delay(ctx, humanize.AfterNavigate)
		shot("1-profile")

		before := openTabs(page)
		chat, chatSel := pick(page, chatButtonSelectors, false)
		if chat == nil {
			fmt.Println(fail(dryRun), "no 私信 control on the profile (selectors:", strings.Join(chatButtonSelectors, " | "), ")")
			return 1
		}
		fmt.Printf("chat_button=%q\n", chatSel)
		if err := humanize.Click(chat); err != nil {
			fmt.Println(fail(dryRun), "could not open the conversation:", err)
			return 1
		}
		humanize.Delay(ctx, humanize.AfterClick)
		// 发消息 opens the conversation in a new tab; when it does, that tab is the one to work in.
		if opened := waitForChatTab(page, before, 10*time.Second); opened != nil {
			page = opened
			defer page.Close()
			page.MustSetViewport(1440, 900, 1, false)
		}
		time.Sleep(2 * time.Second)
		box, inputSel = pick(page, inputSelectors, true)
	}
	fmt.Printf("chat_url=%s\n", page.MustInfo().URL)
	shot("2-chat")
	if box == nil {
		fmt.Println(fail(dryRun), "no message box in the conversation (selectors:", strings.Join(inputSelectors, " | "), ")")
		return 1
	}
	fmt.Printf("input=%q\n", inputSel)
	send, sendSel := pick(page, sendButtonSelectors, true)
	fmt.Printf("send_button=%q\n", sendSel)

	// The conversation header carries the recipient's public avatar and nickname; the console shows a real face
	// instead of an initial once it has them. Read-only, and only for the person this conversation is with.
	reportPeer(page)

	if dryRun {
		fmt.Println("DRYRUN_OK: conversation reachable; nothing was typed or sent")
		return 0
	}

	if err := humanize.Click(box); err != nil {
		fmt.Println("SEND_FAILED: could not focus the message box:", err)
		return 1
	}
	humanize.Delay(ctx, humanize.AfterClick)
	if err := humanize.Type(ctx, box, text); err != nil {
		fmt.Println("SEND_FAILED: could not type the message:", err)
		return 1
	}
	humanize.Delay(ctx, humanize.AfterType)
	shot("3-typed")

	// From here the message may reach the recipient: every failure is UNKNOWN, never a retryable failure.
	if send != nil {
		if err := humanize.Click(send); err != nil {
			fmt.Println("SEND_UNKNOWN: send button click failed after typing:", err)
			return 3
		}
	} else if err := box.Type(input.Enter); err != nil {
		fmt.Println("SEND_UNKNOWN: Enter failed after typing:", err)
		return 3
	}
	humanize.Delay(ctx, humanize.AfterClick)
	time.Sleep(2 * time.Second)
	shot("4-sent")

	if id, ok := confirmSent(page, text, userIDOf(profileURL), 12*time.Second); ok {
		fmt.Printf("SEND_OK: %s\n", id)
		return 0
	}
	fmt.Println("SEND_UNKNOWN: the message was submitted but could not be read back in the conversation; do not retry")
	return 3
}

// reportPeer prints the recipient's avatar url as the conversation header shows it (peer_avatar). Only the avatar:
// the nickname in that header is laid out next to timestamps, and a wrong name is worse than none.
func reportPeer(page *rod.Page) {
	res, err := page.Eval(`() => {
      for (const img of document.querySelectorAll('img')) {
        const src = img.getAttribute('src') || '';
        if (!/\/avatar\//i.test(src)) continue;
        const r = img.getBoundingClientRect();
        // the header avatar sits at the top of the conversation pane, right of the conversation list
        if (r.top > 150 || r.left < 400 || r.width < 20) continue;
        return src;
      }
      return '';
    }`)
	if err != nil {
		return
	}
	if url := strings.TrimSpace(res.Value.Str()); url != "" {
		fmt.Printf("peer_avatar=%s\n", url)
	}
}

func fail(dryRun bool) string {
	if dryRun {
		return "DRYRUN_FAILED:"
	}
	return "SEND_FAILED:"
}

/** the conversation with one person: what the profile's 发消息 button opens */
func chatURL(userID string) string {
	return "https://www.xiaohongshu.com/chat?openUid=" + userID
}

// userIDOf reads the Xiaohongshu user id out of a profile url (…/user/profile/<id>[?…]).
func userIDOf(profileURL string) string {
	path := profileURL
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	path = strings.TrimRight(path, "/")
	i := strings.LastIndex(path, "/")
	if i < 0 {
		return ""
	}
	id := path[i+1:]
	for _, r := range id {
		if !(r >= '0' && r <= '9') && !(r >= 'a' && r <= 'f') && !(r >= 'A' && r <= 'F') {
			return ""
		}
	}
	return id
}

// openTabs records the browser's current tabs, so a conversation opened in a new one can be found afterwards.
func openTabs(page *rod.Page) map[proto.TargetTargetID]bool {
	out := map[proto.TargetTargetID]bool{}
	pages, err := page.Browser().Pages()
	if err != nil {
		return out
	}
	for _, p := range pages {
		out[p.TargetID] = true
	}
	return out
}

// waitForChatTab returns the conversation tab 发消息 opened, or nil when the conversation stayed in this tab.
func waitForChatTab(page *rod.Page, before map[proto.TargetTargetID]bool, within time.Duration) *rod.Page {
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if pages, err := page.Browser().Pages(); err == nil {
			for _, p := range pages {
				if before[p.TargetID] {
					continue
				}
				info, err := p.Info()
				if err != nil {
					continue
				}
				if strings.Contains(info.URL, "/chat") || strings.Contains(info.URL, "/im") {
					return p
				}
			}
		}
		time.Sleep(400 * time.Millisecond)
	}
	return nil
}

// pick returns the first matching selector's element: the first match for controls that must be unambiguous (the 私信
// button), the last for the composer, which sits at the end of the conversation.
func pick(page *rod.Page, selectors []string, last bool) (*rod.Element, string) {
	for _, sel := range selectors {
		els, err := page.Elements(sel)
		if err != nil || len(els) == 0 {
			continue
		}
		if last {
			return els[len(els)-1], sel
		}
		return els[0], sel
	}
	return nil, ""
}

// confirmSent reads the conversation back. A message counts as delivered only when the text is rendered in the thread
// (outside the composer) and the composer went empty — class names change, this check does not depend on them.
func confirmSent(page *rod.Page, text, recipient string, within time.Duration) (string, bool) {
	needle := strings.Join(strings.Fields(text), " ")
	js := `(needle) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const box = document.querySelector('div[contenteditable=true]');
      const composerEmpty = !box || norm(box.innerText) === '';
      let hit = null;
      const nodes = document.querySelectorAll('div, span, p');
      for (let i = nodes.length - 1; i >= 0; i--) {
        const el = nodes[i];
        if (el.children.length > 0) continue;
        if (el.closest('[contenteditable=true]')) continue;
        if (norm(el.innerText) !== needle) continue;
        hit = el;
        break;
      }
      const holder = hit ? (hit.closest('[id]') || hit) : null;
      return JSON.stringify({
        composerEmpty,
        found: !!hit,
        id: holder && holder.id ? holder.id : '',
        cls: hit ? (hit.getAttribute('class') || (hit.parentElement && hit.parentElement.getAttribute('class')) || '') : '',
      });
    }`
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if res, err := page.Eval(js, needle); err == nil {
			var out struct {
				ComposerEmpty bool   `json:"composerEmpty"`
				Found         bool   `json:"found"`
				ID            string `json:"id"`
				Cls           string `json:"cls"`
			}
			if err := json.Unmarshal([]byte(res.Value.Str()), &out); err == nil && out.Found && out.ComposerEmpty {
				// Only a message-specific id is worth carrying; a page container id (e.g. "global") identifies nothing.
				if out.ID != "" && messageIDRe.MatchString(out.ID) {
					return out.ID, true
				}
				return fmt.Sprintf("%s@%d", recipient, time.Now().UnixMilli()), true
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return "", false
}
