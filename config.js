/**
 * Runtime configuration loader.
 *
 * Fetches `/api/config` (a Vercel serverless function) and exposes the result
 * as `window.POMELO_CONFIG`. `index.html` awaits `window.__pomeloConfigReady`
 * before booting, so the page always has a fully-populated config object.
 *
 * Why not inline the values into index.html at build time? Because the same
 * static bundle is deployed to preview and production environments, which have
 * different Supabase projects. Fetching at runtime keeps one build valid
 * everywhere.
 */
(function () {
  "use strict";

  /** @type {{supabaseUrl:string,supabaseAnonKey:string,promptPayId:string,shopName:string,missing:string[]}} */
  var fallback = {
    supabaseUrl: "",
    supabaseAnonKey: "",
    promptPayId: "",
    shopName: "Pomelo Shop",
    missing: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "PROMPTPAY_ID"],
  };

  window.POMELO_CONFIG = fallback;

  window.__pomeloConfigReady = fetch("/api/config", { cache: "no-store" })
    .then(function (res) {
      if (!res.ok) throw new Error("config endpoint returned " + res.status);
      return res.json();
    })
    .then(function (cfg) {
      window.POMELO_CONFIG = Object.assign({}, fallback, cfg);
      return window.POMELO_CONFIG;
    })
    .catch(function (err) {
      // Keep the fallback so the page can still render and show a helpful
      // "not configured" banner instead of a blank screen.
      console.error("[pomelo] failed to load /api/config:", err);
      return window.POMELO_CONFIG;
    });
})();
