// Builds the bookmark URL with your (non-secret) usernames, passed from Settings in the page address.
(function () {
  var p = new URLSearchParams(location.hash.slice(1));
  var email = p.get('email') || '';
  var id = p.get('id') || '';
  var lit = function (s) { return JSON.stringify(s).slice(1, -1).replace(/'/g, "\\'"); };
  var code = window.PRM_BOOKMARKLET
    .replace('__MS_EMAIL__', email ? lit(email) : '__MS_EMAIL__')
    .replace('__SABRE_ID__', id ? lit(id) : '__SABRE_ID__');
  var url = 'javascript:' + encodeURIComponent(code);
  document.getElementById('code').value = url;
  document.getElementById('who').textContent = (email || 'no Microsoft email') + ' · ' + (id || 'no Sabre ID') + (email || id ? '' : ' (open this page from the app’s Settings to include them)');
  var msg = document.getElementById('msg');
  document.getElementById('copy').addEventListener('click', function () {
    var ta = document.getElementById('code');
    var ok = function () { msg.textContent = '✓ Copied. Now add the bookmark and paste it as the address.'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(ok, function () { ta.parentElement.open = true; ta.select(); msg.textContent = 'Select the code below and copy it.'; });
    else { ta.parentElement.open = true; ta.select(); document.execCommand('copy'); ok(); }
  });
})();
