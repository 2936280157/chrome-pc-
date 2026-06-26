'use strict';

function sendResponse(action) {
  chrome.runtime.sendMessage({
    type: 'THROTTLE_ASK_RESPONSE',
    action: action
  }).then(function () {
    window.close();
  });
}

document.getElementById('title').textContent =
  '\u5f39\u7a97\u63d0\u9192\u8fc7\u4e8e\u9891\u7e41';
document.getElementById('message').textContent =
  '60 \u5206\u949f\u5185\u5f39\u7a97\u5df2\u8d85\u8fc7 40 \u6b21\u3002\u9009\u62e9\u300c\u51cf\u7f13\u300d\u5c06\u6682\u505c Chrome \u5f39\u7a97\u4e0e\u7f51\u9875\u906e\u7f69\uff0c\u5e76\u4ec5\u628a\u89e6\u53d1\u8fc7\u9891\u7684\u94fe\u63a5\u68c0\u67e5\u95f4\u9694\u6539\u4e3a 30 \u5206\u949f\uff08\u5176\u4ed6\u94fe\u63a5\u95f4\u9694\u4e0d\u53d8\uff0c\u4ecd\u4fdd\u7559\u7cfb\u7edf\u901a\u77e5\uff09\u3002';

var btnPause = document.getElementById('btn-pause');
var btnContinue = document.getElementById('btn-continue');
btnPause.textContent = '\u51cf\u7f13\uff0830 \u5206\u949f\u95f4\u9694\uff09';
btnContinue.textContent = '\u7ee7\u7eed\u5f39\u7a97\u63d0\u9192';

btnPause.addEventListener('click', function () {
  sendResponse('pause');
});

btnContinue.addEventListener('click', function () {
  sendResponse('continue');
});
