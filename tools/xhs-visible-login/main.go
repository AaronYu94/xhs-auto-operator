// xhs-visible-login: log a xiaohongshu-mcp instance in through a VISIBLE browser window.
//
// Xiaohongshu rejects QR logins scanned from the instance's headless browser (the phone shows "fail to login" and the
// instance never sees the scan). Upstream's cmd/login opens a visible window but waits on one page element with
// MustElement, which panics ("Session with given id not found") when the page target changes after the scan, before
// the cookies are saved. This helper uses the same browser binary and fingerprint seed as the instance (it is built
// against the local xiaohongshu-mcp source), watches cookies at the browser level, saves them once web_session changes
// and only reports success after a fresh page sees the logged-in session.
//
// Usage: COOKIES_PATH=<instance dir>/cookies.json xhs-visible-login [-timeout 300]
// Output contains exactly one of LOGIN_OK / LOGIN_TIMEOUT / LOGIN_FAILED (src/providers/xhs/visible-login.ts parses it).
// Build: scripts/xhs-mcp-fleet.sh build-login-helper (needs Go and XHS_MCP_SRC = the xiaohongshu-mcp source checkout).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
	"github.com/sirupsen/logrus"
	"github.com/xpzouying/xiaohongshu-mcp/browser"
	"github.com/xpzouying/xiaohongshu-mcp/configs"
	"github.com/xpzouying/xiaohongshu-mcp/cookies"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

const exploreURL = "https://www.xiaohongshu.com/explore"

func webSession(cks []*proto.NetworkCookie) string {
	for _, c := range cks {
		if c.Name == "web_session" {
			return c.Value
		}
	}
	return ""
}

// loggedIn checks the session on a fresh page; upstream's check uses Must* calls, so panics count as "not logged in".
func loggedIn(b interface{ NewPage() *rod.Page }) (ok bool, err error) {
	defer func() {
		if r := recover(); r != nil {
			ok, err = false, fmt.Errorf("login check failed: %v", r)
		}
	}()
	page := b.NewPage()
	defer page.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	return xiaohongshu.NewLogin(page).CheckLoginStatus(ctx)
}

func run(timeout time.Duration) (code int) {
	path := cookies.GetCookiesFilePath()
	store := cookies.NewLoadCookie(path)
	b := browser.NewBrowser(false, browser.WithFingerprintSeed(configs.ResolveFingerprintSeed(store)))
	defer b.Close()
	defer func() {
		if r := recover(); r != nil {
			logrus.Errorf("LOGIN_FAILED: %v", r)
			code = 1
		}
	}()

	if ok, _ := loggedIn(b); ok {
		logrus.Info("LOGIN_OK: already logged in")
		return 0
	}

	page := b.NewPage()
	rb := page.Browser()
	if err := page.Navigate(exploreURL); err != nil {
		logrus.Errorf("LOGIN_FAILED: could not open %s: %v", exploreURL, err)
		return 1
	}
	time.Sleep(4 * time.Second)
	initial, err := rb.GetCookies()
	if err != nil {
		logrus.Errorf("LOGIN_FAILED: could not read browser cookies: %v", err)
		return 1
	}
	seen := webSession(initial)
	logrus.Infof("login window open; scan the QR code with the Xiaohongshu app (cookies: %s)", path)

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		time.Sleep(2 * time.Second)
		cks, err := rb.GetCookies()
		if err != nil {
			continue // the window may be between pages
		}
		cur := webSession(cks)
		if cur == "" || cur == seen {
			continue
		}
		seen = cur
		time.Sleep(4 * time.Second) // let the post-login redirects settle
		if latest, err := rb.GetCookies(); err == nil {
			cks = latest
		}
		data, err := json.Marshal(cks)
		if err != nil {
			logrus.Errorf("LOGIN_FAILED: encode cookies: %v", err)
			return 1
		}
		if err := store.SaveCookies(data); err != nil {
			logrus.Errorf("LOGIN_FAILED: save cookies to %s: %v", path, err)
			return 1
		}
		_ = os.Chmod(path, 0o600) // the file is a live session
		if ok, err := loggedIn(b); ok {
			logrus.Infof("LOGIN_OK: logged in; %d cookies saved to %s", len(cks), path)
			return 0
		} else {
			logrus.Warnf("session cookie changed but the login is not confirmed yet (%v); still waiting", err)
		}
	}
	logrus.Errorf("LOGIN_TIMEOUT: no confirmed login within %s", timeout)
	return 2
}

func main() {
	timeoutSec := flag.Int("timeout", 300, "seconds to wait for the QR scan")
	flag.Parse()
	os.Exit(run(time.Duration(*timeoutSec) * time.Second))
}
