// Google sends the sign-in code here (a fixed, public address Google can redirect to). This page
// hands it straight back to the Roster app in Home Assistant. The code is useless without the
// client secret, which only the Home Assistant app holds.
(function () {
  var q = location.search.slice(1);
  var p = new URLSearchParams(q);
  var state = p.get('state') || '';
  var ret = '';
  try {
    var b64 = state.split('.').slice(1).join('.').replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    ret = b64 ? atob(b64) : '';
  } catch (e) { ret = ''; }
  var ok = /^https:\/\/[^/]+\/api\/hassio_ingress\/[^/]+\/?$/.test(ret) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(ret);
  document.getElementById('code').value = '?' + q;
  document.getElementById('copy').addEventListener('click', function () {
    var t = document.getElementById('code');
    var done = function () { document.getElementById('copied').textContent = '✓ Copied'; };
    if (navigator.clipboard) navigator.clipboard.writeText(t.value).then(done, function () { t.select(); document.execCommand('copy'); done(); });
    else { t.select(); document.execCommand('copy'); done(); }
  });
  if (p.get('error')) {
    document.getElementById('head').textContent = 'Google sign-in was cancelled';
    document.getElementById('msg').textContent = 'Error: ' + p.get('error') + '. Go back to Roster → Settings and try Connect Google again.';
    return;
  }
  document.getElementById('manual').hidden = false;
  if (ok && p.get('code')) {
    location.replace(ret.replace(/\/?$/, '/') + '#/oauth?' + q);
  } else {
    document.getElementById('head').textContent = 'Almost done';
    document.getElementById('msg').textContent = 'Copy the text below into Roster Manager to finish connecting Google.';
  }
})();
