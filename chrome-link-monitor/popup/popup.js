'use strict';

const statusEl = document.getElementById('monitor-status');
const activeListEl = document.getElementById('active-monitor-list');
const addMonitorNameInput = document.getElementById('add-monitor-name');
const addMonitorUrlInput = document.getElementById('add-monitor-url');
const addMonitorBtn = document.getElementById('add-monitor-btn');
const useGlobalIntervalCheckbox = document.getElementById('use-global-interval');
const globalIntervalSection = document.getElementById('global-interval-section');
const intervalInput = document.getElementById('interval-input');
const intervalUnit = document.getElementById('interval-unit');
const currentIntervalEl = document.getElementById('current-interval');
const autoOpenCheckbox = document.getElementById('auto-open-checkbox');
const autoOpenMonitorLinkCheckbox = document.getElementById('auto-open-monitor-link-checkbox');
const popupThrottleAskCheckbox = document.getElementById('popup-throttle-ask-checkbox');
const popupsSuppressedCheckbox = document.getElementById('popups-suppressed-checkbox');
const ignoreNoiseCheckbox = document.getElementById('ignore-noise-checkbox');
const popupCountHint = document.getElementById('popup-count-hint');
const toastEl = document.getElementById('toast');
const showMonitorBadgesCheckbox = document.getElementById('show-monitor-badges-checkbox');
const showPickToolbarCheckbox = document.getElementById('show-pick-toolbar-checkbox');

const MINUTES_PER = {
  seconds: 1 / 60,
  minutes: 1,
  hours: 60,
  days: 1440,
  weeks: 10080
};

const POPUP_WINDOW_MS = 60 * 60 * 1000;

function countRecentPopupAlerts(data) {
  const now = Date.now();
  const records = data.popupAlertRecords || [];
  if (records.length) {
    return records.filter((r) => r && now - r.t < POPUP_WINDOW_MS).length;
  }
  const timestamps = data.popupAlertTimestamps || [];
  return timestamps.filter((t) => now - t < POPUP_WINDOW_MS).length;
}

function getMonitorEffectiveMinutes(monitor, settings) {
  if (monitor.throttleIntervalMinutes > 0) {
    return monitor.throttleIntervalMinutes;
  }
  if (settings.useGlobalInterval) {
    return settings.checkIntervalMinutes;
  }
  return monitor.intervalMinutes ?? settings.checkIntervalMinutes;
}

const UNIT_LIMITS = {
  seconds: { min: 1, max: 86400 },
  minutes: { min: 1, max: 1440 },
  hours: { min: 1, max: 168 },
  days: { min: 1, max: 30 },
  weeks: { min: 1, max: 4 }
};

const UNIT_LABELS = {
  seconds: '秒',
  minutes: '分钟',
  hours: '小时',
  days: '天',
  weeks: '周'
};

const LIFECYCLE_TOAST_WINDOW_MS = 1000;
const LIFECYCLE_TOAST_MAX = 2;
let lifecycleToastTimes = [];
let lifecycleToastTimer = null;
let pendingLifecycleToast = null;
let clearMonitorInFlight = null;
let addMonitorInFlight = null;

function showLifecycleToast(message, type = 'success') {
  pendingLifecycleToast = { message, type };
  if (lifecycleToastTimer) {
    return;
  }
  lifecycleToastTimer = setTimeout(() => {
    const now = Date.now();
    lifecycleToastTimes = lifecycleToastTimes.filter((t) => now - t < LIFECYCLE_TOAST_WINDOW_MS);
    if (pendingLifecycleToast && lifecycleToastTimes.length < LIFECYCLE_TOAST_MAX) {
      lifecycleToastTimes.push(now);
      showToast(pendingLifecycleToast.message, pendingLifecycleToast.type);
    }
    pendingLifecycleToast = null;
    lifecycleToastTimer = null;
  }, 280);
}

function requestClearMonitor() {
  if (!clearMonitorInFlight) {
    clearMonitorInFlight = sendMessage({ type: 'CLEAR_MONITOR' }).finally(() => {
      clearMonitorInFlight = null;
    });
  }
  return clearMonitorInFlight;
}

function requestAddMonitor(payload) {
  if (!addMonitorInFlight) {
    addMonitorInFlight = sendMessage(payload).finally(() => {
      addMonitorInFlight = null;
    });
  }
  return addMonitorInFlight;
}

function clearAddMonitorForm() {
  if (addMonitorNameInput) {
    addMonitorNameInput.value = '';
  }
  if (addMonitorUrlInput) {
    addMonitorUrlInput.value = '';
  }
}

function showToast(message, type = 'success') {
  toastEl.textContent = message;
  toastEl.className = `toast ${type}`;
  setTimeout(() => {
    toastEl.className = 'toast hidden';
  }, 3000);
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function formatIntervalText(minutes) {
  if (minutes < 1) {
    const seconds = Math.round(minutes * 60);
    return `每 ${seconds} 秒`;
  }
  if (minutes % MINUTES_PER.weeks === 0 && minutes >= MINUTES_PER.weeks) {
    const w = minutes / MINUTES_PER.weeks;
    return w === 1 ? '每 1 周' : `每 ${w} 周`;
  }
  if (minutes % MINUTES_PER.days === 0 && minutes >= MINUTES_PER.days) {
    const d = minutes / MINUTES_PER.days;
    return d === 1 ? '每 1 天' : `每 ${d} 天`;
  }
  if (minutes % MINUTES_PER.hours === 0 && minutes >= MINUTES_PER.hours) {
    const h = minutes / MINUTES_PER.hours;
    return h === 1 ? '每 1 小时' : `每 ${h} 小时`;
  }
  if (minutes === 1) return '每 1 分钟';
  if (Number.isInteger(minutes)) return `每 ${minutes} 分钟`;
  return `每 ${minutes} 分钟`;
}

function minutesToDisplay(minutes, inputEl, unitEl) {
  if (minutes < 1) {
    unitEl.value = 'seconds';
    inputEl.value = Math.round(minutes * 60);
    return;
  }
  if (minutes % MINUTES_PER.weeks === 0 && minutes >= MINUTES_PER.weeks) {
    unitEl.value = 'weeks';
    inputEl.value = minutes / MINUTES_PER.weeks;
    return;
  }
  if (minutes % MINUTES_PER.days === 0 && minutes >= MINUTES_PER.days) {
    unitEl.value = 'days';
    inputEl.value = minutes / MINUTES_PER.days;
    return;
  }
  if (minutes % MINUTES_PER.hours === 0 && minutes >= MINUTES_PER.hours) {
    unitEl.value = 'hours';
    inputEl.value = minutes / MINUTES_PER.hours;
    return;
  }
  unitEl.value = 'minutes';
  inputEl.value = minutes;
}

function displayToMinutes(inputEl, unitEl) {
  const unit = unitEl.value;
  const value = parseFloat(inputEl.value);
  const limits = UNIT_LIMITS[unit];

  if (!value || value <= 0) return null;
  if (value < limits.min || value > limits.max) return null;

  return value * MINUTES_PER[unit];
}

function getValidationHint(unit) {
  const limits = UNIT_LIMITS[unit];
  return `${UNIT_LABELS[unit]}数请输入 ${limits.min}–${limits.max}`;
}

function updateInputConstraints(inputEl, unitEl) {
  const unit = unitEl.value;
  const limits = UNIT_LIMITS[unit];
  inputEl.min = limits.min;
  inputEl.max = limits.max;
  inputEl.step = 1;
}

function openMonitoredUrl(url) {
  if (!url) {
    return;
  }
  chrome.tabs.create({ url });
}

function truncateForToast(url, max) {
  max = max || 48;
  if (!url || url.length <= max) {
    return url || '';
  }
  return url.slice(0, max) + '...';
}

function normalizeInputUrl(url) {
  const trimmed = (url || '').trim();
  if (!trimmed) {
    return '';
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return 'https://' + trimmed;
}

function isGlobalInterval() {
  return useGlobalIntervalCheckbox.checked;
}

function updateGlobalIntervalVisibility() {
  const global = isGlobalInterval();
  globalIntervalSection.classList.toggle('hidden', !global);
}

function createRowIntervalEditor(monitor, settings) {
  const intervalWrap = document.createElement('div');
  intervalWrap.className = 'row-interval field compact';

  const inputEl = document.createElement('input');
  inputEl.type = 'number';
  inputEl.className = 'row-interval-input';
  inputEl.min = '1';

  const unitEl = document.createElement('select');
  unitEl.className = 'row-interval-unit';
  ['seconds', 'minutes', 'hours', 'days', 'weeks'].forEach((u) => {
    const opt = document.createElement('option');
    opt.value = u;
    opt.textContent = UNIT_LABELS[u];
    if (u === 'minutes') {
      opt.selected = true;
    }
    unitEl.appendChild(opt);
  });

  const rowMinutes = getMonitorEffectiveMinutes(monitor, settings);
  minutesToDisplay(rowMinutes, inputEl, unitEl);
  updateInputConstraints(inputEl, unitEl);

  unitEl.addEventListener('change', () => {
    updateInputConstraints(inputEl, unitEl);
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-secondary row-interval-save';
  saveBtn.textContent = '保存间隔';
  saveBtn.addEventListener('click', async () => {
    const mins = displayToMinutes(inputEl, unitEl);
    if (!mins) {
      showToast(getValidationHint(unitEl.value), 'error');
      return;
    }
    saveBtn.disabled = true;
    const response = await sendMessage({
      type: 'UPDATE_MONITOR_INTERVAL',
      monitorId: monitor.id,
      intervalMinutes: mins
    });
    saveBtn.disabled = false;
    if (response?.ok) {
      await loadStatus();
      showToast(`已保存：${formatIntervalText(mins)}检查一次`);
    } else {
      showToast(response?.error || '保存失败', 'error');
    }
  });

  intervalWrap.appendChild(document.createTextNode('每隔 '));
  intervalWrap.appendChild(inputEl);
  intervalWrap.appendChild(unitEl);
  intervalWrap.appendChild(document.createTextNode(' 检查一次 '));
  intervalWrap.appendChild(saveBtn);

  return intervalWrap;
}

function renderActiveMonitors(settings) {
  activeListEl.innerHTML = '';
  if (!settings.monitoringActive || !settings.monitors.length) {
    statusEl.textContent = '尚未开始监控';
    statusEl.className = 'status-empty';
    updateGlobalIntervalVisibility();
    return;
  }

  statusEl.textContent = `正在监控 ${settings.monitors.length} 个链接（点击链接可打开页面）`;
  statusEl.className = 'status-active';

  settings.monitors.forEach((monitor) => {
    const row = document.createElement('div');
    row.className = 'active-monitor-row';

    const linkRow = document.createElement('div');
    linkRow.className = 'active-monitor-link-row';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'monitored-url active-monitor-open';
    const displayLabel = (monitor.name && monitor.name.trim())
      ? monitor.name.trim()
      : `${monitor.number}号链接`;

    openBtn.title = monitor.url;
    openBtn.innerHTML =
      '<span class="monitored-url-label">' + displayLabel + '</span>' +
      '<span class="monitored-url-action">点击打开 →</span>';

    openBtn.addEventListener('click', () => openMonitoredUrl(monitor.url));

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'active-monitor-stop';
    stopBtn.textContent = '停止';
    stopBtn.title = '停止监控此链接';
    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      const response = await sendMessage({
        type: 'REMOVE_MONITOR',
        monitorId: monitor.id
      });
      stopBtn.disabled = false;
      if (response?.ok) {
        await loadStatus();
        if (response.stoppedAll) {
          showLifecycleToast('已关闭并清除全部监控链接');
        } else {
          showLifecycleToast(`已停止监控：${response.label || displayLabel}`);
        }
      } else {
        showToast(response?.error || '停止失败', 'error');
      }
    });

    linkRow.appendChild(openBtn);
    linkRow.appendChild(stopBtn);
    row.appendChild(linkRow);

    if (monitor.throttleIntervalMinutes > 0) {
      const throttleHint = document.createElement('div');
      throttleHint.className = 'active-monitor-throttle-hint hint-text';
      throttleHint.textContent =
        `已减缓：${formatIntervalText(monitor.throttleIntervalMinutes)}检查一次`;
      row.appendChild(throttleHint);
    }

    if (!settings.useGlobalInterval) {
      const intervalRow = document.createElement('div');
      intervalRow.className = 'active-monitor-interval-row';
      intervalRow.appendChild(createRowIntervalEditor(monitor, settings));
      row.appendChild(intervalRow);
    }

    activeListEl.appendChild(row);
  });

  updateGlobalIntervalVisibility();
}

function renderStatus(settings) {
  const minutes = settings.checkIntervalMinutes ?? 30;

  useGlobalIntervalCheckbox.checked = settings.useGlobalInterval !== false;
  renderActiveMonitors(settings);

  currentIntervalEl.textContent = `当前：${formatIntervalText(minutes)}检查一次`;
  minutesToDisplay(minutes, intervalInput, intervalUnit);
  updateInputConstraints(intervalInput, intervalUnit);
  autoOpenCheckbox.checked = settings.autoOpenOnStartup ?? false;
  if (autoOpenMonitorLinkCheckbox) {
    autoOpenMonitorLinkCheckbox.checked = settings.autoOpenMonitorLink === true;
  }
  popupThrottleAskCheckbox.checked = settings.popupThrottleAskEnabled ?? true;
  popupsSuppressedCheckbox.checked = settings.popupsSuppressed ?? false;
  ignoreNoiseCheckbox.checked = settings.ignoreNoiseAlerts ?? false;
  if (showMonitorBadgesCheckbox) {
    showMonitorBadgesCheckbox.checked = settings.showMonitorBadges === true;
  }
  if (showPickToolbarCheckbox) {
    showPickToolbarCheckbox.checked = settings.showPickToolbar === true;
  }
}

function updatePopupCountHint(recentCount) {
  if (!popupCountHint) {
    return;
  }
  popupCountHint.textContent =
    `近 60 分钟已弹窗 ${recentCount} 次（超过 40 次将询问是否减缓）`;
}

function refreshPopupCount() {
  chrome.storage.local.get(['popupAlertRecords', 'popupAlertTimestamps'], (data) => {
    updatePopupCountHint(countRecentPopupAlerts(data));
  });
}

async function addMonitorFromForm() {
  const url = normalizeInputUrl(addMonitorUrlInput?.value);
  if (!url) {
    showToast('请输入有效网址', 'error');
    return;
  }

  const name = (addMonitorNameInput?.value || '').trim();
  const globalMinutes = displayToMinutes(intervalInput, intervalUnit);
  if (!globalMinutes) {
    showToast(getValidationHint(intervalUnit.value), 'error');
    return;
  }

  addMonitorBtn.disabled = true;

  const intervalResponse = await sendMessage({
    type: 'UPDATE_SETTINGS',
    updates: { checkIntervalMinutes: globalMinutes }
  });
  if (!intervalResponse?.ok) {
    addMonitorBtn.disabled = false;
    showToast('保存检查间隔失败', 'error');
    return;
  }

  const response = await requestAddMonitor({
    type: 'REGISTER_MONITOR',
    url,
    name,
    pageUrl: url
  });

  addMonitorBtn.disabled = false;

  if (!response?.ok) {
    showToast(response?.error || '添加失败', 'error');
    return;
  }

  clearAddMonitorForm();
  await loadStatus();
  const label = name || url;
  if (response.added) {
    showLifecycleToast(`已添加并开始监控：${truncateForToast(label)}`);
  } else if (response.updated) {
    showLifecycleToast(`已更新监控：${truncateForToast(label)}`);
  } else {
    showLifecycleToast(`已开始监控：${truncateForToast(label)}`);
  }
}

async function loadStatus() {
  const response = await sendMessage({ type: 'GET_STATUS' });
  if (response?.ok) {
    renderStatus(response.settings);
  }
}

if (addMonitorBtn) {
  addMonitorBtn.addEventListener('click', () => {
    addMonitorFromForm();
  });
}

if (addMonitorUrlInput) {
  addMonitorUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addMonitorFromForm();
    }
  });
}

useGlobalIntervalCheckbox.addEventListener('change', async () => {
  const checked = useGlobalIntervalCheckbox.checked;
  const response = await sendMessage({
    type: 'UPDATE_SETTINGS',
    updates: { useGlobalInterval: checked }
  });
  if (!response?.ok) {
    showToast('设置失败', 'error');
    useGlobalIntervalCheckbox.checked = !checked;
    return;
  }
  await loadStatus();
});

document.getElementById('save-interval').addEventListener('click', async () => {
  const minutes = displayToMinutes(intervalInput, intervalUnit);

  if (!minutes) {
    showToast(getValidationHint(intervalUnit.value), 'error');
    return;
  }

  const response = await sendMessage({
    type: 'UPDATE_SETTINGS',
    updates: { checkIntervalMinutes: minutes }
  });

  if (response?.ok) {
    currentIntervalEl.textContent = `当前：${formatIntervalText(minutes)}检查一次`;
    showToast(`已保存：${formatIntervalText(minutes)}检查一次`);
  } else {
    showToast('保存失败', 'error');
  }
});

intervalUnit.addEventListener('change', () => {
  updateInputConstraints(intervalInput, intervalUnit);
});

document.querySelectorAll('.btn-preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.seconds) {
      minutesToDisplay(parseFloat(btn.dataset.seconds) / 60, intervalInput, intervalUnit);
    } else if (btn.dataset.minutes) {
      minutesToDisplay(parseFloat(btn.dataset.minutes), intervalInput, intervalUnit);
    } else if (btn.dataset.hours) {
      minutesToDisplay(parseFloat(btn.dataset.hours) * MINUTES_PER.hours, intervalInput, intervalUnit);
    } else if (btn.dataset.days) {
      minutesToDisplay(parseFloat(btn.dataset.days) * MINUTES_PER.days, intervalInput, intervalUnit);
    } else if (btn.dataset.weeks) {
      minutesToDisplay(parseFloat(btn.dataset.weeks) * MINUTES_PER.weeks, intervalInput, intervalUnit);
    }
    updateInputConstraints(intervalInput, intervalUnit);
  });
});

autoOpenCheckbox.addEventListener('change', async () => {
  const response = await sendMessage({
    type: 'UPDATE_SETTINGS',
    updates: { autoOpenOnStartup: autoOpenCheckbox.checked }
  });

  if (!response?.ok) {
    showToast('设置失败', 'error');
    autoOpenCheckbox.checked = !autoOpenCheckbox.checked;
  }
});

if (autoOpenMonitorLinkCheckbox) {
  autoOpenMonitorLinkCheckbox.addEventListener('change', async () => {
    const enabled = autoOpenMonitorLinkCheckbox.checked;
    const response = await sendMessage({
      type: 'UPDATE_SETTINGS',
      updates: { autoOpenMonitorLink: enabled }
    });

    if (!response?.ok) {
      showToast('设置失败', 'error');
      autoOpenMonitorLinkCheckbox.checked = !enabled;
      return;
    }

    showToast(enabled ? '已开启：选择链接后将自动打开监控页' : '已关闭：选择链接后不再自动打开');
  });
}

if (showPickToolbarCheckbox) {
  showPickToolbarCheckbox.addEventListener('change', async () => {
    const enabled = showPickToolbarCheckbox.checked;
    const response = await sendMessage({
      type: 'UPDATE_SETTINGS',
      updates: { showPickToolbar: enabled }
    });

    if (!response?.ok) {
      showToast('设置失败', 'error');
      showPickToolbarCheckbox.checked = !enabled;
      return;
    }

    showToast(enabled ? '已开启：门户页将显示点选工具条' : '已关闭：点选工具条已隐藏');
  });
}

popupThrottleAskCheckbox.addEventListener('change', async () => {
  const response = await sendMessage({
    type: 'UPDATE_SETTINGS',
    updates: { popupThrottleAskEnabled: popupThrottleAskCheckbox.checked }
  });

  if (!response?.ok) {
    showToast('设置失败', 'error');
    popupThrottleAskCheckbox.checked = !popupThrottleAskCheckbox.checked;
  }
});

popupsSuppressedCheckbox.addEventListener('change', async () => {
  const response = await sendMessage({
    type: 'UPDATE_SETTINGS',
    updates: { popupsSuppressed: popupsSuppressedCheckbox.checked }
  });

  if (!response?.ok) {
    showToast('设置失败', 'error');
    popupsSuppressedCheckbox.checked = !popupsSuppressedCheckbox.checked;
    return;
  }

  if (popupsSuppressedCheckbox.checked) {
    showToast('已暂停 Chrome 弹窗与网页遮罩');
  } else {
    showToast('已恢复 Chrome 弹窗与网页遮罩');
  }
});

ignoreNoiseCheckbox.addEventListener('change', async () => {
  const response = await sendMessage({
    type: 'UPDATE_SETTINGS',
    updates: { ignoreNoiseAlerts: ignoreNoiseCheckbox.checked }
  });

  if (!response?.ok) {
    showToast('设置失败', 'error');
    ignoreNoiseCheckbox.checked = !ignoreNoiseCheckbox.checked;
    return;
  }

  if (ignoreNoiseCheckbox.checked) {
    showToast('已开启：仅正文变更时强提醒');
  } else {
    showToast('广告/弹窗变化将轻量通知');
  }
});

if (showMonitorBadgesCheckbox) {
  showMonitorBadgesCheckbox.addEventListener('change', async () => {
    const enabled = showMonitorBadgesCheckbox.checked;
    const response = await sendMessage({
      type: 'UPDATE_SETTINGS',
      updates: { showMonitorBadges: enabled }
    });

    if (!response?.ok) {
      showToast('设置失败', 'error');
      showMonitorBadgesCheckbox.checked = !enabled;
      return;
    }

    showToast(enabled ? '已显示页面「可监控」标记' : '已隐藏页面「可监控」标记');
  });
}

document.getElementById('open-test-page').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('test/monitor-test.html') });
});

document.getElementById('check-now').addEventListener('click', async () => {
  const response = await sendMessage({ type: 'CHECK_NOW' });

  if (!response?.ok) {
    showToast(response?.error || '检查失败，请确认链接可访问', 'error');
    return;
  }

  if (response.changed) {
    showToast('检测到正文内容变化，已发送强提醒');
  } else if (response.kind === 'noise' && !response.ignored) {
    showToast('正文未变，可能仅为广告/弹窗变化（已轻量通知）');
  } else if (response.kind === 'noise' && response.ignored) {
    showToast('正文未变，广告/弹窗变化已忽略');
  } else {
    const n = response.checked || 0;
    showToast(n > 1 ? `已检查 ${n} 个链接，正文无变化` : '检查完成，正文无变化');
  }
});

document.getElementById('test-notification').addEventListener('click', async () => {
  const response = await sendMessage({ type: 'TEST_NOTIFICATION' });

  if (response?.ok) {
    showToast('已发送三重提醒：系统通知 + Chrome弹窗 + 网页遮罩');
  } else {
    showToast('通知失败：请在 Windows 设置中开启 Chrome 通知', 'error');
  }
});

document.getElementById('clear-monitor').addEventListener('click', async () => {
  const btn = document.getElementById('clear-monitor');
  btn.disabled = true;
  const response = await requestClearMonitor();
  btn.disabled = false;
  if (response?.ok) {
    await loadStatus();
    showLifecycleToast('已关闭并清除全部监控链接');
  } else {
    showToast('操作失败', 'error');
  }
});

updateInputConstraints(intervalInput, intervalUnit);
loadStatus();
refreshPopupCount();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') {
    return;
  }
  if (changes.popupAlertRecords || changes.popupAlertTimestamps) {
    refreshPopupCount();
  }
  if (changes.checkIntervalMinutes || changes.monitors || changes.useGlobalInterval ||
      changes.popupsSuppressed) {
    loadStatus();
  }
});

setInterval(refreshPopupCount, 2000);
