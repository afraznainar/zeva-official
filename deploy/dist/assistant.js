/* Ask Zeva — the restaurant's AI assistant widget.
   Self-contained: injects its own styles and markup, talks to /api/ask.
   Written in ES5 so it parses and runs everywhere the site does. */
(function () {
  'use strict';
  if (window.__zevaAssistant) return;
  window.__zevaAssistant = true;

  var STORE_KEY = 'zeva_chat_v1';
  var PHONE = '+917022771888';

  var CHIPS = [
    'What is mandi?',
    'How much is chicken mandi?',
    'What are your timings?',
    'Where are you located?',
    'Do you deliver?',
    'How do I order?',
    'What are the famous dishes?',
    'How do I leave a review?'
  ];

  var GREETING = 'Assalamu alaikum! 👋 I\'m the Zeva Mandi & Grills assistant — ask me anything about our menu, prices, timings, delivery, pickup or reviews.';

  /* ------------------------------------------------------------ styles */
  var css = ''
    + '.zv-fab{position:fixed;left:calc(18px + env(safe-area-inset-left,0px));bottom:calc(18px + env(safe-area-inset-bottom,0px));z-index:65;'
    + 'display:inline-flex;align-items:center;gap:8px;background:var(--gold,#bc7835);color:#34160c;border:0;border-radius:999px;'
    + 'padding:13px 20px;font-family:var(--body,Figtree,Arial,sans-serif);font-weight:800;font-size:14.5px;letter-spacing:.02em;'
    + 'cursor:pointer;box-shadow:0 14px 34px rgba(42,19,9,.32);transition:transform .25s cubic-bezier(.22,.9,.3,1),box-shadow .25s;min-height:48px}'
    + '.zv-fab:hover{transform:translateY(-2px);box-shadow:0 18px 40px rgba(42,19,9,.4)}'
    + '.zv-fab .zv-ic{font-size:17px;line-height:1}'
    + 'body:has(.cart-drawer.open) .zv-fab,body.zv-drawer-open .zv-fab{display:none!important}'
    + '.zv-panel{position:fixed;left:calc(18px + env(safe-area-inset-left,0px));bottom:calc(78px + env(safe-area-inset-bottom,0px));'
    + 'z-index:95;width:min(404px,calc(100vw - 36px));height:min(568px,calc(100dvh - 130px));display:flex;flex-direction:column;'
    + 'background:var(--paper,#fffdf8);border:1px solid #eadfc8;border-radius:18px;overflow:hidden;'
    + 'box-shadow:0 28px 70px rgba(42,19,9,.34);opacity:0;transform:translateY(14px) scale(.98);pointer-events:none;'
    + 'transition:opacity .28s cubic-bezier(.22,.9,.3,1),transform .28s cubic-bezier(.22,.9,.3,1)}'
    + '.zv-panel.open{opacity:1;transform:none;pointer-events:auto}'
    + '.zv-head{background:linear-gradient(120deg,#813d20,#34160c);color:var(--cream,#fdf6e9);padding:14px 16px;display:flex;'
    + 'align-items:center;justify-content:space-between;gap:10px;flex-shrink:0}'
    + '.zv-title{font-family:var(--display,"Figtree",Arial Black,Arial,sans-serif);font-weight:900;text-transform:uppercase;letter-spacing:.06em;'
    + 'font-size:17px;line-height:1.15}.zv-title span{display:block;font-family:var(--body,Figtree,Arial,sans-serif);font-weight:600;'
    + 'font-size:11.5px;letter-spacing:.06em;text-transform:none;color:rgba(253,246,233,.8);margin-top:3px}'
    + '.zv-x{background:none;border:0;color:rgba(253,246,233,.85);font-size:26px;line-height:1;cursor:pointer;padding:2px 6px}'
    + '.zv-x:hover{color:#f2d5a8}'
    + '.zv-msgs{flex:1;overflow-y:auto;padding:14px 14px 6px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}'
    + '.zv-m{max-width:92%;padding:10px 13px;border-radius:14px;font-size:14.5px;line-height:1.55;word-wrap:break-word}'
    + '.zv-m.u{align-self:flex-end;background:#813d20;color:#fdf6e9;border-bottom-right-radius:5px}'
    + '.zv-m.b{align-self:flex-start;background:#f6ecd8;color:#2b1a12;border-bottom-left-radius:5px;border:1px solid #eadfc8}'
    + '.zv-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}'
    + '.zv-pill{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;text-decoration:none;padding:3px 9px;'
    + 'border-radius:999px;background:rgba(129,61,32,.08);color:#813d20;border:1px solid rgba(129,61,32,.14)}'
    + '.zv-pill:hover{background:#813d20;color:#fdf6e9}'
    + '.zv-typing{display:inline-flex;gap:4px;align-items:center;padding:13px 15px}'
    + '.zv-typing i{width:7px;height:7px;border-radius:50%;background:#b79b62;animation:zvBounce 1s infinite ease-in-out}'
    + '.zv-typing i:nth-child(2){animation-delay:.15s}.zv-typing i:nth-child(3){animation-delay:.3s}'
    + '@keyframes zvBounce{0%,80%,100%{transform:translateY(0);opacity:.5}40%{transform:translateY(-5px);opacity:1}}'
    + '.zv-chips{display:flex;gap:7px;overflow-x:auto;padding:8px 12px;flex-shrink:0;scrollbar-width:none}'
    + '.zv-chips::-webkit-scrollbar{display:none}'
    + '.zv-chip{flex:0 0 auto;border:1.5px solid #e3d5bb;background:#fff;color:#813d20;font-family:inherit;font-weight:700;'
    + 'font-size:12.5px;padding:7px 12px;border-radius:999px;cursor:pointer;transition:background .18s,border-color .18s;white-space:nowrap}'
    + '.zv-chip:hover{background:#bc7835;border-color:#bc7835;color:#34160c}'
    + '.zv-form{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #eadfc8;background:#fff;flex-shrink:0}'
    + '.zv-form input{flex:1;min-width:0;border:1.5px solid #e3d5bb;border-radius:999px;padding:10px 15px;font-family:inherit;'
    + 'font-size:16px;background:#fffdf8}'
    + '.zv-form input:focus{outline:none;border-color:#813d20}'
    + '.zv-send{border:0;background:#813d20;color:#fdf6e9;font-family:inherit;font-weight:800;font-size:13.5px;letter-spacing:.05em;'
    + 'text-transform:uppercase;border-radius:999px;padding:0 18px;cursor:pointer;min-height:44px}'
    + '.zv-send:hover{background:#34160c}'
    + '.zv-send:disabled{opacity:.45;cursor:not-allowed}'
    + '.zv-foot{font-size:11.5px;color:#6d5a4f;text-align:center;padding:7px 12px calc(9px + env(safe-area-inset-bottom,0px));'
    + 'background:#fff;border-top:1px solid #f3ead8;flex-shrink:0}'
    + '.zv-foot a{color:#813d20;font-weight:700}'
    + '@media (max-width:520px){.zv-panel{left:0;right:0;bottom:0;width:100%;height:min(84dvh,660px);border-radius:18px 18px 0 0;'
    + 'border-bottom:0;transform:translateY(20px)}'
    + '.zv-fab{left:calc(12px + env(safe-area-inset-left,0px));bottom:calc(12px + env(safe-area-inset-bottom,0px));padding:12px 16px;font-size:13.5px}}'
    + '@media (max-height:560px){.zv-panel{height:calc(100dvh - 96px)}}'
    + '@media (pointer:coarse){.zv-chip{padding:9px 13px;font-size:13px}}'
    + '@media print{.zv-fab,.zv-panel{display:none!important}}'
    + '@media (prefers-reduced-motion:reduce){.zv-panel{transition:none}.zv-typing i{animation:none}}';

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* markdown-lite: **bold**, line breaks, and /path link labels */
  function fmt(t) {
    var s = esc(t);
    s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    s = s.replace(/(^|[\s(])\/(menu|about|visit|faq|review-us|review)(?=[)\s.,!?]|$)/g,
      function (m, pre, path) { return pre + '<a href="/' + path + '" style="color:#813d20;font-weight:700">' + path + '</a>'; });
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  /* ------------------------------------------------------------ history */
  function loadHist() {
    try {
      var h = JSON.parse(localStorage.getItem(STORE_KEY));
      return (h && h.length) ? h : [];
    } catch (e) { return []; }
  }
  function saveHist(h) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(h.slice(-40))); } catch (e) {}
  }
  var hist = loadHist();
  var greeted = hist.length > 0;

  /* ------------------------------------------------------------ markup */
  var style = el('style'); style.textContent = css;
  document.head.appendChild(style);

  var fab = el('button', 'zv-fab');
  fab.type = 'button';
  fab.id = 'zv-fab';
  fab.setAttribute('aria-expanded', 'false');
  fab.setAttribute('aria-controls', 'zv-panel');
  fab.innerHTML = '<span class="zv-ic" aria-hidden="true">💬</span><span>Ask Zeva</span>';

  var panel = el('div', 'zv-panel');
  panel.id = 'zv-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Ask Zeva — restaurant assistant');
  panel.setAttribute('aria-hidden', 'true');
  panel.innerHTML = ''
    + '<div class="zv-head">'
    +   '<div class="zv-title">Ask Zeva<span>AI assistant · menu, timings, delivery</span></div>'
    +   '<button type="button" class="zv-x" aria-label="Close assistant">&times;</button>'
    + '</div>'
    + '<div class="zv-msgs" id="zv-msgs" aria-live="polite"></div>'
    + '<div class="zv-chips" id="zv-chips" role="group" aria-label="Suggested questions"></div>'
    + '<form class="zv-form" id="zv-form">'
    +   '<input type="text" id="zv-input" placeholder="Ask about menu, prices, timings…" autocomplete="off" maxlength="400" aria-label="Your question">'
    +   '<button type="submit" class="zv-send" id="zv-send">Ask</button>'
    + '</form>'
    + '<div class="zv-foot">Answers from Zeva\'s own menu &amp; info · <a href="tel:' + PHONE + '">070227 71888</a></div>';

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  var msgs = panel.querySelector('#zv-msgs');
  var chips = panel.querySelector('#zv-chips');
  var form = panel.querySelector('#zv-form');
  var input = panel.querySelector('#zv-input');
  var send = panel.querySelector('#zv-send');
  var closeBtn = panel.querySelector('.zv-x');
  var busy = false;

  CHIPS.forEach(function (c) {
    var b = el('button', 'zv-chip', esc(c));
    b.type = 'button';
    b.addEventListener('click', function () { input.value = c; ask(); });
    chips.appendChild(b);
  });

  function scrollDown() { msgs.scrollTop = msgs.scrollHeight; }

  function addMsg(role, text, meta) {
    var m = el('div', 'zv-m ' + (role === 'u' ? 'u' : 'b'));
    m.innerHTML = fmt(text);
    if (meta && meta.length) {
      var wrap = el('div', 'zv-meta');
      meta.forEach(function (src) {
        var a = el('a', 'zv-pill', src === '/menu' ? 'See menu' : src === '/faq' ? 'FAQ' : src === '/visit' ? 'Visit' : src === '/review-us' ? 'Review us' : src);
        a.href = src === '/menu' ? 'menu.html' : src === '/faq' ? 'faq.html' : src === '/visit' ? 'visit.html' : src === '/review-us' ? 'review-us.html' : src;
        a.setAttribute('aria-label', 'Open ' + src + ' page');
        wrap.appendChild(a);
      });
      m.appendChild(wrap);
    }
    msgs.appendChild(m);
    scrollDown();
    return m;
  }

  function addTyping() {
    var t = el('div', 'zv-m b zv-typing', '<i></i><i></i><i></i>');
    t.setAttribute('aria-label', 'Assistant is typing');
    msgs.appendChild(t);
    scrollDown();
    return t;
  }

  function restore() {
    if (!hist.length) return;
    for (var i = 0; i < hist.length; i++) addMsg(hist[i].r, hist[i].t, hist[i].m);
  }

  function ask() {
    var q = input.value.replace(/\s+/g, ' ').trim();
    if (!q || busy) return;
    busy = true;
    send.disabled = true;
    input.value = '';
    addMsg('u', q);
    hist.push({ r: 'u', t: q });
    saveHist(hist);
    var typing = addTyping();

    fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: q })
    }).then(function (res) {
      if (!res.ok) throw new Error('http ' + res.status);
      return res.json();
    }).then(function (data) {
      typing.parentNode.removeChild(typing);
      if (!data || !data.answer) throw new Error('empty');
      addMsg('b', data.answer, data.sources);
      hist.push({ r: 'b', t: data.answer, m: data.sources });
      saveHist(hist);
    }, function () {
      typing.parentNode.removeChild(typing);
      addMsg('b', 'I could not reach the assistant just now — please try again, or call us on ' +
        '**070227 71888** (open 12 PM – 11 PM daily).');
    }).then(function () {
      busy = false;
      send.disabled = false;
      input.focus();
    }, function () {
      busy = false;
      send.disabled = false;
      input.focus();
    });
  }

  function open() {
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    fab.setAttribute('aria-expanded', 'true');
    if (!greeted) {
      greeted = true;
      addMsg('b', GREETING, ['/menu', '/faq']);
      scrollDown();
    } else if (!hist.length) {
      addMsg('b', GREETING, ['/menu', '/faq']);
    }
    restore();
    setTimeout(function () { input.focus(); }, 60);
  }

  function close() {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    fab.setAttribute('aria-expanded', 'false');
    fab.focus();
  }

  fab.addEventListener('click', function () {
    if (panel.classList.contains('open')) close(); else open();
  });
  closeBtn.addEventListener('click', close);
  form.addEventListener('submit', function (e) { e.preventDefault(); ask(); });
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Escape' || e.keyCode === 27) && panel.classList.contains('open')) close();
  });
  document.addEventListener('click', function (e) {
    if (!panel.classList.contains('open')) return;
    if (panel.contains(e.target) || fab.contains(e.target)) return;
    close();
  });

  /* hide the button while the order drawer is open (mobile full-screen) */
  document.addEventListener('click', function () {
    setTimeout(function () {
      var open = !!document.querySelector('.cart-drawer.open');
      document.body.classList.toggle('zv-drawer-open', open);
    }, 60);
  }, true);
})();
