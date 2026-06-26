'use strict';

var AD_KEYWORDS_RE = /(?:^|[^a-z0-9])(?:ads?|advert(?:isement)?|banner|popup|pop-up|modal|overlay|sponsor|promo(?:tion)?|floating|float-ad|\u5e7f\u544a|\u63a8\u5e7f|\u5f39\u7a97|\u6d6e\u5c42)(?:[^a-z0-9]|$)/i;

var HIGH_SENSITIVITY_HOST_RE = /(?:^|\.)ahtba\.org\.cn$|(?:^|\.)ggzy\.hefei\.gov\.cn$/i;

var PORTAL_CORE_SELECTORS = [
  'table tbody',
  '.list-content',
  '.news-list',
  '.notice-list',
  '[class*="affiche"]',
  '[class*="trade"]',
  '[class*="list-box"]',
  '[class*="listBox"]',
  '[id*="list"]',
  '.el-table__body',
  '.ant-table-tbody'
];

function isHighSensitivityHost(hostname) {
  return HIGH_SENSITIVITY_HOST_RE.test(hostname || '');
}

function isHighSensitivityUrl(url) {
  if (!url) {
    return false;
  }
  try {
    return isHighSensitivityHost(new URL(url).hostname);
  } catch (e) {
    return false;
  }
}

function stripTagsLite(text) {
  return (text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractListSnapshotFromHtml(html) {
  var parts = [];
  var seen = {};
  var trRe = /<tr[\s>][\s\S]*?<\/tr>/gi;
  var match;
  while ((match = trRe.exec(html)) !== null && parts.length < 80) {
    var text = stripTagsLite(match[0]);
    if (text.length < 6 || seen[text]) {
      continue;
    }
    seen[text] = true;
    parts.push(text.slice(0, 160));
  }
  if (parts.length < 12) {
    var liRe = /<li[\s>][\s\S]*?<\/li>/gi;
    while ((match = liRe.exec(html)) !== null && parts.length < 80) {
      var liText = stripTagsLite(match[0]);
      if (liText.length < 6 || seen[liText]) {
        continue;
      }
      seen[liText] = true;
      parts.push(liText.slice(0, 160));
    }
  }
  if (parts.length < 8) {
    var dateRe = /\d{4}-\d{2}-\d{2}[^\n<]{4,120}/g;
    while ((match = dateRe.exec(html)) !== null && parts.length < 80) {
      var dateLine = stripTagsLite(match[0]);
      if (dateLine.length < 8 || seen[dateLine]) {
        continue;
      }
      seen[dateLine] = true;
      parts.push(dateLine.slice(0, 160));
    }
  }
  return parts.join('\n');
}

function extractOverlaySignatureFromHtml(html) {
  var parts = [];
  var styleRe = /<(div|section|aside|iframe)[^>]*style=["'][^"']*(?:fixed|absolute)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;
  var match;
  while ((match = styleRe.exec(html)) !== null && parts.length < 30) {
    parts.push(stripTagsLite(match[0]).slice(0, 80));
  }
  return parts.join(';;');
}

var PORTAL_LIST_PATH_RE = /(?:^|\/)(?:index|home|list|affiche|notice|trade|query|search|more)(?:\/|$|\?)/i;
var PORTAL_DETAIL_PATH_RE = /(?:detail|view|info|content|article|show|guid|afficheDetail|noticeDetail|tradeDetail|proj|bulletin|announce)/i;

function looksLikePortalDetailPage(url) {
  if (!url) {
    return false;
  }
  try {
    var parsed = new URL(url);
    var path = (parsed.pathname || '').toLowerCase();
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

function countListSnapshotRows(listSnap) {
  if (!listSnap) {
    return 0;
  }
  return listSnap.split('\n').filter(function (line) {
    return line.trim().length >= 6;
  }).length;
}

function shouldAttachPortalListSnapshot(pageUrl, listSnap) {
  if (!listSnap || looksLikePortalDetailPage(pageUrl)) {
    return false;
  }
  return countListSnapshotRows(listSnap) >= 4;
}

function attachPortalListCore(core, pageUrl, listSnap) {
  if (!shouldAttachPortalListSnapshot(pageUrl, listSnap)) {
    return core;
  }
  return 'LIST::' + listSnap + '\nBODY::' + core;
}

function stabilizeVolatileText(text) {
  if (!text) {
    return '';
  }
  var s = text;
  s = s.replace(/\u6570\u636e\u52a0\u8f7d\u4e2d[\u2026.]*/g, '');
  s = s.replace(/今日(?:发布|抽取)[：:\s]*[\d]+[^\n]*/g, 'STAT::TODAY');
  s = s.replace(/累计(?:发布|抽取)[：:\s]*[\d]+[^\n]*/g, 'STAT::TOTAL');
  s = s.replace(/项目数[\s：:\d]*/g, 'STAT::PROJECT');
  s = s.replace(/专家数[\s：:\d]*/g, 'STAT::EXPERT');
  s = s.replace(/\u94fe\u63a5\u53d8\u66f4\u76d1\u63a7[^\n]*/g, '');
  s = s.replace(/\u5f00\u542f\u70b9\u9009\u6a21\u5f0f/g, '');
  s = s.replace(/\u5173\u95ed\u70b9\u9009\u6a21\u5f0f/g, '');
  s = s.replace(/\u76d1\u63a7\u672c\u9875/g, '');
  s = s.replace(/\u76d1\u63a7\u5df2\u9009\u9879[^\n]*/g, '');
  s = s.replace(/\d{4}[-/]\d{2}[-/]\d{2}[T\s]\d{2}:\d{2}:\d{2}/g, 'TS::STAMP');
  s = s.replace(/\d{4}[-/]\d{2}[-/]\d{2}/g, 'DT::DATE');
  s = s.replace(/\d{2}:\d{2}:\d{2}/g, 'TM::TIME');
  s = s.replace(/[0-9a-f]{32,}/gi, 'HEX::TOKEN');
  s = s.replace(/(?:nonce|csrf|token|sessionid|sid|jsessionid)=["']?[a-zA-Z0-9_-]{8,}/gi, 'PARAM::TOKEN');
  s = s.replace(/[?&](?:v|t|_t|ts|rnd|random|cachebust)=[^&\s"']+/gi, '');
  s = s.replace(/(?:访问|浏览|阅读|在线)[人数次]*[\s：:]*\d+/g, 'STAT::VIEW');
  s = s.replace(/(?:loading|spinner|placeholder)[^\n]*/gi, '');
  s = s.replace(/\b\d{1,3}(?:,\d{3})+\b/g, 'NUM::N');
  s = s.replace(/\b\d{5,}\b/g, 'NUM::LONG');
  s = s.replace(/(?:版权所有|Copyright|ICP备|公安备案|技术支持)[^\n]*/gi, '');
  s = s.replace(/(?:上一篇|下一篇|相关推荐|热门文章|推荐阅读)[^\n]*/g, '');
  return s;
}

function splitPortalCoreParts(core) {
  var listMarker = 'LIST::';
  var bodyMarker = '\nBODY::';
  if (core && core.indexOf(listMarker) === 0 && core.indexOf(bodyMarker) > 0) {
    var idx = core.indexOf(bodyMarker);
    return { list: core.slice(listMarker.length, idx), body: core.slice(idx + bodyMarker.length) };
  }
  return { list: '', body: core || '' };
}

function getBodyCoreText(fingerprints) {
  var parts = splitPortalCoreParts((fingerprints && fingerprints.core) || '');
  return parts.body || (fingerprints && fingerprints.core) || '';
}

function tokenizeForSimilarity(text) {
  return stabilizeVolatileText(text || '').split(/\s+/).filter(function (w) {
    return w.length > 1;
  });
}

function bodyTextSimilarity(a, b) {
  a = stabilizeVolatileText(a || '');
  b = stabilizeVolatileText(b || '');
  if (a === b) {
    return 1;
  }
  if (!a || !b) {
    return 0;
  }
  var shorter = a.length <= b.length ? a : b;
  var longer = a.length > b.length ? a : b;
  if (longer.indexOf(shorter) >= 0) {
    return shorter.length / longer.length;
  }
  var wordsA = tokenizeForSimilarity(a);
  var wordsB = tokenizeForSimilarity(b);
  if (!wordsA.length || !wordsB.length) {
    return 0;
  }
  var setB = {};
  for (var i = 0; i < wordsB.length; i++) {
    setB[wordsB[i]] = true;
  }
  var overlap = 0;
  for (var j = 0; j < wordsA.length; j++) {
    if (setB[wordsA[j]]) {
      overlap++;
    }
  }
  var union = wordsA.length + wordsB.length - overlap;
  return union > 0 ? overlap / union : 0;
}

function isLikelySameBodyContent(prevText, nextText) {
  return bodyTextSimilarity(prevText, nextText) >= 0.88;
}

var HIGH_CHURN_TEST_URL_RE = /\/uuid(?:\/|$|\?)|random\.org\/integers/i;

function isHighChurnTestUrl(url) {
  if (!url) {
    return false;
  }
  try {
    var parsed = new URL(url);
    var host = (parsed.hostname || '').toLowerCase();
    if (host === 'httpbingo.org' || host.endsWith('.httpbingo.org') ||
        host === 'httpbin.org' || host.endsWith('.httpbin.org')) {
      return true;
    }
    if (HIGH_CHURN_TEST_URL_RE.test(parsed.pathname + (parsed.search || ''))) {
      return true;
    }
    if (host.indexOf('random.org') >= 0) {
      return true;
    }
  } catch (e) {}
  return false;
}

function stabilizeVolatilePortalText(text) {
  return stabilizeVolatileText(text);
}

function finalizeFingerprints(fingerprints, hostname) {
  if (!fingerprints) {
    return fingerprints;
  }
  fingerprints.core = stabilizeVolatileText(fingerprints.core || '');
  fingerprints.overlaySignature = stabilizeVolatileText(fingerprints.overlaySignature || '');
  return fingerprints;
}

function finalizePortalFingerprints(fingerprints, hostname) {
  return finalizeFingerprints(fingerprints, hostname);
}

function sanitizeHtmlCore(html, hostname, pageUrl) {
  var highSens = isHighSensitivityHost(hostname);
  var s = stripHtmlComments(html || '');
  s = stripHtmlBlocks(s, 'script');
  s = stripHtmlBlocks(s, 'style');
  s = stripHtmlBlocks(s, 'noscript');
  if (!highSens) {
    s = stripHtmlBlocks(s, 'iframe');
    s = stripHtmlBlocks(s, 'svg');
  }
  s = extractMainHtmlChunk(s, hostname, pageUrl);
  if (!highSens) {
    s = stripAdLikeTags(s);
  }
  var core = normalizeWhitespace(stripTagsLite(s));
  if (highSens) {
    var listSnap = extractListSnapshotFromHtml(html);
    core = attachPortalListCore(core, pageUrl, listSnap);
  }
  return core;
}

function analyzeFetchedHtml(html, url) {
  var hostname = '';
  try {
    hostname = new URL(url || '').hostname;
  } catch (e) {}
  var highSens = isHighSensitivityHost(hostname);
  return finalizeFingerprints({
    raw: html || '',
    core: sanitizeHtmlCore(html, hostname, url),
    overlaySignature: highSens ? extractOverlaySignatureFromHtml(html) : ''
  }, hostname);
}

var MAIN_CONTENT_RE = [
  /<main[\s>][\s\S]*?<\/main>/i,
  /<article[\s>][\s\S]*?<\/article>/i,
  /<div[^>]+id=["']content["'][\s>][\s\S]*?<\/div>/i,
  /<div[^>]+id=["']main["'][\s>][\s\S]*?<\/div>/i,
  /<div[^>]+class=["'][^"']*(?:main-content|page-content|content-main|article-content)[^"']*["'][\s>][\s\S]*?<\/div>/i
];

function normalizeWhitespace(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function stripHtmlBlocks(html, tagName) {
  var re = new RegExp('<' + tagName + '[\\s>][\\s\\S]*?<\\/' + tagName + '>', 'gi');
  return html.replace(re, '');
}

function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function tagLooksAdLike(tagChunk) {
  return AD_KEYWORDS_RE.test(tagChunk);
}

function stripAdLikeTags(html) {
  var result = html;
  var blockRe = /<([a-z][a-z0-9]*)([^>]*)>[\s\S]*?<\/\1>/gi;
  var prev;
  do {
    prev = result;
    result = result.replace(blockRe, function (full, tag, attrs) {
      if (tagLooksAdLike(attrs)) {
        return '';
      }
      return full;
    });
  } while (result !== prev);
  return result;
}

function extractMainHtmlChunk(html, hostname, pageUrl) {
  hostname = hostname || '';
  var detailPage = looksLikePortalDetailPage(pageUrl);
  if (isHighSensitivityHost(hostname) && !detailPage) {
    var tbodyMatch = html.match(/<tbody[\s>][\s\S]*?<\/tbody>/i);
    if (tbodyMatch && tbodyMatch[0].length >= 80) {
      return tbodyMatch[0];
    }
    var tableMatch = html.match(/<table[\s>][\s\S]*?<\/table>/i);
    if (tableMatch && tableMatch[0].length >= 80) {
      return tableMatch[0];
    }
  }
  for (var i = 0; i < MAIN_CONTENT_RE.length; i++) {
    var match = html.match(MAIN_CONTENT_RE[i]);
    if (match && match[0].length >= 120) {
      return match[0];
    }
  }
  var bodyMatch = html.match(/<body[\s>][\s\S]*?<\/body>/i);
  if (bodyMatch) {
    return bodyMatch[0];
  }
  return html;
}

function extractPageFingerprintsInPage() {
  try {
  var AD_KEYWORDS_LOCAL = /(?:^|[^a-z0-9])(?:ads?|advert(?:isement)?|banner|popup|pop-up|modal|overlay|sponsor|promo(?:tion)?|floating|float-ad|\u5e7f\u544a|\u63a8\u5e7f|\u5f39\u7a97|\u6d6e\u5c42)(?:[^a-z0-9]|$)/i;
  var HIGH_SENS_HOST_RE = /(?:^|\.)ahtba\.org\.cn$|(?:^|\.)ggzy\.hefei\.gov\.cn$/i;
  var PORTAL_SELECTORS = [
    'table tbody',
    '.list-content',
    '.news-list',
    '.notice-list',
    '[class*="affiche"]',
    '[class*="trade"]',
    '[class*="list-box"]',
    '[class*="listBox"]',
    '[id*="list"]',
    '.el-table__body',
    '.ant-table-tbody'
  ];
  var highSens = HIGH_SENS_HOST_RE.test(location.hostname || '');

  function isAdKeyword(text) {
    return AD_KEYWORDS_LOCAL.test(text || '');
  }

  function isExtensionUiNode(el) {
    if (!el || !el.id) {
      return false;
    }
    var id = el.id;
    return id.indexOf('link-monitor') >= 0 || id.indexOf('lm-ahtba') >= 0;
  }

  function extractListSnapshotLocal() {
    var parts = [];
    var seen = {};
    var selectors = [
      'table tbody tr',
      'ul li',
      '.list-item',
      '[class*="list"] tr',
      '[class*="item"]',
      'a[href]'
    ];
    for (var s = 0; s < selectors.length; s++) {
      try {
        var nodes = document.querySelectorAll(selectors[s]);
        for (var i = 0; i < nodes.length && parts.length < 80; i++) {
          if (isExtensionUiNode(nodes[i]) || nodes[i].closest('[id*="link-monitor"], [id*="lm-ahtba"]')) {
            continue;
          }
          var text = (nodes[i].innerText || '').replace(/\s+/g, ' ').trim();
          if (text.length < 6 || seen[text]) {
            continue;
          }
          seen[text] = true;
          parts.push(text.slice(0, 160));
        }
      } catch (e) {}
    }
    return parts.join('\n');
  }

  function isLikelyAdOverlay(el) {
    if (!el || el === document.body || el === document.documentElement) {
      return false;
    }
    var id = (el.id || '').toLowerCase();
    var cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
    var marker = id + ' ' + cls;
    if (isAdKeyword(marker)) {
      return true;
    }
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    var pos = style.position;
    if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') {
      return false;
    }
    var z = parseInt(style.zIndex, 10);
    var zMin = highSens ? 200 : 500;
    if (isNaN(z) || z < zMin) {
      return false;
    }
    if (el.offsetWidth < 80 || el.offsetHeight < 80) {
      return false;
    }
    var text = (el.innerText || '').slice(0, 80);
    if (isAdKeyword(text) || isAdKeyword(marker)) {
      return true;
    }
    var sizeMin = highSens ? 150 : 200;
    var heightMin = highSens ? 80 : 120;
    if (z >= (highSens ? 800 : 1000) && el.offsetWidth >= sizeMin && el.offsetHeight >= heightMin) {
      return true;
    }
    return false;
  }

  function removeNoiseNodes(root) {
    var tags = ['script', 'style', 'noscript', 'iframe', 'svg', 'link'];
    for (var t = 0; t < tags.length; t++) {
      var nodes = root.querySelectorAll(tags[t]);
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].remove();
      }
    }
    var all = root.querySelectorAll('*');
    for (var j = all.length - 1; j >= 0; j--) {
      var el = all[j];
      var id = (el.id || '').toLowerCase();
      var cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
      if (isAdKeyword(id + ' ' + cls)) {
        el.remove();
      }
    }
  }

  function pickCoreElement() {
    if (highSens && looksLikePortalDetailPage(location.href)) {
      var detailSelectors = [
        'article',
        '.article-content',
        '.detail-content',
        '.content-detail',
        '.notice-content',
        '.affiche-content',
        '#content',
        'main',
        '.main-content',
        '.page-content'
      ];
      for (var d = 0; d < detailSelectors.length; d++) {
        try {
          var detailEl = document.querySelector(detailSelectors[d]);
          if (detailEl && (detailEl.innerText || '').trim().length >= 40) {
            return detailEl;
          }
        } catch (e) {}
      }
    }
    if (highSens) {
      for (var p = 0; p < PORTAL_SELECTORS.length; p++) {
        try {
          var portalEl = document.querySelector(PORTAL_SELECTORS[p]);
          if (portalEl && (portalEl.innerText || '').trim().length >= 20) {
            return portalEl;
          }
        } catch (e) {}
      }
      var tables = document.querySelectorAll('table');
      for (var t = 0; t < tables.length; t++) {
        if ((tables[t].innerText || '').trim().length >= 40) {
          return tables[t];
        }
      }
    }
    var selectors = [
      'main',
      '[role="main"]',
      '#content',
      '#main',
      '.main-content',
      '.page-content',
      '.content-main',
      '.article-content',
      'article'
    ];
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = document.querySelector(selectors[i]);
        if (el && (el.innerText || '').trim().length >= 40) {
          return el;
        }
      } catch (e) {}
    }
    return document.body;
  }

  var raw = document.documentElement ? document.documentElement.outerHTML : '';
  var coreRoot = pickCoreElement();
  var coreText = '';
  if (coreRoot) {
    var wrapper = document.createElement('div');
    wrapper.innerHTML = coreRoot.innerHTML;
    removeNoiseNodes(wrapper);
    coreText = normalizeWhitespace(wrapper.innerText || stripTagsLite(wrapper.innerHTML));
  }
  if (highSens) {
    var listSnap = extractListSnapshotLocal();
    coreText = attachPortalListCore(coreText, location.href, listSnap);
  }

  var overlayParts = [];
  var candidates = document.querySelectorAll('div, section, aside, iframe');
  var overlayLimit = highSens ? 400 : 800;
  for (var k = 0; k < candidates.length && k < overlayLimit; k++) {
    var node = candidates[k];
    if (isLikelyAdOverlay(node)) {
      overlayParts.push(
        (node.id || '') + '|' +
        (typeof node.className === 'string' ? node.className : '') + '|' +
        (node.innerText || '').slice(0, 60)
      );
    }
  }

  return finalizePortalFingerprints({
    raw: raw,
    core: coreText,
    overlaySignature: overlayParts.join(';;')
  }, location.hostname || '');
  } catch (e) {
    var bodyText = '';
    try {
      bodyText = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20000);
    } catch (e2) {}
    return {
      raw: document.documentElement ? document.documentElement.outerHTML.slice(0, 300000) : '',
      core: bodyText,
      overlaySignature: ''
    };
  }
}
