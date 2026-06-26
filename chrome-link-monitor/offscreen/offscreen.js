'use strict';

function beep(ctx, startTime, frequency, duration) {
  var oscillator = ctx.createOscillator();
  var gain = ctx.createGain();

  oscillator.type = 'square';
  oscillator.frequency.value = frequency;
  oscillator.connect(gain);
  gain.connect(ctx.destination);

  gain.gain.setValueAtTime(0.45, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

  oscillator.start(startTime);
  oscillator.stop(startTime + duration);
}

function playAlertBeeps() {
  var ctx = new AudioContext();
  var now = ctx.currentTime;

  beep(ctx, now, 880, 0.15);
  beep(ctx, now + 0.2, 1100, 0.15);
  beep(ctx, now + 0.4, 1320, 0.25);
}

function showWebNotification(title, body) {
  if (!('Notification' in window)) {
    return;
  }

  function display() {
    var n = new Notification(title, {
      body: body,
      requireInteraction: true,
      silent: false
    });
    n.onclick = function () {
      n.close();
    };
  }

  if (Notification.permission === 'granted') {
    display();
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(function (perm) {
      if (perm === 'granted') {
        display();
      }
    });
  }
}

chrome.runtime.onMessage.addListener(function (message) {
  if (message.type === 'PLAY_ALERT') {
    playAlertBeeps();
  }
  if (message.type === 'SHOW_WEB_NOTIFICATION') {
    showWebNotification(message.title, message.body);
  }
});
