/*
 * Freqtrade 控制台 — 应用逻辑
 * 原生 JS 单页应用，对接 Freqtrade REST API (/api/v1)。
 * 无构建步骤、无外部依赖。
 */
(function () {
  "use strict";

  // ===========================================================================
  // 状态与存储
  // ===========================================================================
  var LS = window.localStorage;
  var state = {
    server: LS.getItem("ft_server") || window.location.origin,
    access: LS.getItem("ft_access") || null,
    refresh: LS.getItem("ft_refresh") || null,
    config: null,
    timer: null,
    view: "overview",
    daily: [],
    perf: [],
    history: { offset: 0, limit: 20, total: 0 },
    period: "daily",
    chart: { pair: null, tf: null, data: null },
    whitelist: [],
  };
  var REFRESH_MS = 5000;

  // ===========================================================================
  // DOM / 工具
  // ===========================================================================
  function $(s, r) {
    return (r || document).querySelector(s);
  }
  function $all(s, r) {
    return Array.prototype.slice.call((r || document).querySelectorAll(s));
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

  // 格式化
  function fmtNum(v, dp) {
    if (v == null || isNaN(v)) return "—";
    dp = dp == null ? 2 : dp;
    return Number(v).toLocaleString("zh-CN", {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    });
  }
  function fmtPct(v) {
    if (v == null || isNaN(v)) return "—";
    return (v >= 0 ? "+" : "") + fmtNum(v, 2) + "%";
  }
  function fmtSigned(v, dp) {
    if (v == null || isNaN(v)) return "—";
    return (v >= 0 ? "+" : "") + fmtNum(v, dp == null ? 4 : dp);
  }
  function cls(v) {
    if (v == null || isNaN(v) || v === 0) return "";
    return v > 0 ? "up" : "down";
  }
  function cur() {
    return (state.config && state.config.stake_currency) || "";
  }
  function ago(ts) {
    if (!ts) return "—";
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + " 秒";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " 分";
    var h = Math.floor(m / 60);
    if (h < 24) return h + " 时 " + (m % 60) + " 分";
    var d = Math.floor(h / 24);
    return d + " 天 " + (h % 24) + " 时";
  }
  function fmtTime(ts) {
    if (!ts) return "—";
    var d = new Date(ts);
    var p = function (n) {
      return (n < 10 ? "0" : "") + n;
    };
    return (
      d.getFullYear() +
      "-" + p(d.getMonth() + 1) +
      "-" + p(d.getDate()) +
      " " + p(d.getHours()) +
      ":" + p(d.getMinutes())
    );
  }

  // Toast
  function toast(msg, kind) {
    var t = el("div", "toast " + (kind || ""), esc(msg));
    $("#toasts").appendChild(t);
    setTimeout(function () {
      t.style.opacity = "0";
      setTimeout(function () {
        t.remove();
      }, 280);
    }, 3400);
  }

  // ===========================================================================
  // API 客户端（自动刷新 token）
  // ===========================================================================
  function api(path, opts, _retried) {
    opts = opts || {};
    var headers = opts.headers || {};
    headers["Accept"] = "application/json";
    if (state.access) headers["Authorization"] = "Bearer " + state.access;
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    return fetch(state.server + "/api/v1" + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      if (res.status === 401 && !_retried && state.refresh) {
        return refreshToken().then(function (ok) {
          if (ok) return api(path, opts, true);
          throw new Error("登录已过期");
        });
      }
      if (res.status === 401) {
        logout();
        throw new Error("未授权");
      }
      if (!res.ok) {
        return res.json().catch(function () {
          return {};
        }).then(function (j) {
          throw new Error(j.detail || j.error || ("HTTP " + res.status));
        });
      }
      return res.status === 204 ? null : res.json();
    });
  }
  function refreshToken() {
    return fetch(state.server + "/api/v1/token/refresh", {
      method: "POST",
      headers: { Authorization: "Bearer " + state.refresh },
    }).then(function (r) {
      if (!r.ok) return false;
      return r.json().then(function (j) {
        state.access = j.access_token;
        LS.setItem("ft_access", state.access);
        return true;
      });
    }).catch(function () {
      return false;
    });
  }

  // ===========================================================================
  // 认证
  // ===========================================================================
  function login(server, user, pass) {
    var btn = $("#loginBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 登录中…';
    $("#loginError").classList.add("hidden");
    fetch(server + "/api/v1/token/login", {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(user + ":" + pass) },
    }).then(function (r) {
      if (!r.ok) throw new Error("用户名或密码错误");
      return r.json();
    }).then(function (j) {
      state.server = server.replace(/\/$/, "");
      state.access = j.access_token;
      state.refresh = j.refresh_token;
      LS.setItem("ft_server", state.server);
      LS.setItem("ft_access", state.access);
      LS.setItem("ft_refresh", state.refresh);
      enterApp();
    }).catch(function (e) {
      var box = $("#loginError");
      box.textContent = e.message || "登录失败";
      box.classList.remove("hidden");
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = "登录";
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

  // ===========================================================================
  // 模态框
  // ===========================================================================
  function openModal(title, bodyHtml, footHtml, wide) {
    closeModal();
    var bd = el("div", "modal-backdrop");
    bd.innerHTML =
      '<div class="modal' + (wide ? " wide" : "") + '">' +
      '<div class="modal-head"><h3>' + esc(title) + '</h3><button class="x" data-close>×</button></div>' +
      '<div class="modal-body">' + bodyHtml + "</div>" +
      (footHtml ? '<div class="modal-foot">' + footHtml + "</div>" : "") +
      "</div>";
    $("#modalRoot").appendChild(bd);
    bd.addEventListener("click", function (e) {
      if (e.target === bd || e.target.hasAttribute("data-close")) closeModal();
    });
    return bd;
  }
  function closeModal() {
    $("#modalRoot").innerHTML = "";
  }

  // ===========================================================================
  // 机器人控制
  // ===========================================================================
  function control(path, label) {
    api(path, { method: "POST" }).then(function (r) {
      toast((r && r.status) || (label + " 成功"), "ok");
      refreshAll();
    }).catch(function (e) {
      toast(e.message, "err");
    });
  }

  function forceExit(tradeId, pair) {
    if (!window.confirm("确认强制平仓 #" + tradeId + "（" + pair + "）？")) return;
    api("/forceexit", { method: "POST", body: { tradeid: String(tradeId) } })
      .then(function (r) {
        toast((r && r.result) || "已提交平仓", "ok");
        closeModal();
        loadTrades();
      }).catch(function (e) {
        toast(e.message, "err");
      });
  }
  function exitAll() {
    api("/status").then(function (trades) {
      if (!trades.length) return toast("当前无持仓", "");
      if (!window.confirm("确认平掉全部 " + trades.length + " 笔持仓？")) return;
      Promise.all(trades.map(function (t) {
        return api("/forceexit", { method: "POST", body: { tradeid: String(t.trade_id) } }).catch(function () {});
      })).then(function () {
        toast("已提交全部平仓", "ok");
        loadTrades();
      });
    });
  }

  function openForceEntry() {
    var shortOpt = state.config && state.config.short_allowed
      ? '<option value="short">做空 Short</option>' : "";
    var opts = state.whitelist.map(function (p) {
      return '<option value="' + esc(p) + '">';
    }).join("");
    var body =
      '<div class="field"><label>交易对</label>' +
      '<input id="feValPair" list="feWl" placeholder="如 BTC/USDT" /><datalist id="feWl">' + opts + "</datalist></div>" +
      '<div class="form-row">' +
      '<div class="field"><label>方向</label><select id="feSide"><option value="long">做多 Long</option>' + shortOpt + "</select></div>" +
      '<div class="field"><label>下单价格（可选）</label><input id="fePrice" type="number" step="any" placeholder="留空=市价" /></div>' +
      "</div>" +
      '<div class="form-row">' +
      '<div class="field"><label>投入金额（可选）</label><input id="feStake" type="number" step="any" placeholder="默认策略配置" /></div>' +
      '<div class="field"><label>杠杆（可选）</label><input id="feLev" type="number" step="any" placeholder="如 3" /></div>' +
      "</div>" +
      '<div class="field"><label>入场标签（可选）</label><input id="feTag" type="text" placeholder="force_entry" /></div>';
    var foot =
      '<button class="btn" data-close>取消</button>' +
      '<button class="btn btn-primary" id="feSubmit">确认入场</button>';
    openModal("强制入场", body, foot);
    $("#feSubmit").addEventListener("click", function () {
      var pair = $("#feValPair").value.trim();
      if (!pair) return toast("请填写交易对", "err");
      var payload = { pair: pair, side: $("#feSide").value };
      var price = parseFloat($("#fePrice").value);
      var stake = parseFloat($("#feStake").value);
      var lev = parseFloat($("#feLev").value);
      var tag = $("#feTag").value.trim();
      if (!isNaN(price)) payload.price = price;
      if (!isNaN(stake)) payload.stakeamount = stake;
      if (!isNaN(lev)) payload.leverage = lev;
      if (tag) payload.entry_tag = tag;
      api("/forceenter", { method: "POST", body: payload }).then(function () {
        toast("已提交入场：" + pair, "ok");
        closeModal();
        loadTrades();
      }).catch(function (e) {
        toast(e.message, "err");
      });
    });
  }

  // ===========================================================================
  // 状态栏 / 配置
  // ===========================================================================
  function renderConfig(cfg) {
    state.config = cfg;
    $("#botName").textContent = cfg.bot_name || "Freqtrade";
    $("#botVersion").textContent = "v" + (cfg.version || "?");
    $("#exchangeInfo").textContent =
      (cfg.exchange || "—") + " · " +
      (cfg.trading_mode === "futures" ? "合约" : "现货") + " · " + (cfg.stake_currency || "");
    $("#dryBadge").classList.toggle("hidden", !cfg.dry_run);
    $("#forceEntryBtn").classList.toggle("hidden", !cfg.force_entry_enable);
    renderState(cfg.state);
  }
  function renderState(st) {
    var b = $("#stateBadge");
    var running = st === "running";
    b.className = "badge " + (running ? "running" : "stopped");
    var label = st === "running" ? "运行中" : st === "stopped" ? "已停止" : (st || "—");
    b.innerHTML = '<span class="dot"></span><span>' + esc(label) + "</span>";
    $("#startBtn").disabled = running;
    $("#stopBtn").disabled = !running;
  }

  // ===========================================================================
  // 总览
  // ===========================================================================
  function renderOverview(profit, count, balance) {
    setText("#heroProfit", fmtSigned(profit.profit_all_coin, 4) + " " + cur(), cls(profit.profit_all_coin));
    setText("#heroProfitPct", fmtPct(profit.profit_all_percent) + "（绝对收益率）");
    setText("#heroClosed", fmtSigned(profit.profit_closed_coin, 4), cls(profit.profit_closed_coin));
    setText("#heroBalance", balance ? fmtNum(balance.value, 2) + " " + balance.symbol : "—");
    setText("#heroOpen", count.current + " / " + count.max);
    setText("#heroWin", profit.winrate != null ? fmtNum(profit.winrate * 100, 1) + "%" : "—");

    var cards = [
      { l: "已平仓收益率", i: "％", v: fmtPct(profit.profit_closed_percent), c: cls(profit.profit_closed_percent),
        s: "均值 " + fmtPct(profit.profit_closed_percent_mean) },
      { l: "盈利因子", i: "⚖", v: fmtNum(profit.profit_factor, 2),
        s: "盈 " + (profit.winning_trades || 0) + " / 亏 " + (profit.losing_trades || 0) },
      { l: "成交笔数", i: "#", v: String(profit.trade_count || 0),
        s: "已平仓 " + (profit.closed_trade_count || 0) },
      { l: "最佳交易对", i: "★", v: profit.best_pair || "—",
        s: fmtPct((profit.best_pair_profit_ratio || 0) * 100) },
      { l: "最大回撤", i: "▽", v: fmtPct((profit.max_drawdown || 0) * 100), c: "down",
        s: fmtSigned(profit.max_drawdown_abs, 2) + " " + cur() },
      { l: "起始资金", i: "◆", v: fmtNum(profit.profit_all_coin != null && balance ? balance.starting_capital : null, 2),
        s: "夏普 " + fmtNum(profit.sharpe, 2) + " · 索提诺 " + fmtNum(profit.sortino, 2) },
    ];
    renderStatGrid("#statGrid", cards);
  }
  function setText(sel, txt, klass) {
    var e = $(sel);
    if (!e) return;
    e.textContent = txt;
    e.classList.remove("up", "down");
    if (klass) e.classList.add(klass);
  }
  function renderStatGrid(sel, cards) {
    var g = $(sel);
    g.innerHTML = "";
    cards.forEach(function (c) {
      var d = el("div", "stat");
      d.innerHTML =
        '<div class="stat-label"><span class="stat-ico">' + c.i + "</span>" + esc(c.l) + "</div>" +
        '<div class="stat-value ' + (c.c || "") + '">' + esc(c.v) + "</div>" +
        '<div class="stat-sub">' + esc(c.s || "") + "</div>";
      g.appendChild(d);
    });
  }

  // ===========================================================================
  // 当前持仓
  // ===========================================================================
  function loadTrades() {
    return api("/status").then(function (trades) {
      $("#tradeCount").textContent = trades.length + " 笔";
      var body = $("#tradesBody");
      body.innerHTML = "";
      if (!trades.length) {
        body.innerHTML = '<tr><td colspan="10"><div class="empty"><div class="big">∅</div>当前没有持仓</div></td></tr>';
        return;
      }
      trades.forEach(function (t) {
        var pnl = t.profit_ratio != null ? t.profit_ratio * 100 : t.profit_pct;
        var k = cls(pnl);
        var tr = el("tr", "row-click");
        tr.innerHTML =
          '<td class="num">' + t.trade_id + "</td>" +
          '<td><div class="pair-cell">' + esc(t.pair) + "</div></td>" +
          '<td><span class="pill ' + (t.is_short ? "short" : "long") + '">' + (t.is_short ? "空" : "多") +
          (t.leverage && t.leverage !== 1 ? " " + fmtNum(t.leverage, 0) + "x" : "") + "</span></td>" +
          '<td class="num">' + fmtNum(t.stake_amount, 2) + "</td>" +
          '<td class="num">' + fmtNum(t.open_rate, 6) + "</td>" +
          '<td class="num">' + fmtNum(t.current_rate, 6) + "</td>" +
          '<td class="num ' + k + '">' + fmtPct(pnl) + "</td>" +
          '<td class="num ' + k + '">' + fmtSigned(t.profit_abs, 4) + "</td>" +
          "<td>" + ago(t.open_timestamp) + "</td>" +
          '<td class="num"><div class="row-actions">' +
          '<button class="btn btn-sm" data-detail="' + t.trade_id + '">详情</button>' +
          '<button class="btn btn-sm btn-down" data-exit="' + t.trade_id + '" data-pair="' + esc(t.pair) + '">平仓</button>' +
          "</div></td>";
        body.appendChild(tr);
      });
      $all("[data-exit]", body).forEach(function (b) {
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          forceExit(b.getAttribute("data-exit"), b.getAttribute("data-pair"));
        });
      });
      $all("[data-detail]", body).forEach(function (b) {
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          showTradeDetail(b.getAttribute("data-detail"));
        });
      });
      $all("tr.row-click", body).forEach(function (tr, i) {
        tr.addEventListener("click", function () {
          showTradeDetail(trades[i].trade_id);
        });
      });
    });
  }

  function showTradeDetail(id) {
    api("/trade/" + id).then(function (t) {
      var pnl = t.profit_ratio != null ? t.profit_ratio * 100 : t.profit_pct;
      function kv(k, v, c) {
        return '<div class="k">' + esc(k) + '</div><div class="v ' + (c || "") + '">' + esc(v) + "</div>";
      }
      var body =
        '<div class="kv">' +
        kv("交易对", t.pair) +
        kv("方向", (t.is_short ? "做空" : "做多") + (t.leverage ? " · " + fmtNum(t.leverage, 0) + "x" : "")) +
        kv("策略", t.strategy || "—") +
        kv("入场标签", t.enter_tag || "—") +
        kv("数量", fmtNum(t.amount, 6)) +
        kv("投入金额", fmtNum(t.stake_amount, 4) + " " + cur()) +
        kv("开仓价", fmtNum(t.open_rate, 6)) +
        kv("现价", fmtNum(t.current_rate, 6)) +
        kv("盈亏%", fmtPct(pnl), cls(pnl)) +
        kv("盈亏", fmtSigned(t.profit_abs, 4) + " " + cur(), cls(t.profit_abs)) +
        kv("止损价", fmtNum(t.stop_loss_abs, 6)) +
        kv("止损%", fmtPct((t.stop_loss_pct || 0))) +
        kv("开仓时间", fmtTime(t.open_timestamp)) +
        kv("持仓时长", ago(t.open_timestamp)) +
        kv("加仓次数", String(t.nr_of_successful_entries || 0)) +
        kv("挂单中", t.has_open_orders ? "是" : "否") +
        "</div>";
      var foot =
        (t.has_open_orders ? '<button class="btn btn-sm" id="tdCancel">取消挂单</button>' : "") +
        '<button class="btn btn-sm" id="tdReload">刷新订单</button>' +
        '<button class="btn btn-sm btn-down" id="tdExit">强制平仓</button>' +
        '<button class="btn btn-sm" data-close>关闭</button>';
      openModal("持仓详情 #" + t.trade_id, body, foot, true);
      $("#tdExit").addEventListener("click", function () {
        forceExit(t.trade_id, t.pair);
      });
      $("#tdReload").addEventListener("click", function () {
        api("/trades/" + t.trade_id + "/reload", { method: "POST" }).then(function () {
          toast("已刷新订单", "ok");
          showTradeDetail(t.trade_id);
        }).catch(function (e) {
          toast(e.message, "err");
        });
      });
      if ($("#tdCancel")) {
        $("#tdCancel").addEventListener("click", function () {
          api("/trades/" + t.trade_id + "/open-order", { method: "DELETE" }).then(function () {
            toast("已取消挂单", "ok");
            showTradeDetail(t.trade_id);
          }).catch(function (e) {
            toast(e.message, "err");
          });
        });
      }
    }).catch(function (e) {
      toast(e.message, "err");
    });
  }

  // ===========================================================================
  // 绩效
  // ===========================================================================
  function loadPerformance() {
    api("/profit").then(function (p) {
      renderStatGrid("#perfStatGrid", [
        { l: "总收益率", i: "％", v: fmtPct(p.profit_all_percent), c: cls(p.profit_all_percent), s: "含未平仓" },
        { l: "期望值", i: "E", v: fmtNum(p.expectancy, 4), s: "比率 " + fmtNum(p.expectancy_ratio, 2) },
        { l: "盈利因子", i: "⚖", v: fmtNum(p.profit_factor, 2), s: "胜率 " + fmtNum((p.winrate || 0) * 100, 1) + "%" },
        { l: "夏普 / 索提诺", i: "σ", v: fmtNum(p.sharpe, 2) + " / " + fmtNum(p.sortino, 2), s: "SQN " + fmtNum(p.sqn, 2) },
        { l: "最大回撤", i: "▽", v: fmtPct((p.max_drawdown || 0) * 100), c: "down", s: fmtSigned(p.max_drawdown_abs, 2) },
        { l: "平均持仓", i: "⏱", v: p.avg_duration || "—", s: "CAGR " + fmtPct((p.cagr || 0) * 100) },
      ]);
    }).catch(function () {});
    loadPeriod();
    api("/performance").then(function (rows) {
      fillStatsTable("#perfBody", rows, "pair", 4);
    }).catch(function () {});
    api("/entries").then(function (rows) {
      fillStatsTable("#entryBody", rows, "enter_tag", 4);
    }).catch(function () {});
    api("/exits").then(function (rows) {
      fillStatsTable("#exitBody", rows, "exit_reason", 4);
    }).catch(function () {});
  }
  function fillStatsTable(sel, rows, keyField, cols) {
    var body = $(sel);
    body.innerHTML = "";
    if (!rows || !rows.length) {
      body.innerHTML = '<tr><td colspan="' + cols + '"><div class="empty">暂无数据</div></td></tr>';
      return;
    }
    rows.forEach(function (r) {
      var pct = r.profit_pct != null ? r.profit_pct : r.profit;
      var k = cls(pct);
      var tr = el("tr");
      tr.innerHTML =
        "<td>" + esc(r[keyField] || "—") + "</td>" +
        '<td class="num">' + r.count + "</td>" +
        '<td class="num ' + k + '">' + fmtPct(pct) + "</td>" +
        '<td class="num ' + k + '">' + fmtSigned(r.profit_abs, 4) + "</td>";
      body.appendChild(tr);
    });
  }
  function loadPeriod() {
    api("/" + state.period + "?timescale=30").then(function (d) {
      var body = $("#periodBody");
      body.innerHTML = "";
      var rows = d.data || [];
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="4"><div class="empty">暂无数据</div></td></tr>';
        return;
      }
      rows.forEach(function (r) {
        var k = cls(r.abs_profit);
        var tr = el("tr");
        tr.innerHTML =
          "<td>" + esc(r.date) + "</td>" +
          '<td class="num ' + k + '">' + fmtSigned(r.abs_profit, 4) + "</td>" +
          '<td class="num ' + k + '">' + fmtPct((r.rel_profit || 0) * 100) + "</td>" +
          '<td class="num">' + r.trade_count + "</td>";
        body.appendChild(tr);
      });
    }).catch(function () {});
  }

  // ===========================================================================
  // 交易记录（分页）
  // ===========================================================================
  function loadHistory() {
    var h = state.history;
    api("/trades?limit=" + h.limit + "&offset=" + h.offset).then(function (d) {
      h.total = d.total_trades || 0;
      $("#historyCount").textContent = "共 " + h.total + " 笔";
      $("#histPage").textContent = Math.floor(h.offset / h.limit) + 1 + " / " + Math.max(1, Math.ceil(h.total / h.limit));
      $("#histPrev").disabled = h.offset <= 0;
      $("#histNext").disabled = h.offset + h.limit >= h.total;
      var body = $("#historyBody");
      body.innerHTML = "";
      var rows = d.trades || [];
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="9"><div class="empty">暂无历史成交</div></td></tr>';
        return;
      }
      rows.slice().reverse().forEach(function (t) {
        var pnl = t.profit_ratio != null ? t.profit_ratio * 100 : t.profit_pct;
        var k = cls(pnl);
        var tr = el("tr");
        tr.innerHTML =
          '<td class="num">' + t.trade_id + "</td>" +
          '<td><div class="pair-cell">' + esc(t.pair) + "</div></td>" +
          '<td><span class="pill ' + (t.is_short ? "short" : "long") + '">' + (t.is_short ? "空" : "多") + "</span></td>" +
          '<td class="num">' + fmtNum(t.open_rate, 6) + "</td>" +
          '<td class="num">' + fmtNum(t.close_rate, 6) + "</td>" +
          '<td class="num ' + k + '">' + fmtPct(pnl) + "</td>" +
          '<td class="num ' + k + '">' + fmtSigned(t.profit_abs, 4) + "</td>" +
          "<td><span class=\"tag\">" + esc(t.exit_reason || "—") + "</span></td>" +
          "<td>" + fmtTime(t.close_timestamp) + "</td>";
        body.appendChild(tr);
      });
    }).catch(function (e) {
      toast(e.message, "err");
    });
  }

  // ===========================================================================
  // 配对列表（白名单 / 黑名单）
  // ===========================================================================
  function loadPairlist() {
    api("/whitelist").then(function (d) {
      state.whitelist = d.whitelist || [];
      $("#wlCount").textContent = d.length || state.whitelist.length;
      var box = $("#whitelistBox");
      box.innerHTML = "";
      if (!state.whitelist.length) {
        box.innerHTML = '<div class="empty">白名单为空</div>';
      } else {
        var wrap = el("div");
        wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
        state.whitelist.forEach(function (p) {
          wrap.appendChild(el("span", "chip", esc(p)));
        });
        box.appendChild(wrap);
      }
    }).catch(function () {});
    renderBlacklist();
  }
  function renderBlacklist() {
    api("/blacklist").then(function (d) {
      $("#blCount").textContent = d.length || 0;
      var box = $("#blacklistBox");
      box.innerHTML = "";
      var list = d.blacklist || [];
      if (!list.length) {
        box.innerHTML = '<div class="empty">黑名单为空</div>';
        return;
      }
      var wrap = el("div");
      wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
      list.forEach(function (p) {
        var chip = el("span", "chip");
        chip.innerHTML = esc(p) + ' <span style="cursor:pointer;color:var(--down);font-weight:700" data-del="' + esc(p) + '">×</span>';
        wrap.appendChild(chip);
      });
      box.appendChild(wrap);
      $all("[data-del]", box).forEach(function (x) {
        x.addEventListener("click", function () {
          var pair = x.getAttribute("data-del");
          api("/blacklist?pairs_to_delete=" + encodeURIComponent(pair), { method: "DELETE" })
            .then(function () {
              toast("已移除 " + pair, "ok");
              renderBlacklist();
            }).catch(function (e) {
              toast(e.message, "err");
            });
        });
      });
    }).catch(function () {});
  }
  function addBlacklist() {
    var p = $("#blInput").value.trim();
    if (!p) return;
    api("/blacklist", { method: "POST", body: { blacklist: [p] } }).then(function () {
      toast("已加入黑名单：" + p, "ok");
      $("#blInput").value = "";
      renderBlacklist();
    }).catch(function (e) {
      toast(e.message, "err");
    });
  }

  // ===========================================================================
  // 锁定
  // ===========================================================================
  function loadLocks() {
    api("/locks").then(function (d) {
      $("#lockCount").textContent = (d.lock_count || 0) + " 个";
      var body = $("#locksBody");
      body.innerHTML = "";
      var locks = d.locks || [];
      if (!locks.length) {
        body.innerHTML = '<tr><td colspan="5"><div class="empty">当前无锁定</div></td></tr>';
        return;
      }
      locks.forEach(function (l) {
        var tr = el("tr");
        tr.innerHTML =
          "<td>" + esc(l.pair) + "</td>" +
          "<td><span class=\"pill muted\">" + esc(l.side) + "</span></td>" +
          "<td>" + fmtTime(l.lock_end_timestamp) + "</td>" +
          "<td><span class=\"tag\">" + esc(l.reason || "—") + "</span></td>" +
          '<td class="num"><button class="btn btn-sm btn-down" data-unlock="' + l.id + '">解锁</button></td>';
        body.appendChild(tr);
      });
      $all("[data-unlock]", body).forEach(function (b) {
        b.addEventListener("click", function () {
          api("/locks/" + b.getAttribute("data-unlock"), { method: "DELETE" }).then(function () {
            toast("已解锁", "ok");
            loadLocks();
          }).catch(function (e) {
            toast(e.message, "err");
          });
        });
      });
    }).catch(function (e) {
      toast(e.message, "err");
    });
  }
  function openAddLock() {
    var body =
      '<div class="field"><label>交易对</label><input id="lkPair" placeholder="如 BTC/USDT" /></div>' +
      '<div class="form-row">' +
      '<div class="field"><label>方向</label><select id="lkSide"><option value="*">双向</option><option value="long">多</option><option value="short">空</option></select></div>' +
      '<div class="field"><label>解锁时间</label><input id="lkUntil" type="datetime-local" /></div>' +
      "</div>" +
      '<div class="field"><label>原因（可选）</label><input id="lkReason" placeholder="手动锁定" /></div>';
    openModal("新增锁定", body,
      '<button class="btn" data-close>取消</button><button class="btn btn-primary" id="lkSubmit">确认</button>');
    $("#lkSubmit").addEventListener("click", function () {
      var pair = $("#lkPair").value.trim();
      var until = $("#lkUntil").value;
      if (!pair || !until) return toast("请填写交易对和解锁时间", "err");
      api("/locks", {
        method: "POST",
        body: {
          pair: pair,
          side: $("#lkSide").value,
          until: new Date(until).toISOString(),
          reason: $("#lkReason").value.trim() || "手动锁定",
        },
      }).then(function () {
        toast("已添加锁定", "ok");
        closeModal();
        loadLocks();
      }).catch(function (e) {
        toast(e.message, "err");
      });
    });
  }

  // ===========================================================================
  // 日志
  // ===========================================================================
  function loadLogs() {
    return api("/logs").then(function (data) {
      var box = $("#logBox");
      box.innerHTML = "";
      ((data && data.logs) || []).slice(-300).forEach(function (row) {
        var lvl = row[3] || "INFO";
        var line = el("div", "logline");
        line.innerHTML =
          '<span class="ts">' + esc(row[0]) + "</span> " +
          '<span class="lvl-' + esc(lvl) + '">' + esc(lvl) + "</span> " + esc(row[4]);
        box.appendChild(line);
      });
      box.scrollTop = box.scrollHeight;
    });
  }

  // ===========================================================================
  // 图表工具（Canvas）
  // ===========================================================================
  function setupCanvas(cv, h) {
    var ratio = window.devicePixelRatio || 1;
    var w = cv.clientWidth || cv.parentElement.clientWidth;
    h = h || cv.height;
    cv.width = w * ratio;
    cv.height = h * ratio;
    cv.style.height = h + "px";
    var ctx = cv.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }
  function cssVar(n) {
    return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  }

  function drawBars(cv, data, valKey, labelKey) {
    var s = setupCanvas(cv);
    var ctx = s.ctx, w = s.w, h = s.h;
    ctx.clearRect(0, 0, w, h);
    if (!data.length) return;
    var pad = { l: 8, r: 8, t: 12, b: 22 };
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    var vals = data.map(function (d) { return d[valKey]; });
    var max = Math.max.apply(null, vals.concat([0]));
    var min = Math.min.apply(null, vals.concat([0]));
    var range = max - min || 1;
    var zeroY = pad.t + (max / range) * ih;
    var bw = iw / data.length;
    var up = cssVar("--up"), down = cssVar("--down"), dim = cssVar("--dim");
    ctx.strokeStyle = cssVar("--line");
    ctx.beginPath(); ctx.moveTo(pad.l, zeroY); ctx.lineTo(w - pad.r, zeroY); ctx.stroke();
    data.forEach(function (d, i) {
      var x = pad.l + i * bw + bw * 0.18, barW = bw * 0.64, v = d[valKey];
      var bh = (Math.abs(v) / range) * ih;
      ctx.fillStyle = v >= 0 ? up : down;
      ctx.fillRect(x, v >= 0 ? zeroY - bh : zeroY, barW, bh);
    });
    ctx.fillStyle = dim;
    ctx.font = "10px " + cssVar("--mono");
    ctx.textAlign = "center";
    var step = Math.ceil(data.length / 7);
    data.forEach(function (d, i) {
      if (i % step) return;
      ctx.fillText(shortLabel(d[labelKey]), pad.l + i * bw + bw / 2, h - 6);
    });
  }
  function shortLabel(s) {
    s = String(s);
    if (s.indexOf("/") >= 0) return s.split("/")[0]; // 交易对 -> 基础币种
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(5); // 日期 -> 月-日
    return s;
  }

  function drawSpark(cv, data) {
    var s = setupCanvas(cv);
    var ctx = s.ctx, w = s.w, h = s.h;
    ctx.clearRect(0, 0, w, h);
    if (!data.length) return;
    var pad = { l: 4, r: 4, t: 10, b: 10 };
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    var cum = [], run = 0;
    data.forEach(function (d) { run += d.abs_profit; cum.push(run); });
    var max = Math.max.apply(null, cum.concat([0])), min = Math.min.apply(null, cum.concat([0]));
    var range = max - min || 1;
    var brand = cssVar("--brand"), brand2 = cssVar("--brand-2");
    function px(i) { return pad.l + (i / Math.max(cum.length - 1, 1)) * iw; }
    function py(v) { return pad.t + ((max - v) / range) * ih; }
    var grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
    grad.addColorStop(0, brand2 + "44"); grad.addColorStop(1, brand2 + "00");
    ctx.beginPath(); ctx.moveTo(px(0), py(cum[0]));
    cum.forEach(function (v, i) { ctx.lineTo(px(i), py(v)); });
    ctx.lineTo(px(cum.length - 1), pad.t + ih); ctx.lineTo(px(0), pad.t + ih);
    ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); ctx.moveTo(px(0), py(cum[0]));
    cum.forEach(function (v, i) { ctx.lineTo(px(i), py(v)); });
    ctx.lineWidth = 2; ctx.strokeStyle = brand; ctx.stroke();
  }

  function loadOverviewCharts() {
    api("/daily?timescale=30").then(function (d) {
      state.daily = (d.data || []).slice().reverse();
      drawSpark($("#sparkChart"), state.daily);
      drawBars($("#dailyChart"), state.daily, "abs_profit", "date");
    }).catch(function () {});
    api("/performance").then(function (rows) {
      state.perf = (rows || []).slice(0, 12).map(function (r) {
        return { v: r.profit_abs, label: r.pair };
      });
      drawBars($("#pairChart"), state.perf.map(function (r) {
        return { abs: r.v, lab: r.label };
      }), "abs", "lab");
    }).catch(function () {});
  }

  // ----- K 线图 -----
  function colIdx(cols, name) {
    return cols.indexOf(name);
  }
  function loadChart() {
    var pair = state.chart.pair, tf = state.chart.tf;
    if (!pair || !tf) return;
    $("#chartReadout").textContent = "加载中…";
    api("/pair_candles?pair=" + encodeURIComponent(pair) + "&timeframe=" + encodeURIComponent(tf) + "&limit=200")
      .then(function (d) {
        state.chart.data = d;
        drawCandles(d);
        $("#chartReadout").textContent = "将鼠标移到 K 线上查看详情";
      }).catch(function (e) {
        $("#chartReadout").textContent = "加载失败：" + e.message;
      });
  }
  function drawCandles(d) {
    var cv = $("#candleChart");
    var s = setupCanvas(cv, 420);
    var ctx = s.ctx, w = s.w, h = s.h;
    ctx.clearRect(0, 0, w, h);
    var cols = d.columns || [];
    var rows = d.data || [];
    if (!rows.length) {
      ctx.fillStyle = cssVar("--dim");
      ctx.font = "13px " + cssVar("--sans");
      ctx.textAlign = "center";
      ctx.fillText("暂无 K 线数据", w / 2, h / 2);
      return;
    }
    var iO = colIdx(cols, "open"), iH = colIdx(cols, "high"), iL = colIdx(cols, "low"),
      iC = colIdx(cols, "close"), iV = colIdx(cols, "volume"), iD = colIdx(cols, "date");
    var pad = { l: 8, r: 58, t: 12, b: 20 };
    var volH = 56;
    var priceH = h - pad.t - pad.b - volH - 8;
    var iw = w - pad.l - pad.r;
    var hi = -Infinity, lo = Infinity, maxV = 0;
    rows.forEach(function (r) {
      hi = Math.max(hi, r[iH]); lo = Math.min(lo, r[iL]);
      if (iV >= 0) maxV = Math.max(maxV, r[iV] || 0);
    });
    var rng = hi - lo || 1;
    var bw = iw / rows.length;
    function py(p) { return pad.t + ((hi - p) / rng) * priceH; }
    var up = cssVar("--up"), down = cssVar("--down"), grid = cssVar("--line"), dim = cssVar("--dim");

    // 网格 + 价格轴
    ctx.strokeStyle = grid; ctx.fillStyle = dim;
    ctx.font = "10px " + cssVar("--mono"); ctx.textAlign = "left";
    for (var g = 0; g <= 4; g++) {
      var yy = pad.t + (priceH / 4) * g;
      ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(pad.l + iw, yy); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(fmtNum(hi - (rng / 4) * g, 4), pad.l + iw + 6, yy + 3);
    }

    // 主图指标线（plot_config main_plot）
    var mainPlot = (state.chart.plot && state.chart.plot.main_plot) || {};
    var legendItems = [];
    Object.keys(mainPlot).forEach(function (name, ix) {
      var ci = colIdx(cols, name);
      if (ci < 0) return;
      var color = (mainPlot[name] && mainPlot[name].color) || ["#7c3aed", "#d98300", "#0a9d57", "#e5484d"][ix % 4];
      ctx.beginPath(); ctx.lineWidth = 1.4; ctx.strokeStyle = color;
      var started = false;
      rows.forEach(function (r, i) {
        var v = r[ci];
        if (v == null || isNaN(v)) return;
        var x = pad.l + i * bw + bw / 2, yv = py(v);
        if (!started) { ctx.moveTo(x, yv); started = true; } else ctx.lineTo(x, yv);
      });
      ctx.stroke();
      legendItems.push('<span><i style="background:' + color + '"></i>' + esc(name) + "</span>");
    });

    // K 线
    rows.forEach(function (r, i) {
      var x = pad.l + i * bw + bw / 2;
      var bull = r[iC] >= r[iO];
      ctx.strokeStyle = bull ? up : down; ctx.fillStyle = bull ? up : down;
      ctx.beginPath(); ctx.moveTo(x, py(r[iH])); ctx.lineTo(x, py(r[iL])); ctx.stroke();
      var bodyW = Math.max(1, bw * 0.62);
      var yO = py(r[iO]), yC = py(r[iC]);
      ctx.fillRect(x - bodyW / 2, Math.min(yO, yC), bodyW, Math.max(1, Math.abs(yC - yO)));
    });

    // 成交量
    var volTop = pad.t + priceH + 8;
    if (iV >= 0 && maxV > 0) {
      rows.forEach(function (r, i) {
        var x = pad.l + i * bw + bw * 0.19;
        var vh = ((r[iV] || 0) / maxV) * volH;
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = r[iC] >= r[iO] ? up : down;
        ctx.fillRect(x, volTop + volH - vh, Math.max(1, bw * 0.62), vh);
      });
      ctx.globalAlpha = 1;
    }

    // 入场/出场标记
    var iEL = colIdx(cols, "enter_long"), iELx = colIdx(cols, "exit_long");
    rows.forEach(function (r, i) {
      var x = pad.l + i * bw + bw / 2;
      if (iEL >= 0 && r[iEL]) marker(ctx, x, py(r[iL]) + 8, up, "▲");
      if (iELx >= 0 && r[iELx]) marker(ctx, x, py(r[iH]) - 8, down, "▼");
    });

    $("#chartLegend").innerHTML =
      '<span><i style="background:' + up + '"></i>阳线</span><span><i style="background:' + down + '"></i>阴线</span>' +
      legendItems.join("");
    state.chart._geom = { pad: pad, bw: bw, rows: rows, cols: cols, iO: iO, iH: iH, iL: iL, iC: iC, iV: iV, iD: iD, py: py, w: w };
  }
  function marker(ctx, x, y, color, ch) {
    ctx.fillStyle = color;
    ctx.font = "10px " + cssVar("--sans");
    ctx.textAlign = "center";
    ctx.fillText(ch, x, y);
  }
  function chartHover(e) {
    var g = state.chart._geom;
    if (!g) return;
    var rect = e.target.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var i = Math.floor((x - g.pad.l) / g.bw);
    if (i < 0 || i >= g.rows.length) return;
    var r = g.rows[i];
    $("#chartReadout").textContent =
      (g.iD >= 0 ? String(r[g.iD]).replace("T", " ").slice(0, 16) + "  " : "") +
      "开 " + fmtNum(r[g.iO], 4) + "  高 " + fmtNum(r[g.iH], 4) +
      "  低 " + fmtNum(r[g.iL], 4) + "  收 " + fmtNum(r[g.iC], 4) +
      (g.iV >= 0 ? "  量 " + fmtNum(r[g.iV], 2) : "");
  }
  function initChartControls() {
    api("/whitelist").then(function (d) {
      state.whitelist = d.whitelist || [];
      var sel = $("#chartPair");
      sel.innerHTML = state.whitelist.map(function (p) {
        return '<option value="' + esc(p) + '">' + esc(p) + "</option>";
      }).join("");
      if (!state.chart.pair && state.whitelist.length) state.chart.pair = state.whitelist[0];
      sel.value = state.chart.pair;
      loadChart(); // 白名单就绪后再加载，避免首次 pair 为空
    });
    var tfs = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];
    var def = (state.config && state.config.timeframe) || "5m";
    if (tfs.indexOf(def) < 0) tfs.unshift(def);
    var tfSel = $("#chartTf");
    tfSel.innerHTML = tfs.map(function (t) {
      return '<option value="' + t + '">' + t + "</option>";
    }).join("");
    if (!state.chart.tf) state.chart.tf = def;
    tfSel.value = state.chart.tf;
    api("/plot_config").then(function (p) { state.chart.plot = p; }).catch(function () {});
  }

  // ===========================================================================
  // 视图调度
  // ===========================================================================
  function loadView(view, silent) {
    try {
      if (view === "overview") { refreshOverview(); loadOverviewCharts(); }
      else if (view === "trade") loadTrades();
      else if (view === "chart") loadChart();
      else if (view === "performance") loadPerformance();
      else if (view === "history") loadHistory();
      else if (view === "pairlist") loadPairlist();
      else if (view === "locks") loadLocks();
      else if (view === "logs") loadLogs();
    } catch (e) {
      if (!silent) toast(e.message, "err");
    }
  }
  function refreshOverview() {
    Promise.all([
      api("/profit"),
      api("/count"),
      api("/balance").catch(function () { return null; }),
    ]).then(function (r) {
      renderOverview(r[0], r[1], r[2]);
    }).catch(function (e) {
      toast(e.message, "err");
    });
  }
  function refreshAll() {
    api("/show_config").then(renderConfig).catch(function (e) { toast(e.message, "err"); });
    loadView(state.view, true);
  }

  var TITLES = {
    overview: "总览", trade: "交易", chart: "图表", performance: "绩效",
    history: "交易记录", pairlist: "配对列表", locks: "锁定", logs: "日志",
  };
  function switchView(view) {
    state.view = view;
    $all(".nav-item").forEach(function (n) {
      n.classList.toggle("active", n.getAttribute("data-view") === view);
    });
    $all("[data-view-content]").forEach(function (sec) {
      sec.classList.toggle("hidden", sec.getAttribute("data-view-content") !== view);
    });
    $("#viewTitle").textContent = TITLES[view] || view;
    $("#sidebar").classList.remove("open");
    if (view === "chart") initChartControls();
    loadView(view);
  }

  function enterApp() {
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    refreshAll();
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      api("/show_config").then(function (c) { renderState(c.state); }).catch(function () {});
      // 仅自动刷新“实时”类视图，避免打断用户操作
      if (["overview", "trade", "logs"].indexOf(state.view) >= 0) loadView(state.view, true);
    }, REFRESH_MS);
  }

  // ===========================================================================
  // 主题
  // ===========================================================================
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    LS.setItem("ft_theme", t);
    $("#themeBtn").textContent = t === "dark" ? "☀" : "☾";
    redrawCharts();
  }
  function redrawCharts() {
    if (state.daily.length) {
      drawSpark($("#sparkChart"), state.daily);
      drawBars($("#dailyChart"), state.daily, "abs_profit", "date");
    }
    if (state.perf.length) {
      drawBars($("#pairChart"), state.perf.map(function (r) { return { abs: r.v, lab: r.label }; }), "abs", "lab");
    }
    if (state.chart.data && state.view === "chart") drawCandles(state.chart.data);
  }

  // ===========================================================================
  // 初始化
  // ===========================================================================
  function init() {
    applyTheme(LS.getItem("ft_theme") || "light");
    $("#server").value = state.server;

    $("#loginForm").addEventListener("submit", function (e) {
      e.preventDefault();
      login($("#server").value.trim() || window.location.origin, $("#username").value, $("#password").value);
    });
    $all(".nav-item").forEach(function (n) {
      n.addEventListener("click", function () { switchView(n.getAttribute("data-view")); });
    });

    $("#startBtn").addEventListener("click", function () { control("/start", "启动"); });
    $("#stopBtn").addEventListener("click", function () { control("/stop", "停止"); });
    $("#pauseBtn").addEventListener("click", function () { control("/stopentry", "暂停入场"); });
    $("#reloadBtn").addEventListener("click", function () { control("/reload_config", "重载配置"); });
    $("#logoutBtn").addEventListener("click", logout);
    $("#themeBtn").addEventListener("click", function () {
      applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
    });
    $("#menuToggle").addEventListener("click", function () { $("#sidebar").classList.toggle("open"); });

    $("#forceEntryBtn").addEventListener("click", openForceEntry);
    $("#exitAllBtn").addEventListener("click", exitAll);
    $("#logRefresh").addEventListener("click", loadLogs);

    // 图表控件
    $("#chartPair").addEventListener("change", function () { state.chart.pair = this.value; loadChart(); });
    $("#chartTf").addEventListener("change", function () { state.chart.tf = this.value; loadChart(); });
    $("#chartReload").addEventListener("click", loadChart);
    $("#candleChart").addEventListener("mousemove", chartHover);

    // 绩效周期切换
    $("#periodSeg").addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      state.period = b.getAttribute("data-period");
      $all("#periodSeg button").forEach(function (x) { x.classList.toggle("active", x === b); });
      loadPeriod();
    });

    // 历史分页
    $("#histPrev").addEventListener("click", function () {
      state.history.offset = Math.max(0, state.history.offset - state.history.limit);
      loadHistory();
    });
    $("#histNext").addEventListener("click", function () {
      state.history.offset += state.history.limit;
      loadHistory();
    });

    // 配对列表 / 锁定
    $("#blAddBtn").addEventListener("click", addBlacklist);
    $("#blInput").addEventListener("keydown", function (e) { if (e.key === "Enter") addBlacklist(); });
    $("#addLockBtn").addEventListener("click", openAddLock);

    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });
    window.addEventListener("resize", redrawCharts);

    if (state.access && state.refresh) {
      api("/show_config").then(function () { enterApp(); }).catch(function () { logout(); });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
