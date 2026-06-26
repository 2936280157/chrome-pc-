'use strict';

function createMonitorId() {
  return 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function renumberMonitors(monitors) {
  return (monitors || []).map(function (m, idx) {
    return Object.assign({}, m, { number: idx + 1 });
  });
}

function normalizeMonitorEntry(raw, number, defaultInterval) {
  return {
    id: raw.id || createMonitorId(),
    number: number,
    url: raw.url || '',
    name: (raw.name || '').trim(),
    intervalMinutes: raw.intervalMinutes != null ? raw.intervalMinutes : defaultInterval,
    throttleIntervalMinutes: raw.throttleIntervalMinutes > 0 ? raw.throttleIntervalMinutes : 0,
    lastCoreContent: raw.lastCoreContent || null,
    lastRawContent: raw.lastRawContent || null,
    lastOverlaySignature: raw.lastOverlaySignature || '',
    lastCheckAt: raw.lastCheckAt || 0,
    pageUrl: raw.pageUrl || null,
    coreBaselineVersion: raw.coreBaselineVersion || 0,
    lastCoreSnippet: raw.lastCoreSnippet || '',
    lastFetchSource: raw.lastFetchSource || ''
  };
}

function migrateLegacyToMonitors(data) {
  if (data.monitors && data.monitors.length) {
    return renumberMonitors(data.monitors);
  }
  if (!data.monitoredUrl) {
    return [];
  }
  var url = data.monitoredUrl;
  try {
    if (url.indexOf('httpbin.org') !== -1) {
      var parsed = new URL(url);
      parsed.hostname = 'httpbingo.org';
      url = parsed.href;
    }
  } catch (e) {}
  return [{
    id: createMonitorId(),
    number: 1,
    url: url,
    name: '',
    intervalMinutes: data.checkIntervalMinutes != null ? data.checkIntervalMinutes : 30,
    lastCoreContent: data.lastCoreContent || data.lastContent || null,
    lastRawContent: data.lastRawContent || null,
    lastOverlaySignature: data.lastOverlaySignature || '',
    lastCheckAt: 0,
    pageUrl: data.pageUrl || null
  }];
}

function getEffectiveIntervalMinutes(monitor, settings) {
  if (monitor.throttleIntervalMinutes > 0) {
    return monitor.throttleIntervalMinutes;
  }
  if (settings.useGlobalInterval) {
    return settings.checkIntervalMinutes;
  }
  return monitor.intervalMinutes != null ? monitor.intervalMinutes : settings.checkIntervalMinutes;
}

function computeAlarmIntervalMinutes(settings) {
  if (!settings.monitoringActive || !settings.monitors.length) {
    return 0;
  }
  var min = settings.checkIntervalMinutes;
  for (var i = 0; i < settings.monitors.length; i++) {
    var iv = getEffectiveIntervalMinutes(settings.monitors[i], settings);
    if (iv > 0 && iv < min) {
      min = iv;
    }
  }
  return min;
}

function isMonitorDue(monitor, settings, now) {
  now = now || Date.now();
  var minutes = getEffectiveIntervalMinutes(monitor, settings);
  var intervalMs = minutes * 60 * 1000;
  if (intervalMs <= 0) {
    return true;
  }
  return now - (monitor.lastCheckAt || 0) >= intervalMs;
}

function monitorDisplayLabel(monitor) {
  var label = monitor.number + '\u53f7\u94fe\u63a5';
  if (monitor.name) {
    label += '\uff08' + monitor.name + '\uff09';
  }
  return label;
}

function findMonitorByNumber(monitors, number) {
  for (var i = 0; i < monitors.length; i++) {
    if (monitors[i].number === number) {
      return monitors[i];
    }
  }
  return null;
}

function findMonitorById(monitors, id) {
  for (var i = 0; i < monitors.length; i++) {
    if (monitors[i].id === id) {
      return monitors[i];
    }
  }
  return null;
}
