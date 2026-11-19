// "Capture Roster" bookmarklet. Runs only when you tap it in Safari.
// On a login page: fills in your username (never a password) if Safari hasn't already.
// On the roster page: snapshots the visible roster (text + tables + cleaned page structure) and
// offers a Copy button. It never captures form field values, scripts, cookies or URL query strings.
(function () {
  var MS_EMAIL = '__MS_EMAIL__';
  var SABRE_ID = '__SABRE_ID__';
  var ID = 'prm-capture-overlay';
  var old = document.getElementById(ID); if (old) old.remove();

  function overlay(html, wire) {
    var o = document.createElement('div');
    o.id = ID;
    o.setAttribute('style', 'position:fixed;inset:auto 12px 12px 12px;z-index:2147483647;background:#3a0f4f;color:#fff;font:16px -apple-system,sans-serif;padding:16px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.4)');
    o.innerHTML = html + '<button data-x style="position:absolute;top:8px;right:10px;background:none;border:0;color:#fff;font-size:22px">×</button>';
    document.body.appendChild(o);
    o.querySelector('[data-x]').onclick = function () { o.remove(); };
    if (wire) wire(o);
  }
  var btn = 'style="font:600 17px -apple-system,sans-serif;padding:12px 18px;border-radius:10px;border:0;background:#c8102e;color:#fff;margin-top:10px"';

  function setVal(el, v) {
    var proto = Object.getPrototypeOf(el);
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function visible(el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; }

  // ---------- login helper ----------
  var docs = [document];
  (function walk(d) { var fr = d.querySelectorAll('iframe,frame'); for (var i = 0; i < fr.length; i++) { try { var cd = fr[i].contentDocument; if (cd && cd.body) { docs.push(cd); walk(cd); } } catch (e) { } } })(document);

  var host = location.hostname;
  var isMs = /login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com/.test(host);
  var userField = null; var pw = null;
  docs.forEach(function (d) {
    var p = [].filter.call(d.querySelectorAll('input[type=password]'), visible)[0];
    if (p && !pw) pw = p;
    if (isMs) { var em = [].filter.call(d.querySelectorAll('input[type=email],input[name=loginfmt]'), visible)[0]; if (em && !userField) userField = em; }
  });
  if (!isMs && pw) {
    var inputs = [].filter.call((pw.form || pw.ownerDocument).querySelectorAll('input[type=text],input[type=email],input[type=tel],input[type=number],input:not([type])'), visible);
    var before = inputs.filter(function (i) { return i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING; });
    userField = before[before.length - 1] || inputs[0] || null;
  }
  if (userField || (pw && !userField)) {
    var who = isMs ? MS_EMAIL : SABRE_ID;
    var msg;
    if (userField && !userField.value && who && who.indexOf('__') !== 0) { setVal(userField, who); msg = 'Filled in ' + (isMs ? 'your Microsoft email' : 'your Sabre User ID') + '.'; }
    else if (userField && userField.value) msg = 'Username is already filled in.';
    else msg = 'This looks like a login page, but no username field was found.';
    overlay('<b>Login page</b><div style="margin-top:6px">' + msg + ' Use Safari’s password suggestion (key icon above the keyboard) for the password, then sign in. Tap the bookmark again on the roster page.</div>');
    return;
  }

  // ---------- roster capture ----------
  var KEEP = { 'class': 1, id: 1, colspan: 1, rowspan: 1, title: 1, headers: 1, scope: 1, role: 1, 'aria-label': 1 };
  var DROP = 'script,style,noscript,svg,canvas,iframe,frame,object,embed,input,select,textarea,button,link,meta,img,video,audio,template';
  function cleanHtml(d) {
    var c = d.body.cloneNode(true);
    var rm = c.querySelectorAll(DROP); for (var i = 0; i < rm.length; i++) rm[i].remove();
    var all = c.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      for (var k = el.attributes.length - 1; k >= 0; k--) {
        var n = el.attributes[k].name;
        if (!KEEP[n] && n.indexOf('data-') !== 0) el.removeAttribute(n);
      }
    }
    var h = c.innerHTML.replace(/\s{2,}/g, ' ');
    return h.length > 1500000 ? h.slice(0, 1500000) + '<!-- truncated -->' : h;
  }
  function tables(d) {
    return [].map.call(d.querySelectorAll('table'), function (t) {
      return {
        id: t.id || '', cls: t.className || '',
        rows: [].map.call(t.rows, function (r) {
          return [].map.call(r.cells, function (c) {
            var o = { t: (c.innerText || c.textContent || '').trim() };
            if (c.colSpan > 1) o.cs = c.colSpan; if (c.rowSpan > 1) o.rs = c.rowSpan; if (c.tagName === 'TH') o.h = 1;
            var tt = c.getAttribute('title'); if (tt) o.title = tt;
            return o;
          });
        })
      };
    }).filter(function (t) { return t.rows.length; });
  }
  var frames = docs.map(function (d) {
    var l = d.location || {};
    return {
      host: l.hostname || '', path: l.pathname || '', title: d.title || '',
      text: (d.body.innerText || '').slice(0, 500000),
      tables: tables(d), html: cleanHtml(d)
    };
  }).filter(function (f) { return f.text.trim() || f.tables.length; });

  var payload = JSON.stringify({
    format: 'prm-capture', v: 1, capturedAt: new Date().toISOString(),
    tzOffsetMin: -new Date().getTimezoneOffset(), userAgent: navigator.userAgent,
    url: location.origin + location.pathname, title: document.title, frames: frames
  });
  var kb = Math.round(payload.length / 1024);
  var nTables = frames.reduce(function (a, f) { return a + f.tables.length; }, 0);

  overlay('<b>Roster captured</b><div style="margin-top:6px">' + frames.length + ' frame(s), ' + nTables + ' table(s), ' + kb + ' KB. Tap Copy, then open Roster Manager and tap Import.</div><button data-copy ' + btn + '>Copy</button><div data-msg style="margin-top:8px"></div>', function (o) {
    o.querySelector('[data-copy]').onclick = function () {
      var done = function () { o.querySelector('[data-msg]').textContent = '✓ Copied. Switch to Roster Manager and tap Import from clipboard.'; };
      var fallback = function () {
        var ta = document.createElement('textarea'); ta.value = payload; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, payload.length);
        var ok = false; try { ok = document.execCommand('copy'); } catch (e) { }
        ta.remove();
        if (ok) done(); else o.querySelector('[data-msg]').textContent = 'Copy was blocked by the page. Try again, or tell Claude the page blocked copying.';
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(payload).then(done, fallback); else fallback();
    };
  });
})();
