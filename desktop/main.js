'use strict';
/**
 * AI汽车运营官 desktop app (macOS + Windows): a window onto the console that runs on the cloud server.
 *
 * Nothing runs locally and no data is stored besides the session cookie. The server is reached over HTTPS on its IP
 * address with a self-signed certificate, so the app accepts that host ONLY when the certificate's SHA-256
 * fingerprint is one of those pinned in server.json (written by deploy/server/tls.sh output). Every other host goes
 * through Chromium's normal certificate verification, and non-server links open in the system browser.
 */
const { app, BrowserWindow, Menu, dialog, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = 'AI汽车运营官';
const FINGERPRINT_RE = /^sha256\/[A-Za-z0-9+/]{43}=$/;

function loadServerConfig() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'server.json'), 'utf8'));
  const url = new URL(raw.url);
  if (url.protocol !== 'https:') throw new Error('server.json: url 必须是 https 地址');
  const fingerprints = Array.isArray(raw.fingerprints) ? raw.fingerprints.filter((f) => FINGERPRINT_RE.test(f)) : [];
  if (fingerprints.length === 0) throw new Error('server.json: 至少需要一个 sha256/… 证书指纹');
  return { url: `${url.origin}/`, origin: url.origin, hostname: url.hostname, fingerprints };
}

let server;
let pinMismatchAt = 0;
try {
  server = loadServerConfig();
} catch (err) {
  app.whenReady().then(() => {
    dialog.showErrorBox(APP_NAME, `服务器配置无效：${err.message}`);
    app.quit();
  });
}

const isServerUrl = (url) => {
  try {
    return new URL(url).origin === server.origin;
  } catch {
    return false;
  }
};

const openOutside = (url) => {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:' || protocol === 'http:') shell.openExternal(url);
  } catch {
    // ignore malformed URLs
  }
};

const offlinePage = (reason) => ({
  file: path.join(__dirname, 'offline.html'),
  query: { url: server.url, reason: String(reason ?? '') },
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: '#f6f7f9',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());

  const { webContents } = win;
  webContents.setWindowOpenHandler(({ url }) => {
    if (isServerUrl(url)) win.loadURL(url);
    else openOutside(url);
    return { action: 'deny' };
  });
  const guard = (event, url) => {
    if (isServerUrl(url) || url.startsWith('file:')) return;
    event.preventDefault();
    openOutside(url);
  };
  webContents.on('will-navigate', guard);
  webContents.on('will-redirect', guard);
  webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 = navigation aborted (e.g. replaced by another navigation); not an outage
    if (!isMainFrame || code === -3 || !isServerUrl(url)) return;
    const pinMismatch = Date.now() - pinMismatchAt < 5000;
    const page = offlinePage(pinMismatch ? '服务器证书与内置指纹不一致，已拒绝连接' : `${description} (${code})`);
    win.loadFile(page.file, { query: page.query });
  });

  win.loadURL(server.url);
  return win;
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu', label: APP_NAME }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '回到首页', accelerator: 'CmdOrCtrl+Shift+H', click: (_item, win) => win?.loadURL(server.url) },
        { role: 'reload', label: '刷新' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
      ],
    },
    { role: 'windowMenu', label: '窗口' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (server) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      const [win] = BrowserWindow.getAllWindows();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });

    app.whenReady().then(() => {
      const ses = session.defaultSession;
      ses.setCertificateVerifyProc((request, callback) => {
        if (request.hostname === server.hostname) {
          const pinned = server.fingerprints.includes(request.certificate.fingerprint);
          if (!pinned) pinMismatchAt = Date.now();
          callback(pinned ? 0 : -2);
        } else {
          callback(-3); // use Chromium's own verification
        }
      });
      // the console only needs to write to the clipboard (copying approved outreach text)
      ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
      ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
      ses.setUserAgent(`${ses.getUserAgent()} AIAutoOperatorDesktop/${app.getVersion()}`);

      buildMenu();
      createWindow();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    });

    app.on('web-contents-created', (_event, contents) => {
      contents.on('will-attach-webview', (event) => event.preventDefault());
    });
    app.on('window-all-closed', () => app.quit());
  }
}
