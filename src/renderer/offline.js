const heading = document.getElementById('heading');
const subtitle = document.getElementById('subtitle');
const detailsBox = document.getElementById('detailsBox');
const errorRow = document.getElementById('errorRow');
const errorCodeLabel = document.getElementById('errorCodeLabel');
const errorValue = document.getElementById('errorValue');
const urlRow = document.getElementById('urlRow');
const urlLabel = document.getElementById('urlLabel');
const urlValue = document.getElementById('urlValue');
const retryBtn = document.getElementById('retryBtn');
const retryIcon = document.getElementById('retryIcon');
const retryLabel = document.getElementById('retryLabel');
const hint = document.getElementById('hint');

let retryingText = 'Connecting...';
let retryText = 'Retry Connection';
let isRetrying = false;

function applyOfflineInfo(info) {
  if (!info || typeof info !== 'object') return;
  if (info.lang) {
    document.documentElement.lang = info.lang;
  }
  const s = info.strings || {};
  if (s.pageTitle) document.title = s.pageTitle;
  if (s.heading) heading.textContent = s.heading;
  if (s.subtitle) subtitle.textContent = s.subtitle;
  if (s.errorCodeLabel) errorCodeLabel.textContent = s.errorCodeLabel;
  if (s.urlLabel) urlLabel.textContent = s.urlLabel;
  if (s.retryBtn) {
    retryText = s.retryBtn;
    if (!isRetrying) retryLabel.textContent = retryText;
  }
  if (s.retryingBtn) {
    retryingText = s.retryingBtn;
    if (isRetrying) retryLabel.textContent = retryingText;
  }
  if (s.hint) hint.textContent = s.hint;

  const hasErr = Boolean(info.errorDescription || info.errorCode !== '');
  const errText = [info.errorDescription, info.errorCode !== '' ? `(${info.errorCode})` : '']
    .filter(Boolean)
    .join(' ');
  if (hasErr && errText) {
    errorValue.textContent = errText;
    errorRow.classList.remove('is-hidden');
  } else {
    errorRow.classList.add('is-hidden');
  }

  if (info.validatedURL) {
    urlValue.textContent = info.validatedURL;
    urlRow.classList.remove('is-hidden');
  } else {
    urlRow.classList.add('is-hidden');
  }

  detailsBox.classList.toggle('visible', Boolean((hasErr && errText) || info.validatedURL));
}

function triggerRetry() {
  if (isRetrying) return;
  isRetrying = true;
  retryBtn.disabled = true;
  retryIcon.classList.add('spin');
  retryLabel.textContent = retryingText;
  if (window.offlineAPI) {
    window.offlineAPI.retryLoad();
  }
  setTimeout(() => {
    isRetrying = false;
    retryBtn.disabled = false;
    retryIcon.classList.remove('spin');
    retryLabel.textContent = retryText;
  }, 4500);
}

retryBtn.addEventListener('click', triggerRetry);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key.toLowerCase() === 'r') {
    e.preventDefault();
    triggerRetry();
  }
});

if (window.offlineAPI) {
  window.offlineAPI.onInfo(applyOfflineInfo);
  window.offlineAPI.getInfo().then(applyOfflineInfo).catch(() => {});
}
