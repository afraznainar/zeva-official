/* Google Analytics 4 for Zeva Mandi & Grills.
   The measurement ID lives here only, so every page that loads this file stays
   tagged from one place. Loaded with defer, so it never delays first paint and
   never blocks the menu or the ordering flow. */
(function () {
  var ID = "G-HR5K0E0755";
  if (!ID || window.__zevaGaLoaded) return;
  window.__zevaGaLoaded = true;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;

  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + ID;
  document.head.appendChild(s);

  gtag("js", new Date());
  gtag("config", ID, { anonymize_ip: true });
})();
