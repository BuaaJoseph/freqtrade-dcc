/*
 * Freqtrade Dashboard — application logic
 * Vanilla JS SPA. Talks to the Freqtrade REST API (/api/v1).
 * No build step, no external dependencies.
 */
(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // State / storage
  // -------------------------------------------------------------------------
  var LS = window.localStorage;
  var state = {
    server: LS.getItem("ft_server") || window.location.origin,
    access: LS.getItem("ft_access") || null,
    refresh: LS.getItem("ft_refresh") || null,
    config: null,
    timer: null,
    daily: [],
  };

  var REFRESH_MS = 5000;

  // -------------------------------------------------------------------------
  // Small DOM helpers
  // -------------------------------------------------------------------------
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------
  function fmtNum(v, dp) {
    if (v == null || isNaN(v)) return "—";
    dp = dp == null ? 2 : dp;
    return Number(v).toLocaleString(undefined, {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    });
  }
  function fmtPct(v) {
    if (v == null || isNaN(v)) return "—";
    return (v >= 0 ? "+" : "") + fmtNum(v, 2) + "%";
  }
  function fmtMoney(v, cur) {
    if (v == null || isNaN(v)) return "—";
    return (v >= 0 ? "+" : "") + fmtNum(v, 4) + (cur ? " " + cur : "");
  }
  function signClass(v) {
    if (v == null || isNaN(v) || v === 0) return "";
    return v > 0 ? "pos" : "neg";
  }
  function ago(ts) {
    if (!ts) return "—";
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h " + (m % 60) + "m";
    var d = Math.floor(h / 24);
    return d + "d " + (h % 24) + "h";
  }

  // -------------------------------------------------------------------------
  // Toast notifications
  // -------------------------------------------------------------------------
  function toast(msg, kind) {
    var box = $("#toasts");
    var t = el("div", "toast " + (kind || ""), esc(msg));
    box.appendChild(t);
    setTimeout(function () {
      t.style.opacity = "0";
      setTimeout(function () {
        t.remove();
      }, 250);
    }, 3200);
  }

  // -------------------------------------------------------------------------
  // API client (handles 401 -> refresh -> retry)
  // -------------------------------------------------------------------------
  function api(path, opts, _retried) {
    opts = opts || {};
    var headers = opts.headers || {};
    headers["Accept"] = "application/json";
    if (state.access) headers["Authorization"] = "Bearer " + state.access;
    if (opts.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    return fetch(state.server + "/api/v1" + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      if (res.status === 401 && !_retried && state.refresh) {
        return refreshToken().then(function (ok) {
          if (ok) return api(path, opts, true);
          throw new Error("Session expired");
        });
      }
      if (res.status === 401) {
        logout();
        throw new Error("Unauthorized");
      }
      if (!res.ok) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (j) {
            throw new Error(j.detail || j.error || "HTTP " + res.status);
          });
      }
      return res.status === 204 ? null : res.json();
    });
  }

  function refreshToken() {
    return fetch(state.server + "/api/v1/token/refresh", {
      method: "POST",
      headers: { Authorization: "Bearer " + state.refresh },
    })
      .then(function (r) {
        if (!r.ok) return false;
        return r.json().then(function (j) {
          state.access = j.access_token;
          LS.setItem("ft_access", state.access);
          return true;
        });
      })
      .catch(function () {
        return false;
      });
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
  function login(server, user, pass) {
    var btn = $("#loginBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Signing in…';
    $("#loginError").classList.add("hidden");

    fetch(server + "/api/v1/token/login", {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(user + ":" + pass) },
    })
      .then(function (r) {
        if (!r.ok) throw new Error("Incorrect username or password");
        return r.json();
      })
      .then(function (j) {
        state.server = server.replace(/\/$/, "");
        state.access = j.access_token;
        state.refresh = j.refresh_token;
        LS.setItem("ft_server", state.server);
        LS.setItem("ft_access", state.access);
        LS.setItem("ft_refresh", state.refresh);
        enterApp();
      })
      .catch(function (e) {
        var box = $("#loginError");
        box.textContent = e.message || "Login failed";
        box.classList.remove("hidden");
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = "Sign in";
      });
  }

  function logout() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.access = state.refresh = null;
    LS.removeItem("ft_access");
    LS.removeItem("ft_refresh");
    $("#app").classList.add("hidden");
    $("#login").classList.remove("hidden");
  }

  // -------------------------------------------------------------------------
  // Bot control
  // -------------------------------------------------------------------------
  function control(path, label) {
    api(path, { method: "POST" })
      .then(function (r) {
        toast((r && r.status) || label + " ok", "ok");
        refreshAll();
      })
      .catch(function (e) {
        toast(e.message, "err");
      });
  }

  function forceExit(tradeId, pair) {
    if (!window.confirm("Force-exit trade #" + tradeId + " (" + pair + ")?")) return;
    api("/forceexit", { method: "POST", body: { tradeid: String(tradeId) } })
      .then(function (r) {
        toast((r && r.result) || "Force-exit submitted", "ok");
        loadTrades();
      })
      .catch(function (e) {
        toast(e.message, "err");
      });
  }

  // -------------------------------------------------------------------------
  // Rendering: status badge / config
  // -------------------------------------------------------------------------
  function renderConfig(cfg) {
    state.config = cfg;
    $("#botName").textContent = cfg.bot_name || "Freqtrade";
    $("#botVersion").textContent = "v" + (cfg.version || "?");
    $("#exchangeInfo").textContent =
      (cfg.exchange || "—") + " · " + (cfg.trading_mode || "") + " · " + (cfg.stake_currency || "");
    $("#dryBadge").classList.toggle("hidden", !cfg.dry_run);
    renderState(cfg.state);
  }

  function renderState(st) {
    var b = $("#stateBadge");
    var running = st === "running";
    b.className = "badge " + (running ? "running" : "stopped");
    b.innerHTML = '<span class="dot"></span><span>' + esc(st || "—") + "</span>";
    $("#startBtn").disabled = running;
    $("#stopBtn").disabled = !running;
  }

  // -------------------------------------------------------------------------
  // Rendering: overview stat cards
  // -------------------------------------------------------------------------
  function renderStats(profit, count, balance) {
    var cur = (state.config && state.config.stake_currency) || "";
    var cards = [
      {
        label: "Total profit (closed)",
        ico: "💰",
        value: fmtMoney(profit.profit_closed_coin, cur),
        valueClass: signClass(profit.profit_closed_coin),
        sub: fmtPct(profit.profit_closed_percent),
      },
      {
        label: "Total profit (incl. open)",
        ico: "📈",
        value: fmtMoney(profit.profit_all_coin, cur),
        valueClass: signClass(profit.profit_all_coin),
        sub: fmtPct(profit.profit_all_percent),
      },
      {
        label: "Open trades",
        ico: "⇅",
        value: count.current + " / " + count.max,
        sub: "Stake " + fmtNum(count.total_stake, 2) + " " + cur,
      },
      {
        label: "Win rate",
        ico: "🎯",
        value: profit.winrate != null ? fmtNum(profit.winrate * 100, 1) + "%" : "—",
        sub:
          (profit.winning_trades || 0) +
          "W / " +
          (profit.losing_trades || 0) +
          "L · " +
          (profit.trade_count || 0) +
          " trades",
      },
      {
        label: "Balance",
        ico: "🏦",
        value: balance ? fmtNum(balance.value, 2) + " " + balance.symbol : "—",
        sub: balance ? "Starting " + fmtNum(balance.starting_capital, 2) + " " + cur : "",
      },
      {
        label: "Profit factor",
        ico: "⚖️",
        value: profit.profit_factor != null ? fmtNum(profit.profit_factor, 2) : "—",
        sub:
          "Best " +
          (profit.best_pair || "—") +
          " " +
          fmtPct((profit.best_pair_profit_ratio || 0) * 100),
      },
    ];

    var grid = $("#statGrid");
    grid.innerHTML = "";
    cards.forEach(function (c) {
      var d = el("div", "stat");
      d.innerHTML =
        '<div class="stat-label"><span class="stat-ico">' +
        c.ico +
        "</span>" +
        esc(c.label) +
        "</div>" +
        '<div class="stat-value ' +
        (c.valueClass || "") +
        '">' +
        esc(c.value) +
        "</div>" +
        '<div class="stat-sub ' +
        (c.valueClass || "") +
        '">' +
        esc(c.sub || "") +
        "</div>";
      grid.appendChild(d);
    });
  }

  // -------------------------------------------------------------------------
  // Rendering: open trades table
  // -------------------------------------------------------------------------
  function loadTrades() {
    return api("/status").then(function (trades) {
      $("#tradeCount").textContent = trades.length;
      var body = $("#tradesBody");
      body.innerHTML = "";
      if (!trades.length) {
        body.innerHTML = '<tr><td colspan="9"><div class="empty">No open trades.</div></td></tr>';
        return;
      }
      trades.forEach(function (t) {
        var pnl = t.profit_ratio != null ? t.profit_ratio * 100 : t.profit_pct;
        var cls = signClass(pnl);
        var tr = el("tr");
        tr.innerHTML =
          '<td><div class="pair-cell">' + esc(t.pair) + "</div></td>" +
          '<td><span class="pill ' + (t.is_short ? "short" : "long") + '">' +
          (t.is_short ? "Short" : "Long") +
          (t.leverage && t.leverage !== 1 ? " " + fmtNum(t.leverage, 0) + "x" : "") +
          "</span></td>" +
          '<td class="num mono">' + fmtNum(t.stake_amount, 2) + "</td>" +
          '<td class="num mono">' + fmtNum(t.open_rate, 6) + "</td>" +
          '<td class="num mono">' + fmtNum(t.current_rate, 6) + "</td>" +
          '<td class="num mono ' + cls + '">' + fmtPct(pnl) + "</td>" +
          '<td class="num mono ' + cls + '">' + fmtNum(t.profit_abs, 4) + "</td>" +
          "<td>" + ago(t.open_timestamp) + "</td>" +
          '<td class="num"><button class="btn btn-danger" data-exit="' +
          t.trade_id +
          '" data-pair="' + esc(t.pair) + '">Exit</button></td>';
        body.appendChild(tr);
      });
      $all("[data-exit]", body).forEach(function (b) {
        b.addEventListener("click", function () {
          forceExit(b.getAttribute("data-exit"), b.getAttribute("data-pair"));
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // Rendering: performance table
  // -------------------------------------------------------------------------
  function loadPerformance() {
    return api("/performance").then(function (rows) {
      var body = $("#perfBody");
      body.innerHTML = "";
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="4"><div class="empty">No closed trades yet.</div></td></tr>';
        return;
      }
      rows.forEach(function (r) {
        var cls = signClass(r.profit_pct != null ? r.profit_pct : r.profit);
        var tr = el("tr");
        tr.innerHTML =
          '<td><div class="pair-cell">' + esc(r.pair) + "</div></td>" +
          '<td class="num mono">' + r.count + "</td>" +
          '<td class="num mono ' + cls + '">' +
          fmtPct(r.profit_pct != null ? r.profit_pct : r.profit) +
          "</td>" +
          '<td class="num mono ' + cls + '">' + fmtNum(r.profit_abs, 4) + "</td>";
        body.appendChild(tr);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Rendering: logs
  // -------------------------------------------------------------------------
  function loadLogs() {
    return api("/logs").then(function (data) {
      var box = $("#logBox");
      box.innerHTML = "";
      var logs = (data && data.logs) || [];
      logs.slice(-300).forEach(function (row) {
        // row = [ts_str, ts, name, level, message]
        var lvl = row[3] || "INFO";
        var line = el("div", "logline");
        line.innerHTML =
          '<span class="ts">' + esc(row[0]) + "</span> " +
          '<span class="lvl-' + esc(lvl) + '">' + esc(lvl) + "</span> " +
          esc(row[4]);
        box.appendChild(line);
      });
      box.scrollTop = box.scrollHeight;
    });
  }

  // -------------------------------------------------------------------------
  // Charts (vanilla canvas)
  // -------------------------------------------------------------------------
  function setupCanvas(cv) {
    var ratio = window.devicePixelRatio || 1;
    var w = cv.clientWidth || cv.parentElement.clientWidth;
    var h = cv.height;
    cv.width = w * ratio;
    cv.style.height = h + "px";
    var ctx = cv.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }
  function cssVar(n) {
    return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  }

  function drawBars(cv, data) {
    var s = setupCanvas(cv);
    var ctx = s.ctx,
      w = s.w,
      h = s.h;
    ctx.clearRect(0, 0, w, h);
    if (!data.length) return;
    var pad = { l: 8, r: 8, t: 12, b: 24 };
    var iw = w - pad.l - pad.r,
      ih = h - pad.t - pad.b;
    var vals = data.map(function (d) {
      return d.abs_profit;
    });
    var max = Math.max.apply(null, vals.concat([0]));
    var min = Math.min.apply(null, vals.concat([0]));
    var range = max - min || 1;
    var zeroY = pad.t + (max / range) * ih;
    var bw = iw / data.length;
    var green = cssVar("--green"),
      red = cssVar("--red"),
      dim = cssVar("--text-dim");

    ctx.strokeStyle = cssVar("--border");
    ctx.beginPath();
    ctx.moveTo(pad.l, zeroY);
    ctx.lineTo(w - pad.r, zeroY);
    ctx.stroke();

    data.forEach(function (d, i) {
      var x = pad.l + i * bw + bw * 0.15;
      var barW = bw * 0.7;
      var v = d.abs_profit;
      var bh = (Math.abs(v) / range) * ih;
      ctx.fillStyle = v >= 0 ? green : red;
      if (v >= 0) ctx.fillRect(x, zeroY - bh, barW, bh);
      else ctx.fillRect(x, zeroY, barW, bh);
    });

    ctx.fillStyle = dim;
    ctx.font = "10px " + cssVar("--font");
    ctx.textAlign = "center";
    var step = Math.ceil(data.length / 6);
    data.forEach(function (d, i) {
      if (i % step !== 0) return;
      var lbl = String(d.date).slice(5);
      ctx.fillText(lbl, pad.l + i * bw + bw / 2, h - 8);
    });
  }

  function drawLine(cv, data) {
    var s = setupCanvas(cv);
    var ctx = s.ctx,
      w = s.w,
      h = s.h;
    ctx.clearRect(0, 0, w, h);
    if (!data.length) return;
    var pad = { l: 8, r: 8, t: 12, b: 24 };
    var iw = w - pad.l - pad.r,
      ih = h - pad.t - pad.b;
    var cum = [];
    var run = 0;
    data.forEach(function (d) {
      run += d.abs_profit;
      cum.push(run);
    });
    var max = Math.max.apply(null, cum.concat([0]));
    var min = Math.min.apply(null, cum.concat([0]));
    var range = max - min || 1;
    var accent = cssVar("--accent"),
      accent2 = cssVar("--accent-2");
    function ptx(i) {
      return pad.l + (i / Math.max(cum.length - 1, 1)) * iw;
    }
    function pty(v) {
      return pad.t + ((max - v) / range) * ih;
    }

    var grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
    grad.addColorStop(0, accent2 + "55");
    grad.addColorStop(1, accent2 + "00");
    ctx.beginPath();
    ctx.moveTo(ptx(0), pty(cum[0]));
    cum.forEach(function (v, i) {
      ctx.lineTo(ptx(i), pty(v));
    });
    ctx.lineTo(ptx(cum.length - 1), pad.t + ih);
    ctx.lineTo(ptx(0), pad.t + ih);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(ptx(0), pty(cum[0]));
    cum.forEach(function (v, i) {
      ctx.lineTo(ptx(i), pty(v));
    });
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    ctx.stroke();
  }

  function loadDaily() {
    return api("/daily?timescale=30").then(function (data) {
      // API returns newest-first; reverse for chronological charts
      state.daily = (data.data || []).slice().reverse();
      drawBars($("#dailyChart"), state.daily);
      drawLine($("#cumChart"), state.daily);
    });
  }

  // -------------------------------------------------------------------------
  // Orchestration
  // -------------------------------------------------------------------------
  function refreshOverview() {
    return Promise.all([
      api("/profit"),
      api("/count"),
      api("/balance").catch(function () {
        return null;
      }),
    ]).then(function (r) {
      renderStats(r[0], r[1], r[2]);
    });
  }

  function refreshAll() {
    api("/show_config")
      .then(renderConfig)
      .catch(function (e) {
        toast(e.message, "err");
      });
    var active = $(".nav-item.active");
    var view = active ? active.getAttribute("data-view") : "overview";
    loadView(view, true);
  }

  function loadView(view, silent) {
    var jobs = [];
    if (view === "overview") jobs = [refreshOverview(), loadDaily()];
    else if (view === "trades") jobs = [loadTrades()];
    else if (view === "performance") jobs = [loadPerformance()];
    else if (view === "logs") jobs = [loadLogs()];
    Promise.all(jobs).catch(function (e) {
      if (!silent) toast(e.message, "err");
    });
  }

  function switchView(view) {
    $all(".nav-item").forEach(function (n) {
      n.classList.toggle("active", n.getAttribute("data-view") === view);
    });
    $all("[data-view-content]").forEach(function (s) {
      s.classList.toggle("hidden", s.getAttribute("data-view-content") !== view);
    });
    var titles = {
      overview: "Overview",
      trades: "Open Trades",
      performance: "Performance",
      logs: "Logs",
    };
    $("#viewTitle").textContent = titles[view] || view;
    $("#sidebar").classList.remove("open");
    loadView(view);
  }

  function enterApp() {
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    refreshAll();
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      api("/show_config")
        .then(function (c) {
          renderState(c.state);
        })
        .catch(function () {});
      var active = $(".nav-item.active");
      loadView(active ? active.getAttribute("data-view") : "overview", true);
    }, REFRESH_MS);
  }

  // -------------------------------------------------------------------------
  // Theme
  // -------------------------------------------------------------------------
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    LS.setItem("ft_theme", t);
    $("#themeBtn").textContent = t === "dark" ? "☾" : "☀";
    // redraw charts with new colors
    if (state.daily.length) {
      drawBars($("#dailyChart"), state.daily);
      drawLine($("#cumChart"), state.daily);
    }
  }

  // -------------------------------------------------------------------------
  // Wire up events
  // -------------------------------------------------------------------------
  function init() {
    applyTheme(LS.getItem("ft_theme") || "dark");
    $("#server").value = state.server;

    $("#loginForm").addEventListener("submit", function (e) {
      e.preventDefault();
      login($("#server").value.trim() || window.location.origin, $("#username").value, $("#password").value);
    });

    $all(".nav-item").forEach(function (n) {
      n.addEventListener("click", function () {
        switchView(n.getAttribute("data-view"));
      });
    });

    $("#startBtn").addEventListener("click", function () {
      control("/start", "Start");
    });
    $("#stopBtn").addEventListener("click", function () {
      control("/stop", "Stop");
    });
    $("#reloadBtn").addEventListener("click", function () {
      control("/reload_config", "Reload");
    });
    $("#logoutBtn").addEventListener("click", logout);
    $("#logRefresh").addEventListener("click", loadLogs);
    $("#themeBtn").addEventListener("click", function () {
      applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
    });
    $("#menuToggle").addEventListener("click", function () {
      $("#sidebar").classList.toggle("open");
    });

    window.addEventListener("resize", function () {
      if (state.daily.length) {
        drawBars($("#dailyChart"), state.daily);
        drawLine($("#cumChart"), state.daily);
      }
    });

    // Auto-login if we have a stored token
    if (state.access && state.refresh) {
      api("/show_config")
        .then(function () {
          enterApp();
        })
        .catch(function () {
          logout();
        });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
