/* Zeva sign-up sheet.
   Every public page loads this. The sheet opens a couple of seconds after the
   page does, but only for a visitor who is not signed in: it asks /api/me
   first, and it stays away entirely when WhatsApp sign-in is switched off or
   when the visitor already said "Not now" on this tab. */
(function () {
  'use strict';

  var SKIP_KEY = 'zeva.signup.skipped';
  var DELAY = 2500;    // inside the first three seconds
  var MAX_WAIT = 3000; // never hold the sheet back longer than the check takes

  try { if (sessionStorage.getItem(SKIP_KEY) === '1') return; } catch (e) { }

  var CSS = `
  .zsg {
    position: fixed; inset: 0; z-index: 90; display: grid; place-items: center;
    padding: 20px; background: rgba(7, 4, 2, .74);
    -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
    font-family: 'Figtree', system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #fdf8ee; line-height: 1.6; text-align: left;
  }
  .zsg[hidden] { display: none; }
  .zsg *, .zsg *::before, .zsg *::after { box-sizing: border-box; }
  .zsg-card {
    position: relative; width: 100%; max-width: 404px;
    border: 1px solid rgba(253, 248, 238, .2); border-radius: 18px;
    background: #150c07; padding: 28px 26px 22px;
    box-shadow: 0 40px 90px rgba(0, 0, 0, .55);
    animation: zsg-in .22s cubic-bezier(.2, .7, .3, 1);
  }
  @keyframes zsg-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .zsg-card { animation: none; } }
  .zsg-x {
    position: absolute; top: 12px; right: 12px; width: 34px; height: 34px;
    border-radius: 50%; background: none; border: 1px solid rgba(253, 248, 238, .1);
    color: #b9a894; font-size: 18px; line-height: 1; cursor: pointer;
  }
  .zsg-x:hover { border-color: rgba(253, 248, 238, .3); color: #fdf8ee; }
  .zsg-kicker {
    margin: 0 0 10px; font-size: 11px; letter-spacing: .12em;
    text-transform: uppercase; color: #bc7835; font-weight: 600;
  }
  .zsg-card h2 {
    margin: 0 0 10px; font-family: 'Newsreader', Georgia, serif; font-weight: 400;
    font-size: 26px; line-height: 1.16; letter-spacing: -.01em; color: #fdf8ee;
  }
  .zsg-copy { margin: 0 0 20px; font-size: 14px; color: #b9a894; }
  .zsg-fl { display: block; margin-bottom: 12px; }
  .zsg-fl > span {
    display: block; margin-bottom: 6px; font-size: 10.5px; letter-spacing: .1em;
    text-transform: uppercase; color: #8d7d6c;
  }
  .zsg-fl input {
    width: 100%; padding: 12px 13px; border-radius: 10px; font: inherit; font-size: 16px;
    background: #1c1109; border: 1px solid rgba(253, 248, 238, .1); color: #fdf8ee; outline: 0;
  }
  .zsg-fl input:focus { border-color: rgba(188, 120, 53, .7); box-shadow: 0 0 0 3px rgba(188, 120, 53, .14); }
  .zsg-go {
    display: flex; align-items: center; justify-content: center; width: 100%;
    padding: 12px 20px; border: 1px solid transparent; border-radius: 10px;
    background: #bc7835; color: #17100b; font: inherit; font-size: 14.5px;
    font-weight: 600; cursor: pointer; text-decoration: none;
  }
  .zsg-go:hover { background: #f0ce95; }
  .zsg-go:disabled { opacity: .55; cursor: default; }
  .zsg-login {
    display: block; width: 100%; margin-top: 10px; padding: 10px 12px;
    background: none; border: 1px solid rgba(253, 248, 238, .16); border-radius: 10px;
    color: #b9a894; font: inherit; font-size: 13px; cursor: pointer;
  }
  .zsg-login:hover { border-color: rgba(188, 120, 53, .6); color: #fdf8ee; }
  .zsg-back {
    display: block; width: 100%; margin-top: 10px; padding: 0; background: none; border: 0;
    color: #8d7d6c; font: inherit; font-size: 12.5px; cursor: pointer;
    text-decoration: underline; text-underline-offset: 3px;
  }
  .zsg-back:hover { color: #b9a894; }
  .zsg-done[hidden], .zsg-form[hidden] { display: none; }
  .zsg-ok {
    margin: 0 0 6px; font-family: 'Newsreader', Georgia, serif; font-size: 24px; color: #f0ce95;
  }
  .zsg-msg { min-height: 18px; margin: 12px 0 0; font-size: 12.5px; color: #8d7d6c; }
  .zsg-msg.bad { color: #e79686; }
  .zsg-msg.good { color: #8fc9a2; }
  .zsg-skip {
    display: block; width: 100%; margin-top: 14px; padding: 4px; background: none; border: 0;
    color: #8d7d6c; font: inherit; font-size: 12.5px; cursor: pointer;
  }
  .zsg-skip:hover { color: #b9a894; }
  @media (max-width: 420px) { .zsg-card { padding: 24px 20px 18px; } .zsg-card h2 { font-size: 23px; } }
  `;

  var HTML = '' +
    '<div class="zsg-card" role="dialog" aria-modal="true" aria-labelledby="zsg-h" aria-describedby="zsg-copy">' +
      '<button type="button" class="zsg-x" data-zsg-close aria-label="Close">&times;</button>' +
      '<p class="zsg-kicker">Zeva Gold &middot; &#8377;249 a year</p>' +
      '<h2 id="zsg-h">Sign in with one message on WhatsApp.</h2>' +
      '<p class="zsg-copy" id="zsg-copy">New here? The same code opens your card: a stamp on every visit, a spin every ten, &#8377;5 back on every order and free delivery inside 6&nbsp;km of Bolar. Already have a card? Sign in with your number alone.</p>' +
      '<form class="zsg-form" data-zsg-phone novalidate>' +
        '<label class="zsg-fl"><span>Your name</span>' +
          '<input type="text" data-zsg-name autocomplete="name" placeholder="Your name" maxlength="80">' +
        '</label>' +
        '<label class="zsg-fl"><span>WhatsApp number</span>' +
          '<input type="tel" data-zsg-num inputmode="numeric" autocomplete="tel" placeholder="98450 00000" maxlength="16">' +
        '</label>' +
        '<button type="submit" class="zsg-go" data-zsg-send>Send my code</button>' +
        '<button type="button" class="zsg-login" data-zsg-login>Already signed up? Sign in with just my number</button>' +
      '</form>' +
      '<form class="zsg-form" data-zsg-code hidden novalidate>' +
        '<label class="zsg-fl"><span>Code from WhatsApp</span>' +
          '<input type="text" data-zsg-digits inputmode="numeric" autocomplete="one-time-code" placeholder="000000" maxlength="6">' +
        '</label>' +
        '<button type="submit" class="zsg-go" data-zsg-verify>Sign in</button>' +
        '<button type="button" class="zsg-back" data-zsg-back>Use another number</button>' +
      '</form>' +
      '<div class="zsg-done" data-zsg-done hidden>' +
        '<p class="zsg-ok">You&rsquo;re in.</p>' +
        '<p class="zsg-copy">Your card, cashback and orders are all on this number now.</p>' +
        '<a class="zsg-go" href="app.html">Order something</a>' +
      '</div>' +
      '<p class="zsg-msg" data-zsg-msg role="status" aria-live="polite"></p>' +
      '<button type="button" class="zsg-skip" data-zsg-skip>Not now</button>' +
    '</div>';

  var host = null;
  var el = {};
  var session = '';
  var loginOnly = false;
  var signedIn = false;
  var answered = false;
  var shown = false;
  var started = Date.now();

  function skipped() {
    try { return sessionStorage.getItem(SKIP_KEY) === '1'; } catch (e) { return false; }
  }

  function rememberSkip() {
    try { sessionStorage.setItem(SKIP_KEY, '1'); } catch (e) { }
  }

  function mount() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    host = document.createElement('div');
    host.className = 'zsg';
    host.hidden = true;
    host.innerHTML = HTML;
    document.body.appendChild(host);

    ['close', 'skip', 'phone', 'name', 'num', 'send', 'login', 'code', 'digits', 'verify', 'back', 'done', 'msg']
      .forEach(function (key) { el[key] = host.querySelector('[data-zsg-' + key + ']'); });

    el.close.addEventListener('click', function () { hide(true); });
    el.skip.addEventListener('click', function () { hide(true); });
    host.addEventListener('click', function (e) { if (e.target === host) hide(true); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && host && !host.hidden) hide(true);
    });

    el.phone.addEventListener('submit', function (e) { e.preventDefault(); send(); });
    el.code.addEventListener('submit', function (e) { e.preventDefault(); verify(); });
    el.login.addEventListener('click', signIn);
    el.back.addEventListener('click', function () {
      el.code.hidden = true;
      el.phone.hidden = false;
      session = '';
      resetLogin();
      say('');
      el.num.focus();
    });
  }

  function say(text, kind) {
    el.msg.textContent = text || '';
    el.msg.className = 'zsg-msg' + (kind ? ' ' + kind : '');
  }

  // Already talking to us, or holding a cart: leave them alone rather than
  // dropping a sheet on top of what they are doing.
  function busy() {
    return !!document.querySelector('.zv-panel.open, .cart-drawer.open');
  }

  function show() {
    if (shown || skipped() || busy()) return;
    shown = true;
    mount();
    host.hidden = false;
    document.body.style.overflow = 'hidden';
    var first = el.code.hidden ? el.num : el.digits;
    setTimeout(function () { try { first.focus(); } catch (e) { } }, 60);
  }

  function hide(remember) {
    if (!host) return;
    host.hidden = true;
    document.body.style.overflow = '';
    if (remember) rememberSkip();
  }

  // Someone who already has a card only has a number to give: the same code
  // goes out, the name is not asked for, and the server matches the account on
  // the number. A number that is new still ends up with a card.
  function signIn() {
    var phone = el.num.value.replace(/[^\d+]/g, '');
    if (phone.replace(/\D/g, '').length < 10) {
      say('Enter the 10-digit WhatsApp number.', 'bad');
      el.num.focus();
      return;
    }
    loginOnly = true;
    el.name.parentNode.hidden = true;
    el.login.hidden = true;
    el.send.textContent = 'Send my login code';
    send();
  }

  function resetLogin() {
    loginOnly = false;
    el.name.parentNode.hidden = false;
    el.login.hidden = false;
    el.send.textContent = 'Send my code';
  }

  function body(init) {
    init.credentials = 'same-origin';
    init.cache = 'no-store';
    init.headers = init.headers || {};
    if (init.body) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }
    return init;
  }

  function api(path, options) {
    return fetch(path, body(options || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        d.http = r.status;
        return d;
      });
    });
  }

  function send() {
    var phone = el.num.value.replace(/[^\d+]/g, '');
    if (phone.replace(/\D/g, '').length < 10) {
      say('Enter the 10-digit WhatsApp number.', 'bad');
      el.num.focus();
      return;
    }
    el.send.disabled = true;
    say('Sending your code\u2026');
    api('/api/auth/whatsapp/start', { method: 'POST', body: { phone: phone } })
      .then(function (d) {
        el.send.disabled = false;
        if (!d.ok) { say(d.error || 'WhatsApp could not send the code.', 'bad'); return; }
        session = d.session;
        el.phone.hidden = true;
        el.code.hidden = false;
        say('Code sent to ' + (d.phone || 'your WhatsApp') + '.', 'good');
        el.digits.focus();
      })
      .catch(function () { el.send.disabled = false; say('Could not reach the server.', 'bad'); });
  }

  function verify() {
    var code = el.digits.value.replace(/\D/g, '');
    if (code.length < 4) { say('Enter the code from WhatsApp.', 'bad'); el.digits.focus(); return; }
    el.verify.disabled = true;
    say('Signing you in\u2026');
    api('/api/auth/whatsapp/verify', {
      method: 'POST',
      body: { session: session, code: code, name: loginOnly ? '' : (el.name.value || '').trim() }
    })
      .then(function (d) {
        el.verify.disabled = false;
        if (!d.ok) { say(d.error || 'That code is not right.', 'bad'); return; }
        signedIn = true;
        el.code.hidden = true;
        el.done.hidden = false;
        el.done.querySelector('.zsg-ok').textContent = loginOnly ? 'Welcome back.' : 'You\u2019re in.';
        say(loginOnly ? 'Signed in on your number.' : 'Welcome to Zeva.', 'good');
      })
      .catch(function () { el.verify.disabled = false; say('Could not reach the server.', 'bad'); });
  }

  function ready() {
    if (!answered && Date.now() - started < MAX_WAIT) {
      setTimeout(ready, 150);
      return;
    }
    if (signedIn) return;
    show();
  }

  fetch('/api/me', body({}))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      answered = true;
      if (d && d.signed_in) signedIn = true;
      // Nothing to sign in with: leave the page alone.
      if (d && d.whatsapp === false) { answered = true; signedIn = true; }
    })
    .catch(function () { answered = true; });

  setTimeout(ready, DELAY);
})();
