'use strict';

(function () {

var LM_VERSION = '2.0.9';
try {
  LM_VERSION = chrome.runtime.getManifest().version || LM_VERSION;
} catch (e) {}

function cleanupStaleExtensionUi() {
  try {
    var bar = document.getElementById('link-monitor-ahtba-bar');
    if (bar && bar.parentNode) {
      bar.parentNode.removeChild(bar);
    }
    var overlay = document.getElementById('lm-ahtba-pick-overlay');
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    var pickExit = document.getElementById('lm-ahtba-pick-exit-float');
    if (pickExit && pickExit.parentNode) {
      pickExit.parentNode.removeChild(pickExit);
    }
    var pageAlert = document.getElementById('link-monitor-overlay-root');
    if (pageAlert && pageAlert.parentNode) {
      pageAlert.parentNode.removeChild(pageAlert);
    }
    var btns = document.querySelectorAll('.lm-ahtba-inline-btn');
    for (var ci = 0; ci < btns.length; ci++) {
      var staleBtn = btns[ci];
      if (staleBtn.parentNode) {
        staleBtn.parentNode.removeChild(staleBtn);
      }
    }
    document.documentElement.style.cursor = '';
  } catch (e) {}
}

// 扩展重载后必须重新初始化；不能用「已加载」标志跳过（否则旧脚本继续运行并报错）
if (window.__linkMonitorPortalLoaded) {
  cleanupStaleExtensionUi();
}

window.__linkMonitorPortalLoaded = true;
window.__linkMonitorPortalGen = (window.__linkMonitorPortalGen || 0) + 1;
var LM_GEN = window.__linkMonitorPortalGen;

function isStaleInstance() {
  return LM_GEN !== window.__linkMonitorPortalGen;
}

var BAR_ID = 'link-monitor-ahtba-bar';
var PICK_OVERLAY_ID = 'lm-ahtba-pick-overlay';
var PICK_EXIT_FLOAT_ID = 'lm-ahtba-pick-exit-float';
var PAGE_ALERT_OVERLAY_ID = 'link-monitor-overlay-root';
var INLINE_BTN_CLASS = 'lm-ahtba-inline-btn';
var SELECTED_ROW_CLASS = 'lm-ahtba-row-selected';
var STYLE_ID = 'link-monitor-ahtba-style';

var lastPickedUrl = window.location.href;
var lastPickedLabel = '';
var lastPickedPage = '';
var selectedRowEl = null;
var pickModeActive = false;
var pickModeAutoExitTimer = null;
var showMonitorBadgesEnabled = false;
var injectedUrlSet = {};
var scanTimer = null;
var inlineScanObserver = null;
var inlineScanIntervalId = null;

function isExtensionInvalidated(err) {
  try {
    if (!chrome.runtime || !chrome.runtime.id) {
      return true;
    }
  } catch (e) {
    return true;
  }
  var msg = (err && err.message) ? err.message : String(err || '');
  return msg.indexOf('Extension context invalidated') !== -1 ||
    msg.indexOf('Receiving end does not exist') !== -1 ||
    msg.indexOf('Access to storage is not allowed') !== -1;
}

function safeSendMessage(message) {
  try {
    if (!chrome.runtime || !chrome.runtime.id) {
      showBarToast('扩展已更新，请刷新本页（F5）后继续使用');
      return Promise.resolve(null);
    }
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(message, function (response) {
        var lastErr = chrome.runtime.lastError;
        if (lastErr) {
          if (isExtensionInvalidated(lastErr)) {
            showBarToast('扩展已更新，请刷新本页（F5）后继续使用');
          }
          resolve(null);
          return;
        }
        resolve(response);
      });
    });
  } catch (e) {
    showBarToast('扩展已更新，请刷新本页（F5）后继续使用');
    return Promise.resolve(null);
  }
}

function resolveRelative(path) {
  if (!path || path.indexOf('javascript:') === 0) {
    return null;
  }
  try {
    return new URL(path, window.location.origin).href;
  } catch (e) {
    return null;
  }
}

function parseUrlFromOnclick(code) {
  if (!code) {
    return null;
  }
  var patterns = [
    /window\.open\s*\(\s*['"]([^'"]+)['"]/i,
    /location\.href\s*=\s*['"]([^'"]+)['"]/i,
    /location\.replace\s*\(\s*['"]([^'"]+)['"]/i,
    /(?:goUrl|goDetail|openDetail|showDetail|viewDetail|toDetail|jumpUrl|openUrl|openWin|showInfo|viewInfo|detail|toUrl|linkUrl)\s*\(\s*['"]([^'"]+)['"]/i,
    /['"](https?:\/\/[^'"]+)['"]/i,
    /['"](\/[^'"]+)['"]/
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = code.match(patterns[i]);
    if (m && m[1]) {
      var url = resolveRelative(m[1]);
      if (url) {
        return url;
      }
    }
  }
  return null;
}

function resolveMonitorUrl(el) {
  if (!el || el.nodeType !== 1) {
    return null;
  }
  var anchor = el.closest('a[href]');
  if (anchor) {
    var href = anchor.getAttribute('href');
    if (href && href.indexOf('javascript:') !== 0 && href !== '#') {
      return resolveRelative(href);
    }
    var fromOnclick = parseUrlFromOnclick(anchor.getAttribute('onclick'));
    if (fromOnclick) {
      return fromOnclick;
    }
  }

  var node = el;
  for (var depth = 0; depth < 12 && node; depth++) {
    var onclick = node.getAttribute('onclick');
    var fromClick = parseUrlFromOnclick(onclick);
    if (fromClick) {
      return fromClick;
    }
    var dataHref = node.getAttribute('data-href') || node.getAttribute('data-url') ||
      node.getAttribute('data-link') || node.getAttribute('data-src') ||
      node.getAttribute('data-id');
    if (dataHref) {
      if (dataHref.indexOf('/') === 0 || dataHref.indexOf('http') === 0) {
        var dataUrl = resolveRelative(dataHref);
        if (dataUrl) {
          return dataUrl;
        }
      }
    }
    node = node.parentElement;
  }
  return null;
}

function pickLabel(el) {
  if (!el) {
    return '';
  }
  var row = el.closest('tr, li, .list-item, [class*="row"], [class*="item"], p, dt, dd');
  var textSource = row || el;
  return (textSource.innerText || textSource.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function normalizePageUrl(url) {
  if (!url) {
    return url;
  }
  try {
    var parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch (e) {
    return url;
  }
}

function isSamePage(url) {
  return normalizePageUrl(url) === normalizePageUrl(location.href);
}

function isExtensionUi(el) {
  if (!el || !el.closest) {
    return false;
  }
  if (el.closest('#' + BAR_ID) || el.closest('.' + INLINE_BTN_CLASS)) {
    return true;
  }
  if (el.closest('#' + PICK_EXIT_FLOAT_ID)) {
    return true;
  }
  if (el.closest('#' + PAGE_ALERT_OVERLAY_ID)) {
    return true;
  }
  return false;
}

function savePickedUrl(url, label) {
  if (isStaleInstance()) {
    return;
  }
  if (!url) {
    return;
  }
  url = normalizePageUrl(url);
  lastPickedUrl = url;
  lastPickedLabel = label || '';
  lastPickedPage = normalizePageUrl(location.href);
}

function setCurrentPagePicked() {
  lastPickedUrl = normalizePageUrl(location.href);
  lastPickedLabel = document.title || '';
  lastPickedPage = normalizePageUrl(location.href);
  updatePickedButton(getPickedButton(), lastPickedUrl, lastPickedLabel);
}

function registerMonitor(url, name) {
  if (isStaleInstance()) {
    return;
  }
  var targetUrl = normalizePageUrl(url || location.href);
  var label = (name || '').trim();
  safeSendMessage({
    type: 'REGISTER_MONITOR',
    url: targetUrl,
    pageUrl: normalizePageUrl(location.href),
    name: label,
    silent: true
  }).then(function (response) {
    if (!response || !response.ok) {
      showBarToast('监控失败，请刷新页面后重试');
      return;
    }
    var short = (label || targetUrl).slice(0, 42);
    if (response.added) {
      showBarToast('已添加并开始监控（默认间隔）：' + short);
    } else if (response.updated) {
      showBarToast('已更新监控链接：' + short);
    } else {
      showBarToast('已开始监控：' + short);
    }
  });
}

function getPickedButton() {
  return document.querySelector('#' + BAR_ID + ' .lm-ahtba-picked');
}

function updatePickedButton(btn, url, label) {
  if (!btn) {
    return;
  }
  if (!url || isSamePage(url)) {
    btn.disabled = true;
    btn.textContent = '\u5f00\u542f\u70b9\u9009\u6a21\u5f0f\u540e\u70b9\u6761\u76ee';
    return;
  }
  btn.disabled = false;
  var short = label || url;
  if (short.length > 36) {
    short = short.slice(0, 36) + '...';
  }
  btn.textContent = '\u76d1\u63a7\u5df2\u9009\u9879\uff1a' + short;
}

function showBarToast(text) {
  var bar = document.getElementById(BAR_ID);
  if (!bar) {
    return;
  }
  var toast = bar.querySelector('.lm-ahtba-toast');
  if (!toast) {
    return;
  }
  toast.textContent = text;
  toast.style.opacity = '1';
  setTimeout(function () {
    toast.style.opacity = '0';
  }, 2800);
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  var style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    '.' + SELECTED_ROW_CLASS + '{outline:2px solid #2563eb!important;outline-offset:-2px;background:rgba(37,99,235,.08)!important;}' +
    '.' + INLINE_BTN_CLASS + '{margin:0 4px;padding:1px 5px;display:inline-flex;align-items:center;' +
    'vertical-align:middle;pointer-events:none;flex-shrink:0;line-height:1.2;' +
    'background:#dc2626;color:#fff;font:10px/1.2 Segoe UI,system-ui,sans-serif;font-weight:600;' +
    'border-radius:4px;white-space:nowrap;transform:scale(.92);transform-origin:left center;}';
  document.head.appendChild(style);
}

function highlightSelectedRow(row) {
  if (selectedRowEl && selectedRowEl !== row) {
    selectedRowEl.classList.remove(SELECTED_ROW_CLASS);
  }
  selectedRowEl = row;
  if (row) {
    row.classList.add(SELECTED_ROW_CLASS);
  }
}

function pickEntry(url, label, row, startMonitor) {
  if (isStaleInstance()) {
    return;
  }
  if (!url || isSamePage(url)) {
    showBarToast('\u8be5\u6761\u76ee\u65e0\u53ef\u76d1\u63a7\u94fe\u63a5');
    return;
  }
  savePickedUrl(url, label);
  highlightSelectedRow(row);
  updatePickedButton(getPickedButton(), url, label);
  var short = (label || url).slice(0, 42);
  if (startMonitor) {
    registerMonitor(url, label);
    schedulePickModeAutoExit();
  } else {
    showBarToast('\u5df2\u9009\u4e2d\uff1a' + short);
  }
}

function findMonitorTarget(el) {
  if (!el || isExtensionUi(el)) {
    return null;
  }
  var row = el.closest('tr, li, dl, dt, dd, p, span, a, [class*="list"], [class*="item"]');
  if (!row || row === document.body) {
    row = el;
  }
  var url = resolveMonitorUrl(el);
  if (!url || isSamePage(url)) {
    url = resolveMonitorUrl(row);
  }
  if (!url || isSamePage(url)) {
    var nodes = row.querySelectorAll('a[href], [onclick]');
    for (var i = 0; i < nodes.length; i++) {
      url = resolveMonitorUrl(nodes[i]);
      if (url && !isSamePage(url)) {
        break;
      }
      url = null;
    }
  }
  if (!url || isSamePage(url)) {
    return null;
  }
  return { row: row, url: url, label: pickLabel(row) };
}

function collectPageLinks() {
  var map = {};
  var nodes = document.querySelectorAll('a[href], [onclick]');
  for (var i = 0; i < nodes.length; i++) {
    if (isExtensionUi(nodes[i])) {
      continue;
    }
    var url = resolveMonitorUrl(nodes[i]);
    if (!url || isSamePage(url)) {
      continue;
    }
    if (!map[url]) {
      map[url] = pickLabel(nodes[i]) || url;
    }
  }
  var links = [];
  for (var key in map) {
    if (map.hasOwnProperty(key)) {
      links.push({ url: key, label: map[key] });
    }
  }
  return links.slice(0, 100);
}

function createInlineMonitorBadge(url) {
  var badge = document.createElement('span');
  badge.className = INLINE_BTN_CLASS;
  badge.dataset.lmUrl = url;
  badge.textContent = '\u53ef\u76d1\u63a7';
  badge.setAttribute('title', '\u53ef\u76d1\u63a7\u94fe\u63a5\uff08\u8bf7\u7528\u70b9\u9009\u6a21\u5f0f\u70b9\u9009\uff09');
  return badge;
}

function cssEscape(value) {
  return String(value).replace(/"/g, '\\"');
}

function removeInlineMonitorBadges() {
  injectedUrlSet = {};
  var badges = document.querySelectorAll('.' + INLINE_BTN_CLASS);
  for (var i = 0; i < badges.length; i++) {
    var el = badges[i];
    if (el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }
}

function stopInlineMonitorScan() {
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
  if (inlineScanIntervalId) {
    clearInterval(inlineScanIntervalId);
    inlineScanIntervalId = null;
  }
  if (inlineScanObserver) {
    inlineScanObserver.disconnect();
    inlineScanObserver = null;
  }
}

function injectInlineMonitorBadges() {
  if (isStaleInstance() || !showMonitorBadgesEnabled) {
    return;
  }
  var nodes = document.querySelectorAll('a[href], [onclick]');
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (isExtensionUi(node)) {
      continue;
    }
    var url = resolveMonitorUrl(node);
    if (!url || isSamePage(url)) {
      continue;
    }
    if (injectedUrlSet[url]) {
      continue;
    }
    var parent = node.parentElement;
    if (!parent) {
      continue;
    }
    if (parent.querySelector('.' + INLINE_BTN_CLASS + '[data-lm-url="' + cssEscape(url) + '"]')) {
      injectedUrlSet[url] = true;
      continue;
    }
    var marker = createInlineMonitorBadge(url);
    if (node.nextSibling) {
      parent.insertBefore(marker, node.nextSibling);
    } else {
      parent.appendChild(marker);
    }
    injectedUrlSet[url] = true;
  }
}

function scheduleInlineScan() {
  if (isStaleInstance() || !showMonitorBadgesEnabled) {
    return;
  }
  if (scanTimer) {
    return;
  }
  scanTimer = setTimeout(function () {
    scanTimer = null;
    injectInlineMonitorBadges();
  }, 400);
}

function bindDynamicScan() {
  if (!document.body || !showMonitorBadgesEnabled) {
    return;
  }
  injectInlineMonitorBadges();
  if (!inlineScanObserver) {
    try {
      inlineScanObserver = new MutationObserver(function () {
        scheduleInlineScan();
      });
      inlineScanObserver.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  }
  if (!inlineScanIntervalId) {
    inlineScanIntervalId = setInterval(injectInlineMonitorBadges, 2500);
  }
}

function applyShowMonitorBadges(enabled) {
  showMonitorBadgesEnabled = enabled === true;
  if (!showMonitorBadgesEnabled) {
    stopInlineMonitorScan();
    removeInlineMonitorBadges();
    return;
  }
  bindDynamicScan();
}

function applyShowPickToolbar(enabled) {
  if (enabled) {
    showMonitorBar();
  } else {
    hideMonitorBar();
  }
}

function bindPickToolbarSetting() {
  try {
    if (!chrome.storage || !chrome.storage.local) {
      return;
    }
    chrome.storage.local.get(['showPickToolbar'], function (data) {
      if (isStaleInstance()) {
        return;
      }
      applyShowPickToolbar(data.showPickToolbar === true);
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (isStaleInstance() || area !== 'local' || !changes.showPickToolbar) {
        return;
      }
      applyShowPickToolbar(changes.showPickToolbar.newValue === true);
    });
  } catch (e) {}
}

function bindMonitorBadgeSetting() {
  try {
    if (!chrome.storage || !chrome.storage.local) {
      return;
    }
    chrome.storage.local.get(['showMonitorBadges'], function (data) {
      if (isStaleInstance()) {
        return;
      }
      applyShowMonitorBadges(data.showMonitorBadges === true);
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (isStaleInstance() || area !== 'local' || !changes.showMonitorBadges) {
        return;
      }
      applyShowMonitorBadges(changes.showMonitorBadges.newValue === true);
    });
  } catch (e) {}
}

function schedulePickModeAutoExit() {
  if (pickModeAutoExitTimer) {
    clearTimeout(pickModeAutoExitTimer);
  }
  pickModeAutoExitTimer = setTimeout(function () {
    pickModeAutoExitTimer = null;
    if (isStaleInstance()) {
      return;
    }
    if (pickModeActive) {
      setPickMode(false);
      showBarToast('已自动退出点选模式');
    }
  }, 3000);
}

function ensurePickExitFloat() {
  var btn = document.getElementById(PICK_EXIT_FLOAT_ID);
  if (btn) {
    return btn;
  }
  btn = document.createElement('button');
  btn.id = PICK_EXIT_FLOAT_ID;
  btn.type = 'button';
  btn.textContent = '\u5173\u95ed\u70b9\u9009\u6a21\u5f0f';
  btn.setAttribute('style',
    'position:fixed;top:12px;right:12px;z-index:2147483647;pointer-events:auto;' +
    'padding:10px 18px;border:none;border-radius:8px;background:#dc2626;color:#fff;' +
    'font:14px/1.2 Segoe UI,system-ui,sans-serif;font-weight:700;cursor:pointer;' +
    'box-shadow:0 4px 20px rgba(0,0,0,.4);');
  btn.addEventListener('mousedown', function (e) {
    e.stopPropagation();
  }, true);
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    setPickMode(false);
  }, true);
  document.body.appendChild(btn);
  return btn;
}

function removePickExitFloat() {
  var btn = document.getElementById(PICK_EXIT_FLOAT_ID);
  if (btn) {
    btn.remove();
  }
}

function setPickMode(active) {
  pickModeActive = active;
  var overlay = document.getElementById(PICK_OVERLAY_ID);
  var bar = document.getElementById(BAR_ID);
  if (active) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = PICK_OVERLAY_ID;
      overlay.setAttribute('style',
        'position:fixed;top:0;left:0;right:0;z-index:2147483644;pointer-events:none;');
      var banner = document.createElement('div');
      banner.textContent = '\u70b9\u9009\u6a21\u5f0f\uff1a\u70b9\u6761\u76ee\u5373\u52a0\u5165\u76d1\u63a7\uff08\u9ed8\u8ba4\u95f4\u9694\uff0c3\u79d2\u540e\u81ea\u52a8\u9000\u51fa\uff09';
      banner.setAttribute('style',
        'margin:10px auto;padding:8px 16px;max-width:90%;text-align:center;' +
        'background:#dc2626;color:#fff;font:13px Segoe UI,system-ui,sans-serif;font-weight:600;' +
        'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);');
      overlay.appendChild(banner);
      document.body.appendChild(overlay);
    }
    if (document.body) {
      ensurePickExitFloat();
    }
    document.documentElement.style.cursor = 'crosshair';
    showBarToast('\u70b9\u9009\u6a21\u5f0f\u5df2\u5f00\u542f');
  } else {
    if (pickModeAutoExitTimer) {
      clearTimeout(pickModeAutoExitTimer);
      pickModeAutoExitTimer = null;
    }
    if (overlay) {
      overlay.remove();
    }
    removePickExitFloat();
    document.documentElement.style.cursor = '';
  }
  if (bar) {
    bar.style.zIndex = active ? '2147483647' : '2147483646';
  }
  var toggle = document.getElementById('lm-ahtba-pick-toggle');
  if (toggle) {
    toggle.textContent = active ? '\u5173\u95ed\u70b9\u9009\u6a21\u5f0f' : '\u5f00\u542f\u70b9\u9009\u6a21\u5f0f';
    toggle.style.background = active ? '#dc2626' : '#7c3aed';
  }
}

function bindPickMode() {
  function handlePickEvent(e) {
    if (isStaleInstance() || !pickModeActive) {
      return;
    }
    if (isExtensionUi(e.target)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (e.type === 'mousedown' || e.type === 'mouseup') {
      return;
    }

    var info = findMonitorTarget(e.target);
    if (!info) {
      showBarToast('\u672a\u8bc6\u522b\u5230\u94fe\u63a5\uff0c\u8bf7\u70b9\u6761\u76ee\u672c\u8eab\u6216\u6269\u5c55\u9762\u677f\u94fe\u63a5\u5217\u8868');
      return;
    }
    pickEntry(info.url, info.label, info.row, true);
  }

  document.addEventListener('mousedown', function (e) {
    if (isStaleInstance() || !pickModeActive || isExtensionUi(e.target)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);

  document.addEventListener('click', handlePickEvent, true);
}

function restoreContextMenu() {
  try {
    document.oncontextmenu = null;
    window.oncontextmenu = null;
  } catch (e) {}

  document.addEventListener('contextmenu', function (e) {
    e.stopImmediatePropagation();
  }, true);
  window.addEventListener('contextmenu', function (e) {
    e.stopImmediatePropagation();
  }, true);
}

function showMonitorBar() {
  try {
    sessionStorage.removeItem('lm-ahtba-bar-closed');
  } catch (e) {}
  if (!document.body) {
    return false;
  }
  injectMonitorBar();
  return !!document.getElementById(BAR_ID);
}

function isMonitorBarVisible() {
  return !!document.getElementById(BAR_ID);
}

function hideMonitorBar() {
  try {
    sessionStorage.setItem('lm-ahtba-bar-closed', '1');
  } catch (e) {}
  if (pickModeActive) {
    setPickMode(false);
  }
  var bar = document.getElementById(BAR_ID);
  if (bar && bar.parentNode) {
    bar.parentNode.removeChild(bar);
  }
}

function isMonitorBarClosed() {
  try {
    return sessionStorage.getItem('lm-ahtba-bar-closed') === '1';
  } catch (e) {
    return false;
  }
}

function injectMonitorBar() {
  if (isMonitorBarClosed()) {
    return;
  }
  var existingBar = document.getElementById(BAR_ID);
  if (existingBar) {
    existingBar.remove();
  }

  var bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.setAttribute('style',
    'position:fixed;right:16px;bottom:16px;z-index:2147483646;' +
    'background:#1e3a5f;color:#fff;font:13px/1.4 Segoe UI,system-ui,sans-serif;' +
    'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.25);padding:10px 12px;' +
    'max-width:340px;min-width:260px;');

  var titleRow = document.createElement('div');
  titleRow.setAttribute('style',
    'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;');

  var title = document.createElement('div');
  title.textContent = '\u94fe\u63a5\u53d8\u66f4\u76d1\u63a7 v' + LM_VERSION;
  title.setAttribute('style', 'font-weight:700;font-size:12px;color:#93c5fd;flex:1;min-width:0;');

  var btnClose = document.createElement('button');
  btnClose.type = 'button';
  btnClose.setAttribute('aria-label', '\u5173\u95ed\u5de5\u5177\u6761');
  btnClose.title = '\u5173\u95ed\u5de5\u5177\u6761';
  btnClose.textContent = '\u00d7';
  btnClose.setAttribute('style',
    'flex-shrink:0;width:22px;height:22px;padding:0;border:none;border-radius:4px;' +
    'background:transparent;color:#94a3b8;font-size:18px;line-height:1;cursor:pointer;' +
    'display:flex;align-items:center;justify-content:center;');
  btnClose.addEventListener('mouseenter', function () {
    btnClose.style.background = 'rgba(255,255,255,.12)';
    btnClose.style.color = '#fff';
  });
  btnClose.addEventListener('mouseleave', function () {
    btnClose.style.background = 'transparent';
    btnClose.style.color = '#94a3b8';
  });
  btnClose.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    hideMonitorBar();
  });

  titleRow.appendChild(title);
  titleRow.appendChild(btnClose);

  var hint = document.createElement('div');
  hint.innerHTML =
    '1. \u70b9\u300c\u5f00\u542f\u70b9\u9009\u6a21\u5f0f\u300d\u540e\u518d\u70b9\u6761\u76ee<br>' +
    '2. \u6216\u5728\u6269\u5c55\u9762\u677f\u300c\u672c\u9875\u94fe\u63a5\u300d\u4e2d\u9009\u62e9';
  hint.setAttribute('style', 'font-size:11px;color:#cbd5e1;margin-bottom:8px;line-height:1.5;');

  var btnPick = document.createElement('button');
  btnPick.type = 'button';
  btnPick.id = 'lm-ahtba-pick-toggle';
  btnPick.textContent = '\u5f00\u542f\u70b9\u9009\u6a21\u5f0f';
  btnPick.setAttribute('style',
    'display:block;width:100%;margin-bottom:6px;padding:8px 10px;border:none;border-radius:6px;' +
    'background:#7c3aed;color:#fff;font-size:12px;font-weight:600;cursor:pointer;');

  var btnPage = document.createElement('button');
  btnPage.type = 'button';
  btnPage.textContent = '\u76d1\u63a7\u672c\u9875';
  btnPage.setAttribute('style',
    'display:block;width:100%;margin-bottom:6px;padding:8px 10px;border:none;border-radius:6px;' +
    'background:#2563eb;color:#fff;font-size:12px;font-weight:600;cursor:pointer;');

  var btnPicked = document.createElement('button');
  btnPicked.type = 'button';
  btnPicked.className = 'lm-ahtba-picked';
  btnPicked.setAttribute('style',
    'display:block;width:100%;padding:8px 10px;border:none;border-radius:6px;' +
    'background:#0ea5e9;color:#fff;font-size:12px;font-weight:600;cursor:pointer;');

  var toast = document.createElement('div');
  toast.className = 'lm-ahtba-toast';
  toast.setAttribute('style',
    'margin-top:8px;font-size:11px;color:#86efac;opacity:0;transition:opacity .2s;');

  btnPick.addEventListener('click', function () {
    setPickMode(!pickModeActive);
  });

  btnPage.addEventListener('click', function () {
    registerMonitor(location.href);
    showBarToast('\u5df2\u5f00\u542f\u672c\u9875\u76d1\u63a7');
  });

  btnPicked.addEventListener('click', function () {
    if (!lastPickedUrl || isSamePage(lastPickedUrl)) {
      showBarToast('\u8bf7\u5148\u7528\u70b9\u9009\u6a21\u5f0f\u9009\u4e2d\u6761\u76ee');
      return;
    }
    registerMonitor(lastPickedUrl);
    showBarToast('\u5df2\u5f00\u542f\u76d1\u63a7');
  });

  bar.appendChild(titleRow);
  bar.appendChild(hint);
  bar.appendChild(btnPick);
  bar.appendChild(btnPage);
  bar.appendChild(btnPicked);
  bar.appendChild(toast);
  document.body.appendChild(bar);

  updatePickedButton(btnPicked, lastPickedUrl, lastPickedLabel);
}

function initSessionForPage() {
  lastPickedUrl = location.href;
  lastPickedLabel = document.title || '';
  lastPickedPage = normalizePageUrl(location.href);
  updatePickedButton(getPickedButton(), lastPickedUrl, lastPickedLabel);
}

function bindPageNavigationSync() {
  window.addEventListener('pageshow', function () {
    if (isStaleInstance()) {
      return;
    }
    setCurrentPagePicked();
  });
  window.addEventListener('hashchange', function () {
    if (isStaleInstance()) {
      return;
    }
    setCurrentPagePicked();
  });
}

function canUseExtensionApi() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

function extractPageFingerprintLocal() {
  try {
    var PORTAL_LIST_PATH_RE = /(?:^|\/)(?:index|home|list|affiche|notice|trade|query|search|more)(?:\/|$|\?)/i;
    var PORTAL_DETAIL_PATH_RE = /(?:detail|view|info|content|article|show|guid|afficheDetail|noticeDetail|tradeDetail|proj|bulletin|announce)/i;
    function looksLikeDetail(url) {
      try {
        var path = (new URL(url).pathname || '').toLowerCase();
        if (PORTAL_DETAIL_PATH_RE.test(path)) {
          return true;
        }
        if (PORTAL_LIST_PATH_RE.test(path) && !PORTAL_DETAIL_PATH_RE.test(path)) {
          return false;
        }
        var segments = path.split('/').filter(Boolean);
        if (segments.length >= 3) {
          var last = segments[segments.length - 1];
          if (/^\d{5,}$/.test(last) || /[0-9a-f]{12,}/i.test(last)) {
            return true;
          }
        }
        return false;
      } catch (e) {
        return false;
      }
    }

    var parts = [];
    var seen = {};
    if (!looksLikeDetail(location.href)) {
      var nodes = document.querySelectorAll('table tbody tr, ul li, .list-item, a[href]');
      for (var i = 0; i < nodes.length && parts.length < 80; i++) {
        if (isExtensionUi(nodes[i])) {
          continue;
        }
        var text = (nodes[i].innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length >= 6 && !seen[text]) {
          seen[text] = true;
          parts.push(text.slice(0, 160));
        }
      }
    }
    var listSnap = parts.join('\n');
    var listRows = listSnap ? listSnap.split('\n').filter(function (l) {
      return l.trim().length >= 6;
    }).length : 0;
    var bodyText = '';
    if (looksLikeDetail(location.href)) {
      var detailSelectors = [
        'article', '.article-content', '.detail-content', '.content-detail',
        '.notice-content', '.affiche-content', '#content', 'main', '.main-content'
      ];
      for (var d = 0; d < detailSelectors.length; d++) {
        var detailEl = document.querySelector(detailSelectors[d]);
        if (detailEl && (detailEl.innerText || '').trim().length >= 40) {
          bodyText = (detailEl.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 15000);
          break;
        }
      }
    }
    if (!bodyText && document.body) {
      bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 15000);
    }
    var core = (listRows >= 4 && listSnap) ? 'LIST::' + listSnap + '\nBODY::' + bodyText : bodyText;
    return {
      raw: document.documentElement ? document.documentElement.outerHTML.slice(0, 300000) : '',
      core: core,
      overlaySignature: ''
    };
  } catch (e) {
    return { raw: '', core: '', overlaySignature: '' };
  }
}

function registerRuntimeMessageListener() {
  if (!canUseExtensionApi()) {
    return;
  }
  try {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (isStaleInstance() || !canUseExtensionApi()) {
        return;
      }
      if (message.type === 'EXTENSION_UPDATED') {
        showBarToast('扩展已更新 v' + LM_VERSION + '，建议刷新本页（F5）');
        sendResponse({ ok: true });
        return true;
      }
      if (message.type === 'SCAN_PAGE_LINKS') {
        sendResponse({ ok: true, links: collectPageLinks() });
        return true;
      }
      if (message.type === 'EXTRACT_PAGE_FINGERPRINT') {
        sendResponse({ ok: true, fingerprints: extractPageFingerprintLocal() });
        return true;
      }
      if (message.type === 'SHOW_PICK_TOOLBAR') {
        sendResponse({ ok: true, visible: showMonitorBar() });
        return true;
      }
      if (message.type === 'SET_PICK_TOOLBAR') {
        applyShowPickToolbar(message.enabled === true);
        sendResponse({ ok: true, visible: isMonitorBarVisible() });
        return true;
      }
      if (message.type === 'GET_PICK_TOOLBAR_STATE') {
        sendResponse({ ok: true, visible: isMonitorBarVisible() });
        return true;
      }
    });
  } catch (e) {
    // 静默：避免旧上下文错误刷满扩展错误页
  }
}

function bindGlobalErrorGuards() {
  window.addEventListener('error', function (e) {
    if (isStaleInstance()) {
      return;
    }
    var err = e.error || e.message;
    if (isExtensionInvalidated(err)) {
      showBarToast('扩展已更新，请刷新本页（F5）后继续使用');
      e.preventDefault();
    }
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (isStaleInstance()) {
      return;
    }
    if (isExtensionInvalidated(e.reason)) {
      showBarToast('扩展已更新，请刷新本页（F5）后继续使用');
      e.preventDefault();
    }
  });
}

function init() {
  if (!canUseExtensionApi()) {
    return;
  }
  bindGlobalErrorGuards();
  registerRuntimeMessageListener();
  bindPickToolbarSetting();
  bindMonitorBadgeSetting();
  injectStyles();
  restoreContextMenu();
  bindPickMode();
  initSessionForPage();
  bindPageNavigationSync();
  setInterval(function () {
    if (isStaleInstance()) {
      return;
    }
    if (!canUseExtensionApi()) {
      var bar = document.getElementById(BAR_ID);
      if (bar) {
        bar.style.opacity = '0.6';
      }
      showBarToast('扩展已更新，请刷新本页（F5）后继续使用');
    }
  }, 5000);
}

if (canUseExtensionApi()) {
  init();
}

})();
