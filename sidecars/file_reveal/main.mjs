import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const INSTANCE_TS = Date.now();
const MAX_HISTORY = 10;
const POLL_MS = 1500;
const RELOAD_MS = 1500;

const PORT_FILE =
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Antigravity', 'DevToolsActivePort');

const recentHistory = [];

function recordHistory(entry) {
  recentHistory.unshift({ ...entry, ts: entry.ts || Date.now() });
  if (recentHistory.length > MAX_HISTORY) {
    recentHistory.length = MAX_HISTORY;
  }
}

/**
 * Resolve a `file:` URI (with optional `#L...` / `?` suffix or `%3A` drive encoding)
 * into a normalized local filesystem path.
 */
export function resolveFileUri(rawUri) {
  const trimmed = String(rawUri || '').trim();
  if (!/^file:/i.test(trimmed)) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol.toLowerCase() !== 'file:') return null;
    url.hash = '';
    url.search = '';
    if (process.platform === 'win32') {
      url.pathname = url.pathname.replace(/^\/([a-zA-Z])%3[Aa](?=\/|$)/, '/$1:');
    }
    return path.resolve(fileURLToPath(url));
  } catch {
    try {
      let raw = trimmed.replace(/^file:\/\//i, '').split(/[?#]/)[0];
      if (!raw) return null;
      try {
        raw = decodeURIComponent(raw);
      } catch {
        // Keep partially unescaped path if malformed percent sequences exist.
      }
      if (process.platform === 'win32') {
        if (/^\/[a-zA-Z]:/.test(raw)) {
          raw = raw.slice(1);
        } else if (!/^[a-zA-Z]:/.test(raw) && !raw.startsWith('//')) {
          return null;
        }
      }
      return path.resolve(raw);
    } catch {
      return null;
    }
  }
}

function spawnDetached(exe, args) {
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    ...(process.platform === 'win32' ? { windowsVerbatimArguments: true } : {}),
  });
  child.on('error', (err) => {
    console.error('[agy-file-reveal] spawn error:', err?.message || err);
  });
  child.unref();
}

function openDirectoryInOs(dirPath) {
  if (process.platform === 'win32') {
    const safe = dirPath.replace(/"/g, '');
    spawnDetached('explorer.exe', [`"${safe}"`]);
  } else if (process.platform === 'darwin') {
    spawnDetached('open', [dirPath]);
  } else {
    spawnDetached('xdg-open', [dirPath]);
  }
}

function selectFileInOs(filePath) {
  if (process.platform === 'win32') {
    const safe = filePath.replace(/"/g, '');
    spawnDetached('explorer.exe', [`/select,"${safe}"`]);
  } else if (process.platform === 'darwin') {
    spawnDetached('open', ['-R', filePath]);
  } else {
    spawnDetached('xdg-open', [path.dirname(filePath)]);
  }
}

function findExistingAncestorDir(targetPath) {
  let current = path.dirname(targetPath);
  while (current) {
    try {
      if (fs.existsSync(current) && fs.statSync(current).isDirectory()) {
        return current;
      }
    } catch {
      // Continue climbing on permission or transient stat error.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Reveal a `file:` target in the OS file manager, falling back to an existing
 * parent directory if the original file no longer exists.
 */
export function revealInExplorer(rawUri) {
  const target = resolveFileUri(rawUri);
  if (!target) {
    const res = { ok: false, message: '无法解析文件路径' };
    recordHistory({ action: 'reveal', uri: rawUri, status: 'error', message: res.message });
    return res;
  }

  try {
    if (fs.existsSync(target)) {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        openDirectoryInOs(target);
        recordHistory({ action: 'reveal', path: target, kind: 'dir', status: 'ok' });
        return { ok: true, kind: 'dir', path: target };
      }
      selectFileInOs(target);
      recordHistory({ action: 'reveal', path: target, kind: 'file', status: 'ok' });
      return { ok: true, kind: 'file', path: target };
    }
  } catch (err) {
    const res = { ok: false, path: target, message: `打开文件位置失败: ${err?.message || err}` };
    recordHistory({ action: 'reveal', path: target, status: 'error', message: res.message });
    return res;
  }

  const parentDir = findExistingAncestorDir(target);
  if (parentDir) {
    openDirectoryInOs(parentDir);
    const message = '原文件已不存在，已打开所在目录';
    recordHistory({ action: 'reveal', path: target, fallback: parentDir, status: 'fallback', message });
    return { ok: true, fallback: 'parent', path: parentDir, originalPath: target, message };
  }

  const message = '文件及上级目录均不存在';
  recordHistory({ action: 'reveal', path: target, status: 'error', message });
  return { ok: false, path: target, message };
}

function installEpipeGuard(proc = process) {
  const isEpipe = (err) => err?.code === 'EPIPE';
  for (const stream of [proc.stdout, proc.stderr]) {
    stream?.on?.('error', (err) => {
      if (!isEpipe(err)) throw err;
    });
  }
  const onFatal = (err) => {
    if (isEpipe(err)) return;
    try {
      console.error('[agy-file-reveal] fatal:', err);
    } catch {}
    proc.exit(1);
  };
  proc.on('uncaughtException', onFatal);
  proc.on('unhandledRejection', onFatal);
}

function installPageRuntime(owner, hash) {
  const previous = globalThis.__agyFileRevealRuntime;
  if (previous?.owner > owner) return 'superseded';
  previous?.dispose?.();

  const HOST_ID = 'agy-file-reveal-host';
  const TARGET_SELECTOR =
    '.inline-pill[data-uri], [data-uri^="file:"], [data-uri^="FILE:"], a[href^="file:"], a[href^="FILE:"]';

  let disposed = false;
  let host = null;
  let shadow = null;
  let menuEl = null;
  let toastEl = null;
  let toastTimer = 0;

  function isDarkTheme() {
    const root = document.documentElement;
    if (root.classList.contains('dark')) return true;
    const attrTheme = root.getAttribute('data-theme') || root.getAttribute('data-newux-theme') || '';
    if (/dark|onyx|warm/i.test(attrTheme)) return true;
    if (/light/i.test(attrTheme)) return false;
    const bg = getComputedStyle(document.body || root).backgroundColor || '';
    const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!m) return true;
    const lum = (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000;
    return lum < 128;
  }

  function decodeDisplayPath(rawUri) {
    try {
      const url = new URL(rawUri);
      url.hash = '';
      url.search = '';
      let p = url.pathname || '';
      try {
        p = decodeURIComponent(p);
      } catch {}
      if (url.host && url.host !== 'localhost') {
        p = '//' + url.host + p;
      } else if (/^\/[a-zA-Z]:\//.test(p)) {
        p = p.slice(1);
      }
      if (/^win/i.test(navigator.platform || '') || /windows/i.test(navigator.userAgent || '')) {
        if (/^[a-zA-Z]:\//.test(p) || p.startsWith('//')) {
          p = p.replace(/\//g, '\\');
        }
      }
      return p || rawUri;
    } catch {
      const bare = String(rawUri || '').replace(/^file:\/\//i, '').split(/[?#]/)[0];
      try {
        return decodeURIComponent(bare);
      } catch {
        return bare;
      }
    }
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function ensureHost() {
    if (host && document.body?.contains(host)) return;
    document.getElementById(HOST_ID)?.remove();
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .fr-menu {
          position: fixed;
          min-width: 196px;
          max-width: 280px;
          padding: 5px;
          border-radius: 10px;
          pointer-events: auto;
          display: none;
          flex-direction: column;
          gap: 2px;
          font-family: "Sarasa UI SC", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", sans-serif;
          font-size: 13px;
          line-height: 1.35;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.14);
          backdrop-filter: blur(12px);
          user-select: none;
          animation: fr-pop 90ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .fr-menu[data-open="true"] { display: flex; }
        .fr-menu[data-theme="dark"] {
          background: var(--popover, #1e1f23);
          color: var(--popover-foreground, #eceef2);
          border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
        }
        .fr-menu[data-theme="light"] {
          background: var(--popover, #ffffff);
          color: var(--popover-foreground, #1f2328);
          border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
        }
        .fr-item {
          display: flex;
          align-items: center;
          gap: 9px;
          width: 100%;
          padding: 7px 10px;
          margin: 0;
          border: none;
          border-radius: 7px;
          background: transparent;
          color: inherit;
          font: inherit;
          text-align: left;
          cursor: pointer;
          outline: none;
          transition: background-color 80ms ease;
        }
        .fr-menu[data-theme="dark"] .fr-item:hover,
        .fr-menu[data-theme="dark"] .fr-item:focus-visible {
          background: var(--accent, rgba(255, 255, 255, 0.09));
          color: var(--accent-foreground, #ffffff);
        }
        .fr-menu[data-theme="light"] .fr-item:hover,
        .fr-menu[data-theme="light"] .fr-item:focus-visible {
          background: var(--accent, rgba(0, 0, 0, 0.06));
          color: var(--accent-foreground, #111827);
        }
        .fr-item svg {
          width: 15px;
          height: 15px;
          flex-shrink: 0;
          opacity: 0.82;
        }
        .fr-sep {
          height: 1px;
          margin: 3px 6px;
        }
        .fr-menu[data-theme="dark"] .fr-sep {
          background: var(--border, rgba(255, 255, 255, 0.09));
        }
        .fr-menu[data-theme="light"] .fr-sep {
          background: var(--border, rgba(0, 0, 0, 0.08));
        }
        .fr-path-hint {
          padding: 4px 10px 3px;
          font-size: 11px;
          opacity: 0.6;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          direction: rtl;
          text-align: left;
        }
        .fr-toast {
          position: fixed;
          left: 50%;
          bottom: 24px;
          transform: translateX(-50%) translateY(8px);
          padding: 7px 14px;
          border-radius: 999px;
          font-family: "Sarasa UI SC", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", sans-serif;
          font-size: 12.5px;
          line-height: 1.3;
          opacity: 0;
          pointer-events: none;
          transition: opacity 140ms ease, transform 140ms ease;
          box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
        }
        .fr-toast[data-visible="true"] {
          opacity: 1;
          transform: translateX(-50%) translateY(0);
        }
        .fr-toast[data-theme="dark"] {
          background: #272930;
          color: #f3f4f6;
          border: 1px solid rgba(255, 255, 255, 0.14);
        }
        .fr-toast[data-theme="light"] {
          background: #1f2328;
          color: #ffffff;
          border: 1px solid rgba(0, 0, 0, 0.1);
        }
        .fr-toast[data-error="true"] {
          background: #991b1b;
          color: #fef2f2;
          border-color: rgba(254, 202, 202, 0.3);
        }
        @keyframes fr-pop {
          from { opacity: 0; transform: scale(0.96); }
          to { opacity: 1; transform: scale(1); }
        }
      </style>
      <div class="fr-menu" role="menu" data-open="false" data-theme="dark"></div>
      <div class="fr-toast" data-visible="false" data-theme="dark"></div>
    `;
    menuEl = shadow.querySelector('.fr-menu');
    toastEl = shadow.querySelector('.fr-toast');
    (document.body || document.documentElement).appendChild(host);
  }

  function showToast(message, isError = false) {
    if (disposed || !message) return;
    ensureHost();
    toastEl.dataset.theme = isDarkTheme() ? 'dark' : 'light';
    toastEl.dataset.error = isError ? 'true' : 'false';
    toastEl.textContent = message;
    toastEl.dataset.visible = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.dataset.visible = 'false';
    }, 2200);
  }

  function closeMenu() {
    if (menuEl) menuEl.dataset.open = 'false';
  }

  function sendBridge(payload) {
    try {
      if (typeof window.__agyFileRevealAction === 'function') {
        window.__agyFileRevealAction(JSON.stringify(payload));
        return true;
      }
    } catch {}
    return false;
  }

  function openMenu(clientX, clientY, rawUri, copyFallbackText) {
    ensureHost();
    const displayPath = decodeDisplayPath(rawUri);
    const theme = isDarkTheme() ? 'dark' : 'light';
    menuEl.dataset.theme = theme;
    menuEl.innerHTML = '';

    const items = [
      {
        id: 'reveal',
        label: '打开文件位置',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6"/><path d="M9 14l3-3 3 3"/></svg>',
        onClick: () => {
          closeMenu();
          if (!sendBridge({ action: 'reveal', uri: rawUri })) {
            showToast('插件连接暂未就绪，请稍后再试', true);
          }
        },
      },
      {
        id: 'copy-path',
        label: '复制完整路径',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
        onClick: async () => {
          closeMenu();
          const ok = await copyText(displayPath);
          if (ok) {
            sendBridge({ action: 'copied', path: displayPath });
            showToast('已复制完整路径');
          } else {
            showToast('复制失败', true);
          }
        },
      },
      { sep: true },
      {
        id: 'copy',
        label: '复制',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
        onClick: async () => {
          closeMenu();
          const ok = await copyText(copyFallbackText || displayPath);
          showToast(ok ? '已复制' : '复制失败', !ok);
        },
      },
    ];

    for (const item of items) {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'fr-sep';
        menuEl.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fr-item';
      btn.setAttribute('role', 'menuitem');
      btn.innerHTML = `${item.icon}<span>${item.label}</span>`;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        item.onClick();
      });
      menuEl.appendChild(btn);
    }

    const hint = document.createElement('div');
    hint.className = 'fr-path-hint';
    hint.title = displayPath;
    hint.textContent = displayPath;
    menuEl.appendChild(hint);

    menuEl.style.left = '-9999px';
    menuEl.style.top = '-9999px';
    menuEl.dataset.open = 'true';
    const rect = menuEl.getBoundingClientRect();
    const x = Math.min(Math.max(8, clientX), Math.max(8, window.innerWidth - rect.width - 8));
    const y = Math.min(Math.max(8, clientY), Math.max(8, window.innerHeight - rect.height - 8));
    menuEl.style.left = `${x}px`;
    menuEl.style.top = `${y}px`;
  }

  const onContextMenu = (e) => {
    if (disposed) return;
    const target = e.target instanceof Element ? e.target : e.target?.parentElement;
    const pill = target?.closest?.(TARGET_SELECTOR);
    if (!pill) {
      closeMenu();
      return;
    }
    const rawUri = pill.getAttribute('data-uri') || pill.getAttribute('href') || '';
    if (!/^file:/i.test(rawUri)) {
      closeMenu();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const selected = window.getSelection?.()?.toString()?.trim();
    const labelText = (pill.textContent || '').trim();
    openMenu(e.clientX, e.clientY, rawUri, selected || labelText);
  };

  const onPointerDown = (e) => {
    if (!menuEl || menuEl.dataset.open !== 'true') return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.includes(menuEl)) return;
    closeMenu();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') closeMenu();
  };

  const onDismiss = () => closeMenu();

  window.addEventListener('contextmenu', onContextMenu, true);
  window.addEventListener('mousedown', onPointerDown, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onDismiss, true);
  window.addEventListener('resize', onDismiss);
  window.addEventListener('blur', onDismiss);

  const api = {
    owner,
    hash,
    readState(caller) {
      if (caller < owner) return 'superseded';
      return { ok: !disposed, owner, hash, path: location.pathname };
    },
    toast(message, isError = false) {
      showToast(message, isError);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(toastTimer);
      window.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('blur', onDismiss);
      document.getElementById(HOST_ID)?.remove();
      if (globalThis.__agyFileRevealRuntime === api) {
        delete globalThis.__agyFileRevealRuntime;
      }
    },
  };

  globalThis.__agyFileRevealRuntime = api;
  return true;
}

function buildRuntimeBundle(owner = INSTANCE_TS) {
  const source = installPageRuntime.toString();
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const code = `(()=>{const INSTANCE_TS=${Number(owner)};if(globalThis.__agyFileRevealRuntime?.owner>INSTANCE_TS)return 'superseded';${source}\nreturn installPageRuntime(INSTANCE_TS,${JSON.stringify(hash)});})()`;
  return { code, hash };
}

function startInjector(options = {}) {
  const owner = options.instanceTs ?? INSTANCE_TS;
  const bundle = buildRuntimeBundle(owner);
  const sockets = new Map();
  let cdpState = 'unknown';
  let lastErr = '';
  let stopped = false;
  let busy = false;

  const logOnce = (msg) => {
    if (lastErr !== msg) {
      lastErr = msg;
      console.error('[agy-file-reveal]', msg);
    }
  };

  const retire = (entry, id) => {
    if (entry.closed) return;
    entry.closed = true;
    for (const cb of entry.pending.values()) cb(undefined);
    entry.pending.clear();
    try {
      entry.ws.close();
    } catch {}
    if (sockets.get(id) === entry) sockets.delete(id);
  };

  const sendCdp = (entry, method, params = {}) =>
    new Promise((resolve) => {
      if (entry.ws.readyState !== 1) return resolve(undefined);
      const id = entry.nextId++;
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        resolve(undefined);
      }, 3000);
      entry.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      try {
        entry.ws.send(JSON.stringify({ id, method, params }));
      } catch {
        clearTimeout(timer);
        entry.pending.delete(id);
        resolve(undefined);
      }
    });

  const evaluate = async (entry, expression) => {
    const msg = await sendCdp(entry, 'Runtime.evaluate', { expression, returnByValue: true });
    return msg?.result?.result?.value;
  };

  const handleBindingCall = async (entry, params) => {
    if (params?.name !== '__agyFileRevealAction') return;
    let payload;
    try {
      payload = JSON.parse(params.payload || '{}');
    } catch {
      return;
    }
    if (payload.action === 'reveal' && payload.uri) {
      const res = revealInExplorer(payload.uri);
      if (!res.ok || res.fallback) {
        await evaluate(
          entry,
          `globalThis.__agyFileRevealRuntime?.toast(${JSON.stringify(res.message || '')}, ${!res.ok})`,
        );
      }
    } else if (payload.action === 'copied' && payload.path) {
      recordHistory({ action: 'copy-path', path: payload.path, status: 'ok' });
    }
  };

  const connect = async (target) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const entry = { ws, pending: new Map(), nextId: 1, title: target.title || '', url: target.url || '' };
    await new Promise((resolve, reject) => {
      const fail = (msg) => {
        clearTimeout(timer);
        retire(entry, target.id);
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail('ws timeout'), 3000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => fail('ws error');
    });
    if (stopped) {
      retire(entry, target.id);
      throw new Error('stopped');
    }
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id) {
          const cb = entry.pending.get(msg.id);
          if (cb) {
            entry.pending.delete(msg.id);
            cb(msg);
          }
        } else if (msg.method === 'Runtime.bindingCalled') {
          void handleBindingCall(entry, msg.params);
        }
      } catch {}
    };
    ws.onclose = () => retire(entry, target.id);
    sockets.set(target.id, entry);
    await sendCdp(entry, 'Runtime.enable');
    await sendCdp(entry, 'Runtime.addBinding', { name: '__agyFileRevealAction' });
    return entry;
  };

  const listPages = async () => {
    let port;
    try {
      port = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0].trim();
    } catch {
      cdpState = 'missing';
      logOnce('DevToolsActivePort not found');
      return [];
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const targets = await res.json();
      const pages = targets.filter(
        (t) => t.type === 'page' && /^https?:\/\/127\.0\.0\.1:\d+\//.test(t.url || '') && t.webSocketDebuggerUrl,
      );
      cdpState = 'ok';
      lastErr = '';
      const activeIds = new Set(pages.map((p) => p.id));
      for (const [id, entry] of sockets) {
        if (!activeIds.has(id)) retire(entry, id);
      }
      return pages;
    } catch (err) {
      cdpState = 'unreachable';
      logOnce(`CDP list failed: ${err?.message || err}`);
      return [];
    }
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await Promise.all(
      [...sockets].map(async ([id, entry]) => {
        try {
          await evaluate(
            entry,
            `globalThis.__agyFileRevealRuntime?.owner===${owner}&&globalThis.__agyFileRevealRuntime.dispose()`,
          );
        } finally {
          retire(entry, id);
        }
      }),
    );
  };

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      for (const target of await listPages()) {
        if (stopped) break;
        try {
          const entry = sockets.get(target.id) || (await connect(target));
          let state = await evaluate(entry, `globalThis.__agyFileRevealRuntime?.readState(${owner})??null`);
          if (state === 'superseded') {
            await stop();
            process.exit(0);
          }
          if (state?.owner !== owner || state.hash !== bundle.hash) {
            await sendCdp(entry, 'Runtime.enable');
            await sendCdp(entry, 'Runtime.addBinding', { name: '__agyFileRevealAction' });
            const installed = await evaluate(entry, bundle.code);
            if (installed === 'superseded') {
              await stop();
              process.exit(0);
            }
          }
        } catch (err) {
          const entry = sockets.get(target.id);
          if (entry) retire(entry, target.id);
          logOnce(`page ${target.id}: ${err?.message || err}`);
        }
      }
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, POLL_MS);
  void tick();

  return {
    stop,
    status: () => ({
      cdpState,
      pageCount: sockets.size,
      portFile: PORT_FILE,
      lastError: lastErr || null,
      history: recentHistory,
    }),
  };
}

const UI_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>文件右键位置</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background, #18191c);
      --card: var(--vscode-sideBar-background, rgba(255, 255, 255, 0.04));
      --fg: var(--vscode-foreground, #e5e7eb);
      --muted: var(--vscode-descriptionForeground, #9ca3af);
      --border: var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
      --accent: #3b82f6;
      --ok: #22c55e;
      --warn: #f59e0b;
      --err: #ef4444;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: var(--vscode-editor-background, #f9fafb);
        --card: var(--vscode-sideBar-background, #ffffff);
        --fg: var(--vscode-foreground, #111827);
        --muted: var(--vscode-descriptionForeground, #6b7280);
        --border: var(--vscode-panel-border, rgba(0, 0, 0, 0.1));
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background: var(--bg);
      color: var(--fg);
      font-family: "Sarasa UI SC", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", sans-serif;
      font-size: 13px;
      line-height: 1.5;
    }
    h1 { margin: 0 0 6px; font-size: 16px; font-weight: 600; }
    .sub { color: var(--muted); margin: 0 0 14px; font-size: 12.5px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 12px;
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid var(--border);
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    .dot.ok { background: var(--ok); }
    .dot.warn { background: var(--warn); }
    .dot.err { background: var(--err); }
    .list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
    .item {
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      font-size: 12px;
      word-break: break-all;
    }
    .item-meta { color: var(--muted); font-size: 11px; margin-top: 2px; }
    .empty { color: var(--muted); font-size: 12px; padding: 6px 0; }
    code {
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(127, 127, 127, 0.14);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <h1>文件右键打开位置</h1>
  <p class="sub">在对话内关联文件胶囊或 <code>file://</code> 链接上右键，可直接使用「打开文件位置」与「复制完整路径」。</p>
  <div class="card">
    <div class="row">
      <span>CDP 页面注入状态</span>
      <span class="badge"><span id="dot" class="dot"></span><span id="statusText">检测中...</span></span>
    </div>
    <div class="row" style="margin-top:8px; color:var(--muted); font-size:12px;">
      <span>已连接窗口数</span>
      <span id="pageCount">0</span>
    </div>
  </div>
  <div class="card">
    <div class="row">
      <strong>最近操作记录</strong>
    </div>
    <div id="history" class="list"><div class="empty">暂无记录</div></div>
  </div>
  <script>
    const statusMap = {
      ok: ['已连接', 'ok'],
      missing: ['未发现调试端口', 'warn'],
      unreachable: ['调试端口不可达', 'err'],
      unknown: ['检测中...', 'warn'],
    };
    function fmtTime(ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString('zh-CN', { hour12: false });
    }
    function esc(s) {
      return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    }
    async function refresh() {
      try {
        const res = await fetch('./api/status');
        const data = await res.json();
        const [label, cls] = statusMap[data.cdpState] || statusMap.unknown;
        document.getElementById('statusText').textContent = label;
        document.getElementById('dot').className = 'dot ' + cls;
        document.getElementById('pageCount').textContent = String(data.pageCount ?? 0);
        const histEl = document.getElementById('history');
        const list = Array.isArray(data.history) ? data.history : [];
        if (!list.length) {
          histEl.innerHTML = '<div class="empty">暂无记录，右键任意关联文件链接试试吧。</div>';
          return;
        }
        histEl.innerHTML = list.map((it) => {
          const actionLabel = it.action === 'copy-path' ? '复制路径' : '打开位置';
          const detail = it.fallback ? (it.fallback + '（' + (it.message || '回退目录') + '）') : (it.path || it.uri || '');
          return '<div class="item"><div><strong>' + esc(actionLabel) + '</strong> · ' + esc(detail) + '</div><div class="item-meta">' + esc(fmtTime(it.ts)) + (it.status === 'error' ? ' · 失败：' + esc(it.message) : '') + '</div></div>';
        }).join('');
      } catch {}
    }
    refresh();
    setInterval(refresh, 1500);
  </script>
</body>
</html>`;

function watchSelfForReload(onChange) {
  const selfPath = fileURLToPath(import.meta.url);
  let lastMtime = 0;
  try {
    lastMtime = fs.statSync(selfPath).mtimeMs;
  } catch {}
  const timer = setInterval(() => {
    try {
      const nextMtime = fs.statSync(selfPath).mtimeMs;
      if (lastMtime && nextMtime !== lastMtime) {
        clearInterval(timer);
        onChange();
      }
      lastMtime = nextMtime;
    } catch {}
  }, RELOAD_MS);
  return () => clearInterval(timer);
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  installEpipeGuard();
  let injector = null;

  if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
    const { SidecarApp } = await import('sidecar_sdk');
    const app = new SidecarApp();
    app.page('/', () => UI_HTML);
    app.api('/api/status', () => injector?.status?.() ?? { cdpState: 'unknown', pageCount: 0, history: recentHistory }, 'GET');
    app.api('/api/reveal', (data = {}) => revealInExplorer(data.uri), 'POST');
    app.run();
  }

  if (process.env.ANTIGRAVITY_LS_ADDRESS || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
    injector = startInjector();
    let stopping = false;
    const shutdown = async (reason) => {
      if (stopping) return;
      stopping = true;
      stopWatching();
      console.log('[agy-file-reveal] stopping:', reason);
      try {
        await injector.stop();
      } finally {
        process.exit(0);
      }
    };
    const stopWatching = watchSelfForReload(() => void shutdown('source updated'));
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.once(sig, () => void shutdown(sig));
    }
  }
}
