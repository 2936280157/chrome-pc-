'use strict';

function getParam(name) {
  var params = new URLSearchParams(window.location.search);
  return params.get(name) || '';
}

var title = getParam('title');
var message = getParam('message');
var linkUrl = getParam('url');

document.getElementById('title').textContent = title || '提醒';
document.getElementById('message').textContent = message || '';

var urlEl = document.getElementById('url');
var btnOpen = document.getElementById('btn-open');

if (linkUrl) {
  urlEl.textContent = linkUrl;
  urlEl.classList.remove('hidden');
  btnOpen.classList.remove('hidden');
  btnOpen.addEventListener('click', function () {
    chrome.tabs.create({ url: linkUrl });
    window.close();
  });
}

document.getElementById('btn-close').addEventListener('click', function () {
  window.close();
});

document.body.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    window.close();
  }
});
