var ALARM_NAME = 'link-check';
var FAST_ALARM_NAME = 'link-check-fast';
var DEFAULT_INTERVAL_MINUTES = 30;
var alertWindowId = null;
var throttleAskWindowId = null;
var POPUP_WINDOW_MS = 60 * 60 * 1000;
var POPUP_MAX_BEFORE_ASK = 40;
var THROTTLE_PAUSE_INTERVAL_MINUTES = 30;
var popupAlertRecordChain = Promise.resolve();
var LIFECYCLE_NOTIFY_WINDOW_MS = 1000;
var LIFECYCLE_NOTIFY_MAX = 2;
var lifecycleGeneration = 0;
var lifecycleStopRequested = false;
var lifecycleNotifyTimestamps = [];
var monitorOpChain = Promise.resolve();
var checkFailNotifyAt = {};
var CHECK_FAIL_NOTIFY_COOLDOWN_MS = 15 * 60 * 1000;
var FETCH_RETRY_COUNT = 3;
var FETCH_RETRY_COUNT_PORTAL = 5;
var FETCH_RETRY_DELAY_MS = 2000;
var CORE_CONFIRM_DELAY_MS = 2000;
var CORE_BASELINE_VERSION = 4;
var CORE_SNIPPET_MAX = 4000;
var MIN_PERIODIC_ALARM_MINUTES = 1;

function isTransientFetchError(err) {
  var msg = err && err.message ? err.message : String(err || '');
  return msg.indexOf('Failed to fetch') !== -1 ||
    msg.indexOf('HTTP 503') !== -1 ||
    msg.indexOf('HTTP 504') !== -1 ||
    msg.indexOf('HTTP 502') !== -1 ||
    msg.indexOf('HTTP 429') !== -1;
}

function buildFetchErrorHint(status) {
  if (status === 401 || status === 403) {
    return MSG.LOGIN_HINT;
  }
  if (status === 503) {
    return MSG.HTTP_503_HINT;
  }
  if (status === 504 || status === 502) {
    return MSG.HTTP_504_HINT;
  }
  return '';
}

var NOTIFY_DEFAULTS = {
  priority: 2,
  requireInteraction: true,
  silent: false
};

function bumpLifecycleAbort() {
  lifecycleGeneration += 1;
  return lifecycleGeneration;
}

function isLifecycleOpCurrent(opGen) {
  return opGen === lifecycleGeneration && !lifecycleStopRequested;
}

function shouldShowLifecycleNotification() {
  var now = Date.now();
  lifecycleNotifyTimestamps = lifecycleNotifyTimestamps.filter(function (t) {
    return now - t < LIFECYCLE_NOTIFY_WINDOW_MS;
  });
  if (lifecycleNotifyTimestamps.length >= LIFECYCLE_NOTIFY_MAX) {
    return false;
  }
  lifecycleNotifyTimestamps.push(now);
  return true;
}

function queueStopOp(fn) {
  bumpLifecycleAbort();
  lifecycleStopRequested = true;
  var op = monitorOpChain.then(function () {
    return fn();
  });
  monitorOpChain = op.catch(function () {});
  return op;
}

function queueStartOp(fn) {
  var op = monitorOpChain.then(function () {
    lifecycleStopRequested = false;
    return fn();
  });
  monitorOpChain = op.catch(function () {});
  return op;
}

function isMonitoringStillActive() {
  if (lifecycleStopRequested) {
    return false;
  }
  return getSettings().then(function (settings) {
    return settings.monitoringActive && settings.monitors.length > 0;
  });
}

function truncateUrl(url, max) {
  max = max || 80;
  if (!url || url.length <= max) {
    return url || '';
  }
  return url.slice(0, max) + '...';
}

function setAttentionBadge(text) {
  return chrome.action.setBadgeText({ text: text }).then(function () {
    return chrome.action.setBadgeBackgroundColor({ color: '#DC2626' });
  });
}

function clearAttentionBadge() {
  return chrome.action.setBadgeText({ text: '' }).then(function () {
    return chrome.action.setTitle({ title: MSG.EXT_TITLE });
  });
}

function ensureOffscreenDocument() {
  return chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then(function (contexts) {
    if (contexts.length > 0) {
      return;
    }
    return chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: MSG.AUDIO_REASON
    }).then(function () {
      return new Promise(function (resolve) {
        setTimeout(resolve, 150);
      });
    });
  });
}

function playAlertSound() {
  return ensureOffscreenDocument().then(function () {
    return chrome.runtime.sendMessage({ type: 'PLAY_ALERT' });
  }).catch(function (err) {
    console.error(MSG.LOG_AUDIO_FAIL, err);
  });
}

function showWebNotificationFallback(title, message) {
  return ensureOffscreenDocument().then(function () {
    return chrome.runtime.sendMessage({
      type: 'SHOW_WEB_NOTIFICATION',
      title: title,
      body: message
    });
  });
}

function getNotificationIconUrl() {
  return chrome.runtime.getURL('icons/icon-notification256.png');
}

function showSystemNotification(idPrefix, title, message, extra) {
  extra = extra || {};
  var nid = idPrefix + '-' + Date.now();
  var payload = {
    type: 'basic',
    iconUrl: getNotificationIconUrl(),
    title: title,
    message: message,
    priority: NOTIFY_DEFAULTS.priority,
    requireInteraction: NOTIFY_DEFAULTS.requireInteraction,
    silent: NOTIFY_DEFAULTS.silent
  };
  if (extra.buttons) {
    payload.buttons = extra.buttons;
  }

  return chrome.notifications.create(nid, payload).catch(function (err) {
    console.error(MSG.LOG_NOTIFY_FAIL, err);
    return chrome.notifications.create(nid + '-plain', {
      type: 'basic',
      title: title,
      message: message,
      priority: 2,
      requireInteraction: true,
      silent: false
    });
  }).catch(function (err2) {
    console.error(MSG.LOG_NOTIFY_FAIL, err2);
    return showWebNotificationFallback(title, message);
  });
}

function buildAlertPageUrl(title, message, linkUrl) {
  var q = 'title=' + encodeURIComponent(title) + '&message=' + encodeURIComponent(message);
  if (linkUrl) {
    q += '&url=' + encodeURIComponent(linkUrl);
  }
  return chrome.runtime.getURL('alert/alert.html?' + q);
}

function showChromeAlertPopup(title, message, linkUrl) {
  var alertUrl = buildAlertPageUrl(title, message, linkUrl);
  var closePrev = Promise.resolve();
  if (alertWindowId) {
    closePrev = chrome.windows.remove(alertWindowId).catch(function () {});
  }
  return closePrev.then(function () {
    return chrome.windows.create({
      url: alertUrl,
      type: 'popup',
      width: 480,
      height: 340,
      focused: true
    }).then(function (win) {
      if (win && win.id) {
        alertWindowId = win.id;
      }
    });
  }).catch(function (err) {
    console.error('Chrome popup alert failed', err);
  });
}

function paintPageOverlay(title, message, linkUrl, tag, btnOpen, btnClose, iconUrl) {
  var rootId = 'link-monitor-overlay-root';
  var old = document.getElementById(rootId);
  if (old) {
    old.remove();
  }

  var backdrop = document.createElement('div');
  backdrop.id = rootId;
  backdrop.setAttribute('style',
    'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483647;' +
    'display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;');

  var box = document.createElement('div');
  box.setAttribute('style',
    'max-width:440px;width:100%;background:#fff;border:3px solid #ef4444;border-radius:14px;' +
    'padding:22px;box-shadow:0 20px 50px rgba(0,0,0,.45);font-family:Segoe UI,system-ui,sans-serif;');

  var header = document.createElement('div');
  header.setAttribute('style', 'display:flex;align-items:center;gap:10px;margin-bottom:10px;');

  if (iconUrl) {
    var iconEl = document.createElement('img');
    iconEl.src = iconUrl;
    iconEl.alt = '';
    iconEl.setAttribute('style',
      'width:52px;height:52px;border-radius:10px;object-fit:cover;flex-shrink:0;' +
      'border:2px solid #fecaca;box-shadow:0 2px 8px rgba(0,0,0,.12);');
    header.appendChild(iconEl);
  }

  var tagEl = document.createElement('div');
  tagEl.textContent = tag;
  tagEl.setAttribute('style',
    'display:inline-block;font-size:12px;font-weight:700;color:#fff;background:#dc2626;' +
    'padding:4px 10px;border-radius:999px;');

  header.appendChild(tagEl);
  box.appendChild(header);

  var heading = document.createElement('h2');
  heading.textContent = title;
  heading.setAttribute('style', 'font-size:20px;font-weight:700;color:#111827;margin:0 0 8px;line-height:1.4;');

  var body = document.createElement('p');
  body.textContent = message;
  body.setAttribute('style', 'font-size:14px;color:#4b5563;margin:0;line-height:1.6;white-space:pre-wrap;');

  box.appendChild(heading);
  box.appendChild(body);

  if (linkUrl) {
    var urlLine = document.createElement('p');
    urlLine.textContent = linkUrl;
    urlLine.setAttribute('style',
      'font-size:12px;color:#6b7280;margin:10px 0 0;word-break:break-all;background:#f9fafb;' +
      'padding:8px;border-radius:8px;');
    box.appendChild(urlLine);
  }

  var row = document.createElement('div');
  row.setAttribute('style', 'display:flex;gap:10px;margin-top:16px;');

  if (linkUrl) {
    var openBtn = document.createElement('button');
    openBtn.textContent = btnOpen;
    openBtn.setAttribute('style',
      'flex:1;padding:10px 12px;border:none;border-radius:8px;background:#2563eb;color:#fff;' +
      'font-size:14px;font-weight:600;cursor:pointer;');
    openBtn.onclick = function () {
      window.open(linkUrl, '_blank');
      backdrop.remove();
    };
    row.appendChild(openBtn);
  }

  var closeBtn = document.createElement('button');
  closeBtn.textContent = btnClose;
  closeBtn.setAttribute('style',
    'flex:1;padding:10px 12px;border:none;border-radius:8px;background:#e5e7eb;color:#374151;' +
    'font-size:14px;font-weight:600;cursor:pointer;');
  closeBtn.onclick = function () {
    backdrop.remove();
  };
  row.appendChild(closeBtn);

  box.appendChild(row);
  backdrop.appendChild(box);
  backdrop.addEventListener('click', function (e) {
    if (e.target === backdrop) {
      backdrop.remove();
    }
  });
  document.body.appendChild(backdrop);
}

function showPageOverlay(title, message, linkUrl) {
  var iconUrl = chrome.runtime.getURL('icons/popup-alert.png');
  return chrome.tabs.query({}).then(function (tabs) {
    var tabIds = [];
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      if (!tab.id || !tab.url) {
        continue;
      }
      if (tab.url.indexOf('chrome://') === 0 || tab.url.indexOf('chrome-extension://') === 0) {
        continue;
      }
      if (tab.active) {
        tabIds.push(tab.id);
      }
    }
    if (tabIds.length === 0) {
      for (var j = 0; j < tabs.length; j++) {
        var t = tabs[j];
        if (t.id && t.url && t.url.indexOf('chrome://') !== 0 && t.url.indexOf('chrome-extension://') !== 0) {
          tabIds.push(t.id);
          break;
        }
      }
    }
    var jobs = [];
    for (var k = 0; k < tabIds.length; k++) {
      jobs.push(
        chrome.scripting.executeScript({
          target: { tabId: tabIds[k] },
          func: paintPageOverlay,
          args: [title, message, linkUrl || '', MSG.OVERLAY_TAG, MSG.POPUP_BTN_OPEN, MSG.POPUP_BTN_CLOSE, iconUrl]
        }).catch(function () {})
      );
    }
    return Promise.all(jobs);
  });
}

function getRecentPopupCount(records) {
  return prunePopupRecords(records).length;
}

function prunePopupTimestamps(timestamps) {
  var now = Date.now();
  return (timestamps || []).filter(function (t) {
    return now - t < POPUP_WINDOW_MS;
  });
}

function prunePopupRecords(records) {
  var now = Date.now();
  return (records || []).filter(function (r) {
    return r && now - r.t < POPUP_WINDOW_MS;
  });
}

function migratePopupRecords(data) {
  var records = data.popupAlertRecords || [];
  if (records.length) {
    return prunePopupRecords(records);
  }
  return prunePopupTimestamps(data.popupAlertTimestamps).map(function (t) {
    return { t: t, id: '' };
  });
}

function findTopPopupMonitorId(records) {
  var counts = {};
  var topId = null;
  var topCount = 0;
  for (var i = 0; i < records.length; i++) {
    var id = records[i].id;
    if (!id) {
      continue;
    }
    counts[id] = (counts[id] || 0) + 1;
    if (counts[id] > topCount) {
      topCount = counts[id];
      topId = id;
    }
  }
  return topId;
}

function resolveThrottleTargetMonitorId(settings) {
  var records = settings.popupAlertRecords || [];
  if (!records.length) {
    records = migratePopupRecords({
      popupAlertTimestamps: settings.popupAlertTimestamps
    });
  } else {
    records = prunePopupRecords(records);
  }
  var topId = findTopPopupMonitorId(records);
  if (topId) {
    return topId;
  }
  if (settings.throttleAskMonitorId) {
    return settings.throttleAskMonitorId;
  }
  if (settings.lastThrottlePopupMonitorId) {
    return settings.lastThrottlePopupMonitorId;
  }
  if (settings.monitors && settings.monitors.length === 1) {
    return settings.monitors[0].id;
  }
  return null;
}

function recordPopupAlert(monitorId) {
  popupAlertRecordChain = popupAlertRecordChain.then(function () {
    return chrome.storage.local.get(['popupAlertRecords', 'popupAlertTimestamps']).then(function (data) {
      var records = migratePopupRecords(data);
      records.push({ t: Date.now(), id: monitorId || '' });
      var updates = { popupAlertRecords: records };
      if (monitorId) {
        updates.lastThrottlePopupMonitorId = monitorId;
      }
      return chrome.storage.local.set(updates).then(function () {
        return records.length;
      });
    });
  });
  return popupAlertRecordChain;
}

function shouldShowThrottleAsk(settings, count) {
  if (!settings.popupThrottleAskEnabled) {
    return false;
  }
  if (settings.throttleAskPending) {
    return false;
  }
  if (settings.throttleAskCooldownUntil && Date.now() < settings.throttleAskCooldownUntil) {
    return false;
  }
  return count > POPUP_MAX_BEFORE_ASK;
}

function evaluateThrottleAsk(count) {
  return getSettings().then(function (settings) {
    if (shouldShowThrottleAsk(settings, count)) {
      return showThrottleAskDialog();
    }
  });
}

function showThrottleAskDialog() {
  return getSettings().then(function (settings) {
    if (settings.throttleAskPending) {
      return;
    }
    if (settings.throttleAskCooldownUntil && Date.now() < settings.throttleAskCooldownUntil) {
      return;
    }
    var closePrev = Promise.resolve();
    if (throttleAskWindowId) {
      closePrev = chrome.windows.remove(throttleAskWindowId).catch(function () {});
    }
    return closePrev.then(function () {
      return chrome.windows.create({
        url: chrome.runtime.getURL('alert/ask-throttle.html'),
        type: 'popup',
        width: 520,
        height: 360,
        focused: true
      }).then(function (win) {
        if (win && win.id) {
          throttleAskWindowId = win.id;
        }
        return saveSettings({
          throttleAskPending: true,
          throttleAskMonitorId: resolveThrottleTargetMonitorId(settings)
        });
      });
    }).catch(function (err) {
      console.error('Throttle ask dialog failed', err);
    });
  });
}

function showChromePopups(title, message, linkUrl) {
  showChromeAlertPopup(title, message, linkUrl);
  return showPageOverlay(title, message, linkUrl);
}

function broadcastAlert(options) {
  var level = options.level || 'normal';
  var idPrefix = options.idPrefix || 'alert';
  var title = options.title || '';
  var message = options.message || '';
  var linkUrl = options.linkUrl || '';
  var extra = options.extra || {};
  var skipThrottle = options.skipThrottle || false;

  if (level === 'strong') {
    triggerStrongAlert(linkUrl);
  } else if (level === 'fail') {
    setAttentionBadge('!');
    playAlertSound();
  } else if (level === 'noise') {
    // light alert: system notification only
  }

  showSystemNotification(idPrefix, title, message, extra);

  if (level === 'noise') {
    return;
  }

  return getSettings().then(function (settings) {
    var countPromise = skipThrottle ?
      Promise.resolve(0) :
      recordPopupAlert(options.monitorId || null);

    return countPromise.then(function (count) {
      if (skipThrottle) {
        if (settings.popupsSuppressed) {
          return;
        }
        return showChromePopups(title, message, linkUrl);
      }
      return getSettings().then(function (latest) {
        if (shouldShowThrottleAsk(latest, count)) {
          return showThrottleAskDialog();
        }
        if (latest.popupsSuppressed) {
          return;
        }
        return showChromePopups(title, message, linkUrl);
      });
    });
  });
}

function triggerStrongAlert(url) {
  var shortUrl = truncateUrl(url);
  setAttentionBadge(MSG.BADGE_CHANGED);
  chrome.action.setTitle({ title: MSG.TITLE_CHANGED_PREFIX + shortUrl });
  playAlertSound();
}

function showTestNotification() {
  return broadcastAlert({
    level: 'strong',
    idPrefix: 'test',
    title: MSG.TEST_TITLE,
    message: MSG.TEST_MSG,
    skipThrottle: true
  });
}

function showChangeNotification(monitor, kind) {
  kind = kind || 'content';
  var label = monitorDisplayLabel(monitor);
  var kindLine = kind === 'content' ? MSG.CHANGE_KIND_CONTENT : MSG.CHANGE_KIND_NOISE;
  var bodyLine = kind === 'content' ? MSG.CHANGE_LINE : MSG.NOISE_LINE;
  var title = label + MSG.CHANGE_TITLE_UPDATED;
  var text = [
    '========================',
    bodyLine,
    '========================',
    '',
    kindLine,
    '',
    truncateUrl(monitor.url),
    '',
    MSG.CHANGE_CLICK_JUMP
  ].join('\n');
  return broadcastAlert({
    level: 'strong',
    idPrefix: 'link-changed-' + monitor.number,
    title: title,
    message: text,
    linkUrl: monitor.url,
    monitorId: monitor.id
  });
}

function showNoiseNotification(monitor) {
  var label = monitorDisplayLabel(monitor);
  var text = [
    MSG.NOISE_LINE,
    '',
    truncateUrl(monitor.url),
    '',
    MSG.NOISE_HINT,
    '',
    MSG.CHANGE_CLICK_JUMP
  ].join('\n');
  return broadcastAlert({
    level: 'noise',
    idPrefix: 'link-noise-' + monitor.number,
    title: label + '：' + MSG.NOISE_TITLE,
    message: text,
    linkUrl: monitor.url
  });
}

function getSettings() {
  return chrome.storage.local.get([
    'monitors',
    'monitoringActive',
    'useGlobalInterval',
    'monitoredUrl',
    'lastContent',
    'lastCoreContent',
    'lastRawContent',
    'lastOverlaySignature',
    'checkIntervalMinutes',
    'autoOpenOnStartup',
    'hasAskedAutoOpen',
    'pageUrl',
    'popupThrottleAskEnabled',
    'popupsSuppressed',
    'popupAlertTimestamps',
    'popupAlertRecords',
    'throttleAskCooldownUntil',
    'throttleAskPending',
    'ignoreNoiseAlerts',
    'showMonitorBadges',
    'autoOpenMonitorLink',
    'showPickToolbar'
  ]).then(function (data) {
    var defaultInterval = data.checkIntervalMinutes != null ? data.checkIntervalMinutes : DEFAULT_INTERVAL_MINUTES;
    var monitors = migrateLegacyToMonitors(data);
    monitors = renumberMonitors(monitors.map(function (m, idx) {
      return normalizeMonitorEntry(m, idx + 1, defaultInterval);
    }));
    var monitoringActive = data.monitoringActive || false;
    if (!data.monitors && data.monitoredUrl) {
      monitoringActive = true;
    }
    return {
      monitors: monitors,
      monitoringActive: monitoringActive,
      useGlobalInterval: data.useGlobalInterval !== false,
      monitoredUrl: data.monitoredUrl || null,
      checkIntervalMinutes: defaultInterval,
      autoOpenOnStartup: data.autoOpenOnStartup || false,
      hasAskedAutoOpen: data.hasAskedAutoOpen || false,
      popupThrottleAskEnabled: data.popupThrottleAskEnabled !== false,
      popupsSuppressed: data.popupsSuppressed || false,
      popupAlertTimestamps: migratePopupRecords(data).map(function (r) { return r.t; }),
      popupAlertRecords: migratePopupRecords(data),
      throttleAskCooldownUntil: data.throttleAskCooldownUntil || 0,
      throttleAskPending: data.throttleAskPending === true,
      ignoreNoiseAlerts: data.ignoreNoiseAlerts || false,
      showMonitorBadges: data.showMonitorBadges === true,
      autoOpenMonitorLink: data.autoOpenMonitorLink === true,
      showPickToolbar: data.showPickToolbar === true
    };
  });
}

function saveSettings(updates) {
  return chrome.storage.local.set(updates);
}

function hashString(str) {
  var hash = 5381;
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return hash.toString(36);
}

function normalizeUrl(url) {
  try {
    var parsed = new URL(url);
    var path = parsed.pathname.replace(/\/$/, '') || '/';
    return parsed.origin + path + parsed.search;
  } catch (e) {
    return url.replace(/\/$/, '');
  }
}

function pickBestMonitorTab(tabs, monitorUrl) {
  if (!tabs || !tabs.length) {
    return null;
  }
  var monNorm = normalizeUrl(monitorUrl);
  var pathMatch = null;
  for (var i = 0; i < tabs.length; i++) {
    var tab = tabs[i];
    if (!tab || !tab.url) {
      continue;
    }
    if (normalizeUrl(tab.url) === monNorm) {
      return tab;
    }
    try {
      var a = new URL(tab.url);
      var b = new URL(monitorUrl);
      if (a.origin === b.origin &&
          a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '') &&
          a.search === b.search) {
        pathMatch = tab;
      }
    } catch (e) {}
  }
  return pathMatch;
}

function urlsMatchForMonitor(tabUrl, monitorUrl) {
  var tabNorm = normalizeUrl(tabUrl);
  var monNorm = normalizeUrl(monitorUrl);
  if (tabNorm === monNorm) {
    return true;
  }
  try {
    var a = new URL(tabUrl);
    var b = new URL(monitorUrl);
    if (a.origin === b.origin &&
        a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '') &&
        a.search === b.search) {
      return true;
    }
  } catch (e) {}
  return false;
}

function extractFingerprintsFromTab(tab) {
  return chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAGE_FINGERPRINT' }).then(function (res) {
    if (res && res.ok && res.fingerprints) {
      return res.fingerprints;
    }
    return chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/portal-extract.js']
    }).then(function (results) {
      if (results && results[0] && results[0].result) {
        return results[0].result;
      }
      return chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractPageFingerprintsInPage
      }).then(function (innerResults) {
        if (innerResults && innerResults[0] && innerResults[0].result) {
          return innerResults[0].result;
        }
        return null;
      });
    });
  }).catch(function () {
    return chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/portal-extract.js']
    }).then(function (results) {
      if (results && results[0] && results[0].result) {
        return results[0].result;
      }
      return chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractPageFingerprintsInPage
      }).then(function (innerResults) {
        if (innerResults && innerResults[0] && innerResults[0].result) {
          return innerResults[0].result;
        }
        return null;
      });
    }).catch(function () {
      return null;
    });
  });
}

var PORTAL_TAB_QUERY_PATTERNS = [
  '*://*.ahtba.org.cn/*',
  '*://ahtba.org.cn/*',
  '*://ggzy.hefei.gov.cn/*',
  '*://*.ggzy.hefei.gov.cn/*'
];

function findPortalTabs(monitorUrl) {
  return chrome.tabs.query({ url: PORTAL_TAB_QUERY_PATTERNS }).then(function (tabs) {
    var matched = [];
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      if (!t.url) {
        continue;
      }
      if (urlsMatchForMonitor(t.url, monitorUrl)) {
        matched.push(t);
      }
    }
    return matched;
  });
}

function ensurePortalMonitorTab(url, options) {
  options = options || {};
  var createIfMissing = options.createIfMissing !== false;
  if (!isHighSensitivityUrl(url)) {
    return Promise.resolve(null);
  }
  return findPortalTabs(url).then(function (tabs) {
    var best = pickBestMonitorTab(tabs, url);
    if (best) {
      return best;
    }
    if (!createIfMissing) {
      return null;
    }
    return chrome.tabs.create({ url: url, active: false }).then(function (tab) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(tab);
        }, 2500);
      });
    });
  });
}

function fetchPageContentFromOpenTab(url) {
  return findPortalTabs(url).then(function (portalTabs) {
    var best = pickBestMonitorTab(portalTabs, url);
    if (best) {
      return extractFingerprintsFromTab(best);
    }
    return chrome.tabs.query({ url: PORTAL_TAB_QUERY_PATTERNS }).then(function (allTabs) {
      best = pickBestMonitorTab(allTabs, url);
      if (best) {
        return extractFingerprintsFromTab(best);
      }
      return null;
    });
  });
}

function fetchPageContentViaHttp(url) {
  var referer = url;
  try {
    referer = new URL(url).origin + '/';
  } catch (e) {}
  return fetch(url, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': referer
    }
  }).then(function (response) {
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    return response.text();
  }).then(function (html) {
    return analyzeFetchedHtml(html, url);
  });
}

function fetchPageContentViaHttpWithRetry(url, retriesLeft, attempt) {
  attempt = attempt || 0;
  return fetchPageContentViaHttp(url).catch(function (err) {
    if (retriesLeft > 0 && isTransientFetchError(err)) {
      var delay = FETCH_RETRY_DELAY_MS + attempt * 1500;
      return new Promise(function (resolve) {
        setTimeout(resolve, delay);
      }).then(function () {
        return fetchPageContentViaHttpWithRetry(url, retriesLeft - 1, attempt + 1);
      });
    }
    throw err;
  });
}

function fetchPageContent(url) {
  url = migrateLegacyMonitorUrl(url);
  if (isHighSensitivityUrl(url)) {
    return getSettings().then(function (settings) {
      return fetchPageContentFromOpenTab(url).then(function (fingerprints) {
        if (fingerprints) {
          return tagFingerprints(fingerprints, 'tab');
        }
        if (settings.autoOpenMonitorLink) {
          return ensurePortalMonitorTab(url, { createIfMissing: true }).then(function () {
            return fetchPageContentFromOpenTab(url);
          }).then(function (fp2) {
            if (fp2) {
              return tagFingerprints(fp2, 'tab');
            }
            return null;
          });
        }
        return null;
      }).then(function (fingerprints) {
        if (fingerprints) {
          return fingerprints;
        }
        return fetchPageContentViaHttpWithRetry(url, FETCH_RETRY_COUNT).catch(function (fetchError) {
          var statusMatch = fetchError && fetchError.message ? fetchError.message.match(/HTTP (\d+)/) : null;
          var status = statusMatch ? parseInt(statusMatch[1], 10) : null;
          var hint = buildFetchErrorHint(status);
          var msg = fetchError && fetchError.message ? fetchError.message : MSG.REQUEST_FAIL;
          throw new Error(msg + hint + MSG.PORTAL_TAB_HINT);
        }).then(function (fp) {
          return tagFingerprints(fp, 'http');
        });
      });
    });
  }

  var retryCount = FETCH_RETRY_COUNT;
  return fetchPageContentViaHttpWithRetry(url, retryCount).then(function (fp) {
    return tagFingerprints(fp, 'http');
  }).catch(function (fetchError) {
    return fetchPageContentFromOpenTab(url).then(function (fingerprints) {
      if (fingerprints) {
        return tagFingerprints(fingerprints, 'tab');
      }
      var statusMatch = fetchError && fetchError.message ? fetchError.message.match(/HTTP (\d+)/) : null;
      var status = statusMatch ? parseInt(statusMatch[1], 10) : null;
      var hint = buildFetchErrorHint(status);
      var msg = fetchError && fetchError.message ? fetchError.message : MSG.REQUEST_FAIL;
      throw new Error(msg + hint);
    });
  });
}

function splitPortalCoreParts(core) {
  var listMarker = 'LIST::';
  var bodyMarker = '\nBODY::';
  if (core && core.indexOf(listMarker) === 0 && core.indexOf(bodyMarker) > 0) {
    var idx = core.indexOf(bodyMarker);
    return {
      list: core.slice(listMarker.length, idx),
      body: core.slice(idx + bodyMarker.length)
    };
  }
  return { list: '', body: core || '' };
}

function fingerprintHashes(fingerprints) {
  var parts = splitPortalCoreParts(fingerprints.core || '');
  var bodyCore = parts.body || fingerprints.core || '';
  return {
    coreHash: hashString(bodyCore),
    coreListHash: hashString(parts.list),
    rawHash: hashString(fingerprints.raw || ''),
    overlayHash: hashString(fingerprints.overlaySignature || '')
  };
}

function snapshotBaselineExtra(fingerprints) {
  return {
    lastCoreSnippet: getBodyCoreText(fingerprints).slice(0, CORE_SNIPPET_MAX),
    lastFetchSource: (fingerprints && fingerprints._source) || ''
  };
}

function tagFingerprints(fingerprints, source) {
  if (fingerprints) {
    fingerprints._source = source;
  }
  return fingerprints;
}

function saveMonitorBaseline(monitorId, hashes, extra) {
  extra = extra || {};
  if (lifecycleStopRequested) {
    return Promise.resolve();
  }
  return getSettings().then(function (settings) {
    var monitors = settings.monitors.map(function (m) {
      if (m.id !== monitorId) {
        return m;
      }
      return Object.assign({}, m, {
        lastCoreContent: hashes.coreHash,
        lastRawContent: hashes.rawHash,
        lastOverlaySignature: hashes.overlayHash,
        lastCheckAt: extra.lastCheckAt != null ? extra.lastCheckAt : m.lastCheckAt,
        coreBaselineVersion: extra.coreBaselineVersion != null ?
          extra.coreBaselineVersion : (m.coreBaselineVersion || 0),
        lastCoreSnippet: extra.lastCoreSnippet != null ? extra.lastCoreSnippet : (m.lastCoreSnippet || ''),
        lastFetchSource: extra.lastFetchSource != null ? extra.lastFetchSource : (m.lastFetchSource || '')
      }, extra);
    });
    return saveSettings({ monitors: monitors });
  });
}

function findMonitorByUrl(monitors, url) {
  var target = normalizeMonitorUrl(url);
  for (var i = 0; i < monitors.length; i++) {
    if (normalizeMonitorUrl(monitors[i].url) === target) {
      return monitors[i];
    }
  }
  return null;
}

function logCheckResult(kind, detail) {
  if (kind === 'content') {
    console.info(MSG.LOG_CHECK_CONTENT, detail || '');
  } else if (kind === 'noise') {
    console.info(MSG.LOG_CHECK_NOISE, detail || '');
  } else if (kind === 'noise-skip') {
    console.info(MSG.LOG_CHECK_NOISE_SKIP, detail || '');
  } else if (kind === 'same') {
    console.info(MSG.LOG_CHECK_SAME, detail || '');
  } else {
    console.info(MSG.LOG_CHECK_OK, detail || '');
  }
}

function askAutoOpenOnStartup() {
  broadcastAlert({
    level: 'normal',
    idPrefix: 'ask-auto-open',
    title: MSG.ASK_OPEN_TITLE,
    message: MSG.ASK_OPEN_MSG,
    extra: {
      buttons: [
        { title: MSG.BTN_YES },
        { title: MSG.BTN_NO }
      ]
    }
  });
}

function showRegisteredNotification(count, firstUrl) {
  if (!shouldShowLifecycleNotification()) {
    return;
  }
  var title = count > 1 ? MSG.REG_TITLE_MULTI : MSG.REG_TITLE;
  var message = count > 1 ?
    MSG.REG_MSG_MULTI_PREFIX.replace('%d', String(count)) :
    MSG.REG_MSG_PREFIX + truncateUrl(firstUrl);
  broadcastAlert({
    level: 'normal',
    idPrefix: 'link-registered',
    title: title,
    message: message,
    linkUrl: firstUrl || ''
  });
}

function startMonitorsFromItems(items, useGlobalInterval, globalIntervalMinutes, options) {
  options = options || {};
  useGlobalInterval = useGlobalInterval !== false;
  globalIntervalMinutes = globalIntervalMinutes != null ? globalIntervalMinutes : DEFAULT_INTERVAL_MINUTES;
  return queueStartOp(function () {
    var opGen = lifecycleGeneration;
    return getSettings().then(function (prev) {
      if (!isLifecycleOpCurrent(opGen)) {
        return { ok: false, aborted: true };
      }
      var existing = prev.monitors || [];
      var monitors = [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var url = migrateLegacyMonitorUrl(normalizeMonitorUrl(item.url));
        if (!url) {
          continue;
        }
        var pageUrl = normalizeMonitorUrl(item.pageUrl || url);
        var name = (item.name || '').trim();
        var old = findMonitorByUrl(existing, url);
        var intervalMinutes;
        if (useGlobalInterval) {
          intervalMinutes = old && old.intervalMinutes != null ?
            old.intervalMinutes : globalIntervalMinutes;
        } else {
          intervalMinutes = item.intervalMinutes || globalIntervalMinutes;
        }
        monitors.push(normalizeMonitorEntry({
          id: old ? old.id : createMonitorId(),
          url: url,
          name: name || (old ? old.name : ''),
          pageUrl: pageUrl,
          intervalMinutes: intervalMinutes,
          throttleIntervalMinutes: old ? old.throttleIntervalMinutes : 0,
          lastCoreContent: old ? old.lastCoreContent : null,
          lastRawContent: old ? old.lastRawContent : null,
          lastOverlaySignature: old ? old.lastOverlaySignature : '',
          lastCheckAt: old ? old.lastCheckAt : 0
        }, monitors.length + 1, globalIntervalMinutes));
      }
      monitors = renumberMonitors(monitors);
      if (!monitors.length) {
        return { ok: false, error: 'no valid urls' };
      }
      if (!isLifecycleOpCurrent(opGen)) {
        return { ok: false, aborted: true };
      }
      return saveSettings({
        monitors: monitors,
        monitoringActive: true,
        useGlobalInterval: useGlobalInterval,
        checkIntervalMinutes: globalIntervalMinutes,
        monitoredUrl: null,
        lastContent: null,
        lastCoreContent: null,
        lastRawContent: null,
        lastOverlaySignature: null,
        pageUrl: null
      }).then(function () {
        if (!isLifecycleOpCurrent(opGen)) {
          return saveSettings({ monitoringActive: false }).then(function () {
            return { ok: false, aborted: true };
          });
        }
        return rescheduleAlarmFromSettings();
      }).then(function (result) {
        if (result && result.aborted) {
          return result;
        }
        if (!isLifecycleOpCurrent(opGen)) {
          return { ok: false, aborted: true };
        }
        var portalPrep = [];
        for (var pj = 0; pj < monitors.length; pj++) {
          if (isHighSensitivityUrl(monitors[pj].url) && prev.autoOpenMonitorLink) {
            portalPrep.push(ensurePortalMonitorTab(monitors[pj].url, { createIfMissing: true }));
          }
        }
        return Promise.all(portalPrep).then(function () {
          return checkAllMonitors(true);
        });
      }).then(function (checkResult) {
        if (checkResult && checkResult.aborted) {
          return checkResult;
        }
        return isMonitoringStillActive().then(function (stillActive) {
          if (!stillActive || !isLifecycleOpCurrent(opGen)) {
            return { ok: true, aborted: true };
          }
          if (checkResult.ok && !options.silent) {
            showRegisteredNotification(monitors.length, monitors[0].url);
          }
          if (!prev.hasAskedAutoOpen && checkResult.ok && shouldShowLifecycleNotification() && !options.silent) {
            askAutoOpenOnStartup();
            return saveSettings({ hasAskedAutoOpen: true });
          }
        }).then(function () {
          if (!isLifecycleOpCurrent(opGen)) {
            return { ok: true, aborted: true };
          }
          return { ok: true, count: monitors.length, url: monitors[0].url };
        });
      });
    });
  });
}

function registerLink(url, pageUrl, name, options) {
  options = options || {};
  url = migrateLegacyMonitorUrl(normalizeMonitorUrl(url));
  pageUrl = normalizeMonitorUrl(pageUrl || url);
  name = (name || '').trim();
  return syncSessionPicked(url, pageUrl, name).then(function () {
    return getSettings().then(function (settings) {
    var existing = findMonitorByUrl(settings.monitors, url);
    if (existing) {
      var monitors = settings.monitors.map(function (m) {
        if (m.id !== existing.id) {
          return m;
        }
        return Object.assign({}, m, {
          url: url,
          pageUrl: pageUrl,
          name: name || m.name
        });
      });
      if (!settings.monitoringActive) {
        return startMonitorsFromItems(
          [{
            url: url,
            pageUrl: pageUrl,
            name: name || existing.name,
            intervalMinutes: existing.intervalMinutes
          }],
          settings.useGlobalInterval,
          settings.checkIntervalMinutes,
          { silent: options.silent }
        ).then(function (result) {
          return syncSessionPicked(url, pageUrl, name || existing.name).then(function () {
            return Object.assign({ updated: true }, result);
          });
        });
      }
      return saveSettings({
        monitors: monitors,
        monitoringActive: true
      }).then(function () {
        return rescheduleAlarmFromSettings();
      }).then(function () {
        if (settings.autoOpenMonitorLink) {
          return ensurePortalMonitorTab(url, { createIfMissing: true });
        }
      }).then(function () {
        return getSettings().then(function (fresh) {
          var mon = findMonitorByUrl(fresh.monitors, url);
          if (mon) {
            return checkSingleMonitor(mon, fresh, true);
          }
        });
      }).then(function () {
        return syncSessionPicked(url, pageUrl, name || existing.name).then(function () {
          return { ok: true, url: url, updated: true };
        });
      });
    }
    if (!settings.monitoringActive) {
      return startMonitorsFromItems(
        [{
          url: url,
          pageUrl: pageUrl,
          name: name,
          intervalMinutes: settings.checkIntervalMinutes
        }],
        settings.useGlobalInterval,
        settings.checkIntervalMinutes,
        { silent: options.silent }
      ).then(function (result) {
        return syncSessionPicked(url, pageUrl, name).then(function () {
          return Object.assign({ added: true }, result);
        });
      });
    }
    var items = settings.monitors.map(function (m) {
      return {
        url: m.url,
        pageUrl: m.pageUrl,
        name: m.name,
        intervalMinutes: m.intervalMinutes
      };
    });
    items.push({
      url: url,
      pageUrl: pageUrl,
      name: name,
      intervalMinutes: settings.checkIntervalMinutes
    });
    return startMonitorsFromItems(
      items,
      settings.useGlobalInterval,
      settings.checkIntervalMinutes,
      { silent: options.silent }
    ).then(function (result) {
      return syncSessionPicked(url, pageUrl, name).then(function () {
        return Object.assign({ added: true }, result);
      });
    });
    });
  });
}

function clearAllCheckAlarms() {
  return chrome.alarms.clear(ALARM_NAME).then(function () {
    return chrome.alarms.clear(FAST_ALARM_NAME);
  });
}

function buildClearedMonitorStorage() {
  return {
    monitors: [],
    monitoringActive: false,
    monitoredUrl: null,
    lastContent: null,
    lastCoreContent: null,
    lastRawContent: null,
    lastOverlaySignature: null,
    pageUrl: null
  };
}

function saveEmptyMonitorState() {
  return clearAllCheckAlarms().then(function () {
    return clearAttentionBadge();
  }).then(function () {
    return saveSettings(buildClearedMonitorStorage());
  });
}

function showStoppedNotification(clearedAll) {
  if (!shouldShowLifecycleNotification()) {
    return;
  }
  clearAttentionBadge();
  broadcastAlert({
    level: 'normal',
    idPrefix: 'link-stopped',
    title: MSG.STOP_TITLE,
    message: clearedAll ? MSG.STOP_MSG_MULTI : MSG.STOP_MSG
  });
}

function showCheckFailedNotification(url, message, monitorId) {
  var key = normalizeMonitorUrl(url) || url || '';
  var now = Date.now();
  if (checkFailNotifyAt[key] && now - checkFailNotifyAt[key] < CHECK_FAIL_NOTIFY_COOLDOWN_MS) {
    console.warn(MSG.LOG_CHECK_FAIL, message, '(notification suppressed)');
    return;
  }
  checkFailNotifyAt[key] = now;
  broadcastAlert({
    level: 'fail',
    idPrefix: 'link-check-failed',
    title: MSG.FAIL_TITLE,
    message: message + '\n' + truncateUrl(url),
    linkUrl: url,
    monitorId: monitorId || null
  });
}

var AHTBA_URL_PATTERNS = [
  '*://*.ahtba.org.cn/*',
  '*://ahtba.org.cn/*',
  '*://ggzy.hefei.gov.cn/*',
  '*://*.ggzy.hefei.gov.cn/*'
];
var PORTAL_HOST_MARKERS = ['ahtba.org.cn', 'ggzy.hefei.gov.cn'];

function isPortalMonitorHost(tabUrl) {
  if (!tabUrl) {
    return false;
  }
  for (var i = 0; i < PORTAL_HOST_MARKERS.length; i++) {
    if (tabUrl.indexOf(PORTAL_HOST_MARKERS[i]) !== -1) {
      return true;
    }
  }
  return false;
}
var SESSION_PICKED_URL_KEY = 'lastPickedMonitorUrl';
var SESSION_PICKED_LABEL_KEY = 'lastPickedMonitorLabel';
var SESSION_PICKED_PAGE_KEY = 'lastPickedMonitorPage';

function normalizeMonitorUrl(url) {
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

function migrateLegacyMonitorUrl(url) {
  if (!url || url.indexOf('httpbin.org') === -1) {
    return url;
  }
  try {
    var parsed = new URL(url);
    if (parsed.hostname === 'httpbin.org' || parsed.hostname.endsWith('.httpbin.org')) {
      parsed.hostname = 'httpbingo.org';
      return normalizeMonitorUrl(parsed.href);
    }
  } catch (e) {}
  return normalizeMonitorUrl(url.replace(/httpbin\.org/g, 'httpbingo.org'));
}

function ensureStorageMigrated() {
  return chrome.storage.local.get([
    'monitors',
    'monitoredUrl',
    'lastCoreContent',
    'lastRawContent',
    'lastOverlaySignature',
    'lastContent',
    'pageUrl',
    'checkIntervalMinutes'
  ]).then(function (data) {
    if (data.monitors && data.monitors.length) {
      return data;
    }
    if (!data.monitoredUrl) {
      return data;
    }
    var monitors = migrateLegacyToMonitors(data);
    var migratedUrl = migrateLegacyMonitorUrl(data.monitoredUrl);
    if (migratedUrl !== data.monitoredUrl) {
      monitors[0].url = migratedUrl;
      monitors[0].lastCoreContent = null;
      monitors[0].lastRawContent = null;
      monitors[0].lastOverlaySignature = '';
    }
    return saveSettings({
      monitors: monitors,
      monitoringActive: true,
      monitoredUrl: null,
      lastContent: null,
      lastCoreContent: null,
      lastRawContent: null,
      lastOverlaySignature: null,
      pageUrl: null
    }).then(function () {
      console.info('migrated legacy single monitor to multi-monitor storage');
      return data;
    });
  });
}

function rescheduleAlarmFromSettings() {
  return getSettings().then(function (settings) {
    var interval = computeAlarmIntervalMinutes(settings);
    return scheduleAlarm(interval);
  });
}

function getActiveTab() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab || !tab.url) {
      return null;
    }
    if (isBrowserInternalUrl(tab.url)) {
      return null;
    }
    return tab;
  });
}

function isBrowserInternalUrl(url) {
  if (!url) {
    return true;
  }
  return url.indexOf('chrome://') === 0 ||
    url.indexOf('chrome-extension://') === 0 ||
    url.indexOf('edge://') === 0 ||
    url.indexOf('about:') === 0;
}

function normalizeUserEnteredUrl(text) {
  var trimmed = (text || '').trim();
  if (!trimmed) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^[\w-]+(\.[\w-]+)+/.test(trimmed) || trimmed.indexOf('/') >= 0) {
    return 'https://' + trimmed;
  }
  return null;
}

function monitorActiveTabUrl() {
  return getActiveTab().then(function (tab) {
    if (!tab) {
      return { ok: false, error: MSG.OMNIBOX_NO_TAB };
    }
    return registerLink(normalizeMonitorUrl(tab.url), tab.url);
  });
}

function getPickedMonitorUrlForTab(tabUrl) {
  return chrome.storage.local.get(['linkMonitorPickedSession']).then(function (data) {
    var session = data.linkMonitorPickedSession || {};
    var picked = session[SESSION_PICKED_URL_KEY];
    var label = session[SESSION_PICKED_LABEL_KEY] || '';
    var pickedPage = session[SESSION_PICKED_PAGE_KEY];
    if (!picked || !tabUrl) {
      return { url: null, label: '' };
    }
    try {
      var tabOrigin = new URL(tabUrl).origin;
      if (pickedPage) {
        if (new URL(pickedPage).origin !== tabOrigin) {
          return { url: null, label: '' };
        }
      } else if (new URL(picked).origin !== tabOrigin) {
        return { url: null, label: '' };
      }
      return { url: picked, label: label };
    } catch (e) {
      return { url: null, label: '' };
    }
  });
}

function syncSessionPicked(url, pageUrl, label) {
  var payload = {
    [SESSION_PICKED_URL_KEY]: normalizeMonitorUrl(url),
    [SESSION_PICKED_LABEL_KEY]: label || '',
    [SESSION_PICKED_PAGE_KEY]: normalizeMonitorUrl(pageUrl || url)
  };
  return chrome.storage.local.set({ linkMonitorPickedSession: payload });
}

function setupContextMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: 'monitor-enable',
      title: MSG.MENU_ENABLE,
      contexts: ['link']
    });
    chrome.contextMenus.create({
      id: 'monitor-disable',
      title: MSG.MENU_DISABLE,
      contexts: ['link']
    });
    chrome.contextMenus.create({
      id: 'monitor-enable-selection',
      title: MSG.MENU_ENABLE_SELECTION,
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'monitor-enable-page',
      title: MSG.MENU_ENABLE_PAGE,
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'monitor-disable-page',
      title: MSG.MENU_DISABLE,
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'monitor-enable-action',
      title: MSG.MENU_ENABLE_PAGE,
      contexts: ['action']
    });
    chrome.contextMenus.create({
      id: 'monitor-enable-picked',
      title: MSG.MENU_ENABLE_PICKED,
      contexts: ['page'],
      documentUrlPatterns: AHTBA_URL_PATTERNS
    });
  });
}

function setupOmnibox() {
  chrome.omnibox.onInputStarted.addListener(function () {
    chrome.omnibox.setDefaultSuggestion({
      description: MSG.OMNIBOX_DEFAULT
    });
  });

  chrome.omnibox.onInputChanged.addListener(function (text, suggest) {
    var trimmed = (text || '').trim();
    var suggestions = [];
    if (trimmed) {
      suggestions.push({
        content: trimmed,
        description: MSG.OMNIBOX_ENTER_URL.replace('%s', trimmed)
      });
    } else {
      suggestions.push({
        content: ' ',
        description: MSG.OMNIBOX_CURRENT_TAB
      });
    }
    suggest({ descriptions: suggestions });
  });

  chrome.omnibox.onInputEntered.addListener(function (text) {
    var trimmed = (text || '').trim();
    if (trimmed) {
      var url = normalizeUserEnteredUrl(trimmed);
      if (!url) {
        broadcastAlert({
          level: 'normal',
          idPrefix: 'omnibox-bad-url',
          title: MSG.FAIL_TITLE,
          message: MSG.OMNIBOX_BAD_URL,
          skipThrottle: true
        });
        return;
      }
      registerLink(normalizeMonitorUrl(url), url);
      return;
    }
    monitorActiveTabUrl().then(function (result) {
      if (!result || !result.ok) {
        broadcastAlert({
          level: 'normal',
          idPrefix: 'omnibox-no-tab',
          title: MSG.FAIL_TITLE,
          message: (result && result.error) || MSG.OMNIBOX_NO_TAB,
          skipThrottle: true
        });
      }
    });
  });
}

function scheduleAlarm(intervalMinutes) {
  return clearAllCheckAlarms().then(function () {
    if (intervalMinutes > 0 && intervalMinutes < MIN_PERIODIC_ALARM_MINUTES) {
      return chrome.alarms.create(FAST_ALARM_NAME, { delayInMinutes: intervalMinutes });
    }
    if (intervalMinutes >= MIN_PERIODIC_ALARM_MINUTES) {
      return chrome.alarms.create(ALARM_NAME, { periodInMinutes: intervalMinutes });
    }
  });
}

function rescheduleFastAlarmIfNeeded() {
  return getSettings().then(function (settings) {
    var interval = computeAlarmIntervalMinutes(settings);
    if (interval > 0 && interval < MIN_PERIODIC_ALARM_MINUTES) {
      return chrome.alarms.create(FAST_ALARM_NAME, { delayInMinutes: interval });
    }
  });
}

function readCoreFingerprintsForUrl(url) {
  return fetchPageContent(url).then(function (fingerprints) {
    try {
      fingerprints = finalizeFingerprints(fingerprints, new URL(url).hostname);
    } catch (e) {}
    if (!fingerprints || !fingerprints.core) {
      return null;
    }
    return {
      hashes: fingerprintHashes(fingerprints),
      bodyText: getBodyCoreText(fingerprints),
      fingerprints: fingerprints
    };
  });
}

function confirmCoreContentChange(monitor, url, firstHashes, firstBodyText) {
  if (isHighChurnTestUrl(url)) {
    return Promise.resolve({
      confirmed: true,
      hashes: firstHashes,
      bodyText: firstBodyText
    });
  }

  function delay() {
    return new Promise(function (resolve) {
      setTimeout(resolve, CORE_CONFIRM_DELAY_MS);
    });
  }

  var baseline = monitor.lastCoreContent;

  function evaluateSamples(sample2, sample3) {
    var h1 = firstHashes.coreHash;
    var h2 = sample2.hashes.coreHash;
    var h3 = sample3.hashes.coreHash;

    if (h2 === baseline || h3 === baseline) {
      return { confirmed: false, transient: true, hashes: sample3.hashes, bodyText: sample3.bodyText };
    }
    if (monitor.lastCoreSnippet && isLikelySameBodyContent(monitor.lastCoreSnippet, sample3.bodyText)) {
      return { confirmed: false, transient: true, hashes: sample3.hashes, bodyText: sample3.bodyText };
    }
    if (h1 === h2 && h2 === h3) {
      return {
        confirmed: true,
        hashes: sample3.hashes,
        bodyText: sample3.bodyText,
        fingerprints: sample3.fingerprints
      };
    }
    if (h2 === h3 && h2 !== baseline) {
      return {
        confirmed: true,
        hashes: sample3.hashes,
        bodyText: sample3.bodyText,
        fingerprints: sample3.fingerprints
      };
    }
    if (h1 !== baseline && h2 !== baseline && h3 !== baseline &&
        firstHashes.rawHash !== monitor.lastRawContent) {
      return {
        confirmed: true,
        hashes: sample3.hashes,
        bodyText: sample3.bodyText,
        fingerprints: sample3.fingerprints,
        churning: true
      };
    }
    return { confirmed: false, inconsistent: true, hashes: sample3.hashes, bodyText: sample3.bodyText };
  }

  return delay().then(function () {
    if (lifecycleStopRequested) {
      return { aborted: true };
    }
    return readCoreFingerprintsForUrl(url).then(function (sample2) {
      if (!sample2) {
        return { confirmed: false, inconsistent: true };
      }
      if (sample2.hashes.coreHash === baseline) {
        return { confirmed: false, transient: true, hashes: sample2.hashes, bodyText: sample2.bodyText };
      }
      return delay().then(function () {
        if (lifecycleStopRequested) {
          return { aborted: true };
        }
        return readCoreFingerprintsForUrl(url).then(function (sample3) {
          if (!sample3) {
            return { confirmed: false, inconsistent: true };
          }
          return evaluateSamples(sample2, sample3);
        });
      });
    });
  });
}

function silentRebaseline(monitorId, hashes, fingerprints, now, url, label, note) {
  var snap = snapshotBaselineExtra(fingerprints);
  return saveMonitorBaseline(monitorId, hashes, Object.assign({
    lastCheckAt: now,
    url: url,
    coreBaselineVersion: CORE_BASELINE_VERSION
  }, snap)).then(function () {
    logCheckResult('same', label + ' ' + note + ' ' + truncateUrl(url));
    return { ok: true, changed: false, kind: 'false-positive-skip', monitorId: monitorId };
  });
}

function checkSingleMonitor(monitor, settings, isInitial) {
  if (lifecycleStopRequested) {
    return Promise.resolve({ ok: true, changed: false, kind: 'aborted', monitorId: monitor.id });
  }
  var url = migrateLegacyMonitorUrl(monitor.url);
  return fetchPageContent(url).then(function (fingerprints) {
    try {
      fingerprints = finalizeFingerprints(fingerprints, new URL(url).hostname);
    } catch (e) {}
    if (lifecycleStopRequested) {
      return { ok: true, changed: false, kind: 'aborted', monitorId: monitor.id };
    }
    var now = Date.now();
    var label = monitorDisplayLabel(monitor);

    if (!fingerprints || !fingerprints.core) {
      if (isHighSensitivityUrl(url)) {
        return getSettings().then(function (settings) {
          var monitors = settings.monitors.map(function (m) {
            if (m.id !== monitor.id) {
              return m;
            }
            return Object.assign({}, m, { lastCheckAt: now, url: url });
          });
          return saveSettings({ monitors: monitors }).then(function () {
            logCheckResult('same', label + ' 页面加载中，跳过本次');
            return { ok: true, changed: false, kind: 'skipped', monitorId: monitor.id };
          });
        });
      }
      throw new Error(MSG.REQUEST_FAIL + MSG.PORTAL_TAB_HINT);
    }

    var hashes = fingerprintHashes(fingerprints);
    var urlKey = normalizeMonitorUrl(url);
    if (urlKey) {
      delete checkFailNotifyAt[urlKey];
    }

    if (monitor.lastCoreContent === null) {
      return saveMonitorBaseline(monitor.id, hashes, Object.assign({
        lastCheckAt: now,
        url: url,
        coreBaselineVersion: CORE_BASELINE_VERSION
      }, snapshotBaselineExtra(fingerprints))).then(function () {
        logCheckResult('baseline', label + ' ' + truncateUrl(url));
        return { ok: true, changed: false, kind: 'baseline', monitorId: monitor.id };
      });
    }

    var baselineVersion = monitor.coreBaselineVersion || 0;
    if (baselineVersion < CORE_BASELINE_VERSION) {
      return saveMonitorBaseline(monitor.id, hashes, Object.assign({
        lastCheckAt: now,
        url: url,
        coreBaselineVersion: CORE_BASELINE_VERSION
      }, snapshotBaselineExtra(fingerprints))).then(function () {
        logCheckResult('baseline', label + ' 指纹算法已升级，已静默更新基准');
        return { ok: true, changed: false, kind: 'baseline-migrate', monitorId: monitor.id };
      });
    }

    var coreChanged = hashes.coreHash !== monitor.lastCoreContent;
    var rawChanged = hashes.rawHash !== monitor.lastRawContent;
    var overlayChanged = hashes.overlayHash !== monitor.lastOverlaySignature &&
      hashes.overlayHash !== hashString('');
    var bodyText = getBodyCoreText(fingerprints);
    var fetchSource = fingerprints._source || '';

    if (coreChanged) {
      if (isHighChurnTestUrl(url)) {
        return saveMonitorBaseline(monitor.id, hashes, Object.assign({
          lastCheckAt: now,
          url: url,
          coreBaselineVersion: CORE_BASELINE_VERSION
        }, snapshotBaselineExtra(fingerprints))).then(function () {
          logCheckResult('content', label + ' [测试链] ' + truncateUrl(url));
          var updated = Object.assign({}, monitor, {
            url: url,
            lastCoreContent: hashes.coreHash,
            lastRawContent: hashes.rawHash,
            lastOverlaySignature: hashes.overlayHash
          });
          showChangeNotification(updated, 'content');
          return { ok: true, changed: true, kind: 'content', monitorId: monitor.id };
        });
      }
      if (monitor.lastFetchSource && fetchSource &&
          monitor.lastFetchSource !== fetchSource && !rawChanged) {
        return silentRebaseline(
          monitor.id, hashes, fingerprints, now, url, label, '抓取来源切换已对齐基准'
        );
      }
      if (monitor.lastCoreSnippet && isLikelySameBodyContent(monitor.lastCoreSnippet, bodyText)) {
        return silentRebaseline(
          monitor.id, hashes, fingerprints, now, url, label, '正文高度相似已忽略'
        );
      }
      if (!rawChanged) {
        return silentRebaseline(
          monitor.id, hashes, fingerprints, now, url, label, '仅正文提取差异已忽略'
        );
      }
      return confirmCoreContentChange(monitor, url, hashes, bodyText).then(function (confirmResult) {
        if (confirmResult.aborted) {
          return { ok: true, changed: false, kind: 'aborted', monitorId: monitor.id };
        }
        if (confirmResult.transient || confirmResult.inconsistent) {
          var fp = confirmResult.fingerprints || fingerprints;
          var h = confirmResult.hashes || hashes;
          return silentRebaseline(
            monitor.id, h, fp, now, url, label,
            confirmResult.inconsistent ? '多次读取不一致已忽略' : '瞬态差异已忽略'
          );
        }
        var confirmedHashes = confirmResult.hashes || hashes;
        var confirmedFp = confirmResult.fingerprints || fingerprints;
        return saveMonitorBaseline(monitor.id, confirmedHashes, Object.assign({
          lastCheckAt: now,
          url: url,
          coreBaselineVersion: CORE_BASELINE_VERSION
        }, snapshotBaselineExtra(confirmedFp))).then(function () {
          logCheckResult('content', label + ' ' + truncateUrl(url));
          var updated = Object.assign({}, monitor, {
            url: url,
            lastCoreContent: confirmedHashes.coreHash,
            lastRawContent: confirmedHashes.rawHash,
            lastOverlaySignature: confirmedHashes.overlayHash
          });
          showChangeNotification(updated, 'content');
          return { ok: true, changed: true, kind: 'content', monitorId: monitor.id };
        });
      });
    }

    if (rawChanged || overlayChanged) {
      var noiseUpdates = {
        lastRawContent: hashes.rawHash,
        lastOverlaySignature: hashes.overlayHash,
        lastCheckAt: now,
        url: url
      };
      if (settings.ignoreNoiseAlerts) {
        return saveMonitorBaseline(monitor.id, hashes, noiseUpdates).then(function () {
          logCheckResult('noise-skip', label + ' ' + truncateUrl(url));
          return { ok: true, changed: false, kind: 'noise', ignored: true, monitorId: monitor.id };
        });
      }
      return saveMonitorBaseline(monitor.id, hashes, noiseUpdates).then(function () {
        logCheckResult('noise', label + ' ' + truncateUrl(url));
        var updated = Object.assign({}, monitor, noiseUpdates);
        showNoiseNotification(updated);
        return { ok: true, changed: false, kind: 'noise', noise: true, monitorId: monitor.id };
      });
    }

    return saveMonitorBaseline(monitor.id, hashes, Object.assign({
      lastCheckAt: now,
      url: url
    }, snapshotBaselineExtra(fingerprints))).then(function () {
      logCheckResult('same', label + ' ' + truncateUrl(url));
      return { ok: true, changed: false, kind: 'same', monitorId: monitor.id };
    });
  }).catch(function (err) {
    var portal = isHighSensitivityUrl(url);
    var transient = portal ||
      (err && err.portalSkip) ||
      isTransientFetchError(err) ||
      (err && err.message === 'portal-no-tab');
    if (transient) {
      console.warn(MSG.LOG_CHECK_FAIL, (err && err.message) || err, '(skipped, will retry)');
      return { ok: true, changed: false, kind: 'transient', monitorId: monitor.id };
    }
    console.warn(MSG.LOG_CHECK_FAIL, (err && err.message) || err);
    showCheckFailedNotification(monitor.url, err.message, monitor.id);
    return { ok: false, changed: false, error: err.message, monitorId: monitor.id };
  });
}

function checkAllMonitors(skipDueCheck) {
  return ensureStorageMigrated().then(function () {
    return getSettings();
  }).then(function (settings) {
    if (!settings.monitoringActive || !settings.monitors.length) {
      return { ok: true, changed: false, checked: 0 };
    }
    var aggregate = { ok: true, changed: false, checked: 0, errors: [] };
    var chain = Promise.resolve();
    settings.monitors.forEach(function (monitor) {
      chain = chain.then(function () {
        if (lifecycleStopRequested) {
          return null;
        }
        if (!skipDueCheck && !isMonitorDue(monitor, settings)) {
          return null;
        }
        return isMonitoringStillActive().then(function (stillActive) {
          if (!stillActive) {
            return null;
          }
          return checkSingleMonitor(monitor, settings, false).then(function (result) {
            aggregate.checked++;
            if (!result.ok) {
              aggregate.ok = false;
              aggregate.errors.push(result.error);
            }
            if (result.changed) {
              aggregate.changed = true;
            }
            if (result.kind) {
              aggregate.kind = result.kind;
            }
            if (result.ignored) {
              aggregate.ignored = result.ignored;
            }
            if (result.noise) {
              aggregate.noise = result.noise;
            }
          });
        });
      });
    });
    return chain.then(function () {
      return aggregate;
    });
  });
}

function checkLinkContent(skipDueCheck) {
  return checkAllMonitors(skipDueCheck);
}

function clearMonitor(options) {
  options = options || {};
  return queueStopOp(function () {
    return getSettings().then(function (settings) {
      var ids = (settings.monitors || []).map(function (m) {
        return m.id;
      });
      var chain = Promise.resolve();
      for (var i = 0; i < ids.length; i++) {
        chain = chain.then(function () {
          return getSettings().then(function (latest) {
            if (!latest.monitors.length) {
              return null;
            }
            var targetId = latest.monitors[0].id;
            var monitors = renumberMonitors(latest.monitors.filter(function (m) {
              return m.id !== targetId;
            }));
            if (monitors.length === 0) {
              return saveEmptyMonitorState();
            }
            return saveSettings({
              monitors: monitors,
              monitoringActive: true
            });
          });
        });
      }
      return chain.then(function () {
        return getSettings().then(function (latest) {
          if (latest.monitors.length) {
            return saveEmptyMonitorState();
          }
          return clearAllCheckAlarms().then(function () {
            return clearAttentionBadge();
          }).then(function () {
            return saveSettings(buildClearedMonitorStorage());
          });
        });
      }).then(function () {
        lifecycleStopRequested = false;
        if (!options.silent) {
          showStoppedNotification(true);
        }
        return { ok: true, clearedAll: true };
      });
    });
  });
}

function removeMonitor(monitorId, options) {
  options = options || {};
  return queueStopOp(function () {
    return getSettings().then(function (settings) {
      var removed = findMonitorById(settings.monitors, monitorId);
      if (!removed) {
        lifecycleStopRequested = false;
        return { ok: false, error: 'not found' };
      }
      var label = monitorDisplayLabel(removed);
      var monitors = settings.monitors.filter(function (m) {
        return m.id !== monitorId;
      });
      monitors = renumberMonitors(monitors);

      if (monitors.length === 0) {
        return saveEmptyMonitorState().then(function () {
          lifecycleStopRequested = false;
          if (!options.silent) {
            showStoppedNotification(true);
          }
          return { ok: true, stoppedAll: true, label: label };
        });
      }

      lifecycleStopRequested = false;
      return saveSettings({
        monitors: monitors,
        monitoringActive: true
      }).then(function () {
        return rescheduleAlarmFromSettings();
      }).then(function () {
        return { ok: true, stoppedAll: false, label: label, count: monitors.length };
      });
    });
  });
}

function openMonitoredPage() {
  return getSettings().then(function (settings) {
    if (!settings.autoOpenOnStartup || !settings.monitoringActive) {
      return;
    }
    var jobs = [];
    for (var i = 0; i < settings.monitors.length; i++) {
      (function (openUrl) {
        if (!openUrl) {
          return;
        }
        jobs.push(
          chrome.tabs.query({ url: openUrl }).then(function (tabs) {
            if (tabs.length === 0) {
              return chrome.tabs.create({ url: openUrl });
            }
          })
        );
      })(settings.monitors[i].pageUrl || settings.monitors[i].url);
    }
    return Promise.all(jobs);
  });
}

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId === 'monitor-enable' && info.linkUrl) {
    registerLink(info.linkUrl, tab && tab.url);
  } else if (info.menuItemId === 'monitor-enable-selection' && info.selectionText) {
    var selectionUrl = normalizeUserEnteredUrl(info.selectionText);
    if (selectionUrl) {
      registerLink(selectionUrl, tab && tab.url ? tab.url : selectionUrl);
    } else {
      broadcastAlert({
        level: 'normal',
        idPrefix: 'selection-bad-url',
        title: MSG.FAIL_TITLE,
        message: MSG.OMNIBOX_BAD_URL,
        skipThrottle: true
      });
    }
  } else if (
    info.menuItemId === 'monitor-enable-page' ||
    info.menuItemId === 'monitor-enable-action'
  ) {
    monitorActiveTabUrl();
  } else if (info.menuItemId === 'monitor-enable-picked' && tab && tab.url) {
    getPickedMonitorUrlForTab(tab.url).then(function (picked) {
      var url = picked.url || normalizeMonitorUrl(tab.url);
      registerLink(url, tab.url);
    });
  } else if (info.menuItemId === 'monitor-disable' || info.menuItemId === 'monitor-disable-page') {
    clearMonitor();
  }
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type === 'GET_STATUS') {
    getSettings().then(function (settings) {
      sendResponse({ ok: true, settings: settings });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'GET_TAB_MONITOR_INFO') {
    getActiveTab().then(function (tab) {
      var tabUrl = tab && tab.url ? tab.url : '';
      var isPortal = isPortalMonitorHost(tabUrl);
      return getPickedMonitorUrlForTab(tabUrl).then(function (picked) {
        sendResponse({
          ok: true,
          tabUrl: tabUrl,
          tabTitle: tab && tab.title ? tab.title : '',
          isAhtba: isPortal,
          isPortal: isPortal,
          pickedUrl: picked.url,
          pickedLabel: picked.label
        });
      });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'SYNC_PICKED_SESSION') {
    var sessionData = message.data || {};
    var pickedPayload = {
      [SESSION_PICKED_URL_KEY]: sessionData[SESSION_PICKED_URL_KEY] || sessionData.lastPickedMonitorUrl || '',
      [SESSION_PICKED_LABEL_KEY]: sessionData[SESSION_PICKED_LABEL_KEY] || sessionData.lastPickedMonitorLabel || '',
      [SESSION_PICKED_PAGE_KEY]: sessionData[SESSION_PICKED_PAGE_KEY] || sessionData.lastPickedMonitorPage || ''
    };
    chrome.storage.local.set({ linkMonitorPickedSession: pickedPayload }).then(function () {
      sendResponse({ ok: true });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'GET_PICKED_SESSION') {
    chrome.storage.local.get(['linkMonitorPickedSession']).then(function (data) {
      sendResponse({ ok: true, data: data.linkMonitorPickedSession || {} });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'REGISTER_MONITOR') {
    var regUrl = normalizeMonitorUrl(message.url);
    var regPage = normalizeMonitorUrl(message.pageUrl || regUrl);
    if (!regUrl) {
      sendResponse({ ok: false, error: 'missing url' });
      return true;
    }
    registerLink(regUrl, regPage, message.name || '', {
      silent: message.silent === true
    }).then(function (result) {
      sendResponse(result);
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'SHOW_PICK_TOOLBAR') {
    getActiveTab().then(function (tab) {
      if (!tab || !tab.id) {
        sendResponse({ ok: false, error: 'invalid tab' });
        return;
      }
      if (!isPortalMonitorHost(tab.url)) {
        sendResponse({ ok: false, error: 'not portal site' });
        return;
      }
      return chrome.tabs.sendMessage(tab.id, { type: 'SHOW_PICK_TOOLBAR' }).then(function (result) {
        sendResponse(result || { ok: false, error: 'show failed' });
      }).catch(function () {
        sendResponse({ ok: false, error: '请刷新页面后重试' });
      });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'SCAN_PAGE_LINKS') {
    getActiveTab().then(function (tab) {
      if (!tab || !tab.id) {
        sendResponse({ ok: false, error: 'invalid tab' });
        return;
      }
      return chrome.tabs.sendMessage(tab.id, { type: 'SCAN_PAGE_LINKS' }).then(function (result) {
        sendResponse(result);
      }).catch(function () {
        sendResponse({ ok: false, error: 'scan failed', links: [] });
      });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'MONITOR_CURRENT_TAB') {
    getActiveTab().then(function (tab) {
      if (!tab) {
        sendResponse({ ok: false, error: 'invalid tab' });
        return;
      }
      var url = normalizeMonitorUrl(tab.url);
      return registerLink(url, url).then(function (result) {
        sendResponse(result);
      });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'MONITOR_PICKED_LINK') {
    getActiveTab().then(function (tab) {
      if (!tab || !tab.url) {
        sendResponse({ ok: false, error: 'invalid tab' });
        return;
      }
      return getPickedMonitorUrlForTab(tab.url).then(function (picked) {
        if (!picked.url) {
          sendResponse({ ok: false, error: MSG.MENU_ENABLE_PICKED_HINT });
          return;
        }
        if (normalizeMonitorUrl(picked.url) === normalizeMonitorUrl(tab.url)) {
          sendResponse({ ok: false, error: MSG.MENU_ENABLE_PICKED_HINT });
          return;
        }
        return registerLink(picked.url, tab.url, picked.label).then(function (result) {
          sendResponse(result);
        });
      });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'START_MONITORS') {
    var items = message.items || [];
    startMonitorsFromItems(
      items,
      message.useGlobalInterval,
      message.globalIntervalMinutes
    ).then(function (result) {
      sendResponse(result);
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'UPDATE_MONITOR_INTERVAL') {
    var targetId = message.monitorId;
    var newMinutes = message.intervalMinutes;
    if (!targetId || !newMinutes || newMinutes <= 0) {
      sendResponse({ ok: false, error: 'invalid interval' });
      return true;
    }
    getSettings().then(function (settings) {
      var monitors = settings.monitors.map(function (m) {
        if (m.id !== targetId) {
          return m;
        }
        return Object.assign({}, m, {
          intervalMinutes: newMinutes,
          throttleIntervalMinutes: 0
        });
      });
      return saveSettings({ monitors: monitors }).then(function () {
        return rescheduleAlarmFromSettings();
      });
    }).then(function () {
      sendResponse({ ok: true });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'UPDATE_SETTINGS') {
    var updates = message.updates || {};
    saveSettings(updates).then(function () {
      if (updates.checkIntervalMinutes !== undefined ||
          updates.useGlobalInterval !== undefined) {
        return rescheduleAlarmFromSettings();
      }
      if (updates.showPickToolbar !== undefined) {
        notifyPortalTabsPickToolbar(updates.showPickToolbar === true);
      }
    }).then(function () {
      sendResponse({ ok: true });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'CLEAR_MONITOR') {
    clearMonitor().then(function (result) {
      sendResponse(result || { ok: true, clearedAll: true });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'REMOVE_MONITOR') {
    var removeId = message.monitorId;
    if (!removeId) {
      sendResponse({ ok: false, error: 'missing monitorId' });
      return true;
    }
    removeMonitor(removeId).then(function (result) {
      sendResponse(result);
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'CHECK_NOW') {
    checkLinkContent(true).then(function (result) {
      sendResponse(result);
    }).catch(function (err) {
      sendResponse({ ok: false, changed: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'TEST_NOTIFICATION') {
    showTestNotification().then(function () {
      sendResponse({ ok: true });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'THROTTLE_ASK_RESPONSE') {
    var action = message.action;
    var updates = {
      throttleAskPending: false,
      popupAlertRecords: [],
      popupAlertTimestamps: []
    };
    if (action === 'pause') {
      updates.popupsSuppressed = true;
      updates.throttleAskCooldownUntil = Date.now() + POPUP_WINDOW_MS;
      getSettings().then(function (settings) {
        var targetId = resolveThrottleTargetMonitorId(settings);
        var monitors = (settings.monitors || []).map(function (m) {
          if (targetId && m.id === targetId) {
            return Object.assign({}, m, {
              throttleIntervalMinutes: THROTTLE_PAUSE_INTERVAL_MINUTES
            });
          }
          return m;
        });
        updates.monitors = monitors;
        return saveSettings(updates);
      }).then(function () {
        return rescheduleAlarmFromSettings();
      }).then(function () {
        showSystemNotification('throttle-paused', MSG.THROTTLE_PAUSED_TITLE, MSG.THROTTLE_PAUSED_MSG);
        sendResponse({ ok: true });
      }).catch(function (err) {
        sendResponse({ ok: false, error: err.message });
      });
    } else {
      updates.throttleAskCooldownUntil = 0;
      saveSettings(updates).then(function () {
        sendResponse({ ok: true });
      }).catch(function (err) {
        sendResponse({ ok: false, error: err.message });
      });
    }
    return true;
  }
});

chrome.notifications.onButtonClicked.addListener(function (notificationId, buttonIndex) {
  if (notificationId.indexOf('ask-auto-open') === 0) {
    saveSettings({ autoOpenOnStartup: buttonIndex === 0 });
    chrome.notifications.clear(notificationId);
  }
});

chrome.notifications.onClosed.addListener(function (notificationId) {
  if (notificationId.indexOf('ask-auto-open') === 0) {
    saveSettings({ autoOpenOnStartup: false });
  }
  if (notificationId.indexOf('link-changed') === 0 ||
      notificationId.indexOf('link-check-failed') === 0 ||
      notificationId.indexOf('test') === 0) {
    clearAttentionBadge();
  }
});

chrome.notifications.onClicked.addListener(function (notificationId) {
  if (notificationId.indexOf('link-changed') === 0) {
    clearAttentionBadge();
    var numMatch = notificationId.match(/^link-changed-(\d+)-/);
    getSettings().then(function (settings) {
      if (numMatch) {
        var monitor = findMonitorByNumber(settings.monitors, parseInt(numMatch[1], 10));
        if (monitor && monitor.url) {
          chrome.tabs.create({ url: monitor.url });
        }
      } else if (settings.monitors.length === 1 && settings.monitors[0].url) {
        chrome.tabs.create({ url: settings.monitors[0].url });
      }
    });
    chrome.notifications.clear(notificationId);
  }
});

chrome.windows.onRemoved.addListener(function (windowId) {
  if (windowId === throttleAskWindowId) {
    throttleAskWindowId = null;
    saveSettings({ throttleAskPending: false });
  }
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === ALARM_NAME) {
    checkLinkContent(false).then(function () {
      return checkThrottleAskFromStorage();
    });
    return;
  }
  if (alarm.name === FAST_ALARM_NAME) {
    checkLinkContent(false).then(function () {
      return rescheduleFastAlarmIfNeeded();
    }).then(function () {
      return checkThrottleAskFromStorage();
    });
  }
});

function checkThrottleAskFromStorage() {
  return chrome.storage.local.get(['popupAlertRecords', 'popupAlertTimestamps']).then(function (data) {
    var count = migratePopupRecords(data).length;
    if (count > POPUP_MAX_BEFORE_ASK) {
      return evaluateThrottleAsk(count);
    }
  });
}

chrome.runtime.onStartup.addListener(function () {
  ensureStorageMigrated();
  openMonitoredPage();
  getSettings().then(function (settings) {
    if (settings.monitoringActive && settings.monitors.length) {
      return rescheduleAlarmFromSettings();
    }
  });
});

chrome.runtime.onInstalled.addListener(function (details) {
  setupContextMenus();
  ensureStorageMigrated();
  getSettings().then(function (settings) {
    if (settings.monitoringActive && settings.monitors.length) {
      return rescheduleAlarmFromSettings();
    }
  });
  if (details.reason === 'install') {
    broadcastAlert({
      level: 'normal',
      idPrefix: 'welcome',
      title: MSG.WELCOME_TITLE,
      message: MSG.WELCOME_MSG,
      skipThrottle: true
    });
  }
  if (details.reason === 'update') {
    notifyPortalTabsExtensionUpdated();
  }
});

function notifyPortalTabsPickToolbar(enabled) {
  var patterns = [
    '*://www.ahtba.org.cn/*',
    '*://ahtba.org.cn/*',
    '*://ggzy.hefei.gov.cn/*',
    '*://*.ggzy.hefei.gov.cn/*'
  ];
  chrome.tabs.query({ url: patterns }, function (tabs) {
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      if (!tab.id) {
        continue;
      }
      chrome.tabs.sendMessage(tab.id, {
        type: 'SET_PICK_TOOLBAR',
        enabled: enabled
      }).catch(function () {});
    }
  });
}

function notifyPortalTabsExtensionUpdated() {
  var patterns = [
    '*://www.ahtba.org.cn/*',
    '*://ahtba.org.cn/*',
    '*://ggzy.hefei.gov.cn/*',
    '*://*.ggzy.hefei.gov.cn/*'
  ];
  chrome.tabs.query({ url: patterns }, function (tabs) {
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      if (!tab.id) {
        continue;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'EXTENSION_UPDATED' }).catch(function () {});
    }
  });
}
