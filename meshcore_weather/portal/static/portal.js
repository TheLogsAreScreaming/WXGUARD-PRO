// mesh-wx admin: one page, hash routing, vanilla JS.
//
// Tabs by job, like the public dashboard: overview, mesh (traffic, broadcast
// jobs, limits, command tester), radio (the node), station (dish and feed),
// settings (every .env setting, one save bar), logs. One poller feeds the
// header strip and the Overview; every other tab loads on enter and stops its
// timers and streams on leave.

// Every state-changing request carries a header a cross-site page cannot
// add without a CORS preflight (which the server never grants). The server
// refuses POST/PUT/DELETE without it.
(function () {
  var nativeFetch = window.fetch;
  window.fetch = function (url, opts) {
    opts = opts || {};
    var method = (opts.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && typeof url === "string" && url.charAt(0) === "/") {
      var h = new Headers(opts.headers || {});
      h.set("X-Requested-With", "meshcore-portal");
      opts.headers = h;
    }
    return nativeFetch.call(window, url, opts);
  };
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function api(url, opts) {
  opts = opts || {};
  if (opts.body && typeof opts.body !== "string") {
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    opts.body = JSON.stringify(opts.body);
  }
  return fetch(url, opts).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (d) {
      if (!r.ok) throw new Error(d.detail || ("HTTP " + r.status));
      return d;
    });
  });
}

// An inset tile: the big number, what it counts, and one line of detail.
// cls is ok | warn | bad | dim.
function tile(label, value, hint, cls) {
  var c = { ok: "good", warn: "warn", bad: "bad", dim: "dim" }[cls] || "";
  return '<div class="tile ' + c + '"><div class="v" title="' + esc(String(value).replace(/<[^>]*>/g, "")) + '">' + value + "</div>" +
    '<div class="l">' + esc(label) + "</div>" + (hint ? '<div class="h" title="' + esc(hint) + '">' + esc(hint) + "</div>" : "") + "</div>";
}

// A status card at the top of the Overview: a coloured dot, a name, a state, a line.
function card(k, v, d, cls, href) {
  return '<a class="stat ' + (cls || "") + '" href="' + href + '"><span class="dot" aria-hidden="true"></span><div>' +
    '<div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div><div class="d">' + esc(d) + "</div></div></a>";
}

function pill(text, cls, title) {
  return '<span class="pill ' + (cls || "") + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" + text + "</span>";
}

function ago(s) {
  if (s == null || isNaN(s)) return "–";
  s = Math.max(0, Math.round(s));
  if (s < 90) return s + "s";
  if (s < 5400) return Math.round(s / 60) + "m";
  if (s < 172800) return Math.round(s / 3600) + "h";
  return Math.round(s / 86400) + "d";
}

function agoAt(t) { return t ? ago(Date.now() / 1000 - t) : "–"; }

function hhmmss(t) { return new Date(t * 1000).toTimeString().slice(0, 8); }

function $(id) { return document.getElementById(id); }

function setVal(id, v) {
  var el = $(id);
  if (el && document.activeElement !== el) el.value = v == null ? "" : v;
}

function setLive(id, state) { var el = $(id); if (el) el.className = "live " + (state || ""); }

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// A canvas drawn at the screen's own resolution: [context, width, height, dpr].
function canvas(id, h) {
  var c = $(id), dpr = window.devicePixelRatio || 1, W = c.clientWidth || 600;
  c.style.height = h + "px";
  c.width = Math.round(W * dpr); c.height = Math.round(h * dpr);
  var x = c.getContext("2d");
  x.font = Math.round(11 * dpr) + "px -apple-system, system-ui, sans-serif";
  return [x, c.width, c.height, dpr];
}

// Hover (or a finger held) on a chart: a cursor at the sample under the
// pointer and a card of its figures. `pick(f)`, f the pointer's fraction of
// the way across, gives {x: the sample's fraction across, html} or null. The
// returned function shows it again for the pointer where it is; the chart's
// redraw calls it, so the card follows new data.
function chartHover(id, pick) {
  var c = $(id), host = c.parentNode, at = null;
  var line = document.createElement("div"), tip = document.createElement("div");
  host.classList.add("charthost");
  c.classList.add("hoverable");
  line.className = "chartline"; tip.className = "charttip";
  line.hidden = tip.hidden = true;
  host.appendChild(line); host.appendChild(tip);
  function show() {
    var w = c.clientWidth, p = at == null || !w ? null : pick(Math.max(0, Math.min(1, at / w)));
    line.hidden = tip.hidden = !p;
    if (!p) return;
    var left = c.offsetLeft + p.x * w;
    line.style.left = left + "px"; line.style.top = c.offsetTop + "px"; line.style.height = c.clientHeight + "px";
    tip.innerHTML = p.html;
    var tw = tip.offsetWidth;            // right of the cursor, or left of it near the right edge
    tip.style.left = Math.max(c.offsetLeft, p.x * w + 12 + tw > w ? left - 12 - tw : left + 12) + "px";
    tip.style.top = c.offsetTop + 6 + "px";
  }
  function move(e) { at = e.offsetX; show(); }
  function out() { at = null; show(); }
  c.addEventListener("pointermove", move);
  c.addEventListener("pointerdown", move);
  c.addEventListener("pointerleave", out);
  c.addEventListener("pointercancel", out);
  return show;
}

// Time across a history chart W wide from t0 to t1: a line and a label at
// each midnight, or every four hours on a chart of a day or less (local time).
function timeTicks(x, W, H, dpr, t0, t1) {
  var day = t1 - t0 > 36 * 3600, d = new Date(t0 * 1000);
  d.setMinutes(0, 0, 0);
  if (day) d.setHours(24); else d.setHours(Math.ceil(d.getHours() / 4) * 4);
  x.strokeStyle = css("--line"); x.fillStyle = css("--dim"); x.lineWidth = dpr;
  for (; d.getTime() / 1000 <= t1; day ? d.setDate(d.getDate() + 1) : d.setHours(d.getHours() + 4)) {
    var t = d.getTime() / 1000, X = (t - t0) / (t1 - t0) * W;
    x.beginPath(); x.moveTo(X, 0); x.lineTo(X, H - 14 * dpr); x.stroke();
    x.fillText(day ? d.toLocaleDateString([], { weekday: "short", day: "numeric" }) : d.toTimeString().slice(0, 5), X + 3 * dpr, H - 3 * dpr);
  }
}

function tipRows(rows) {
  return "<table>" + rows.map(function (r) { return "<tr><td>" + esc(r[0]) + "</td><td>" + esc(r[1]) + "</td></tr>"; }).join("") + "</table>";
}

// A live stream: hello frame → green dot, error → red dot, items → onEvent.
function liveStream(url, onEvent, dotId) {
  var es = new EventSource(url);
  setLive(dotId, "");
  es.onopen = function () { setLive(dotId, "ok"); };
  es.onerror = function () { setLive(dotId, "bad"); };
  es.onmessage = function (m) {
    var d; try { d = JSON.parse(m.data); } catch (e) { return; }
    if (!d || d.hello) { setLive(dotId, "ok"); return; }
    onEvent(d);
  };
  return es;
}

function appendLine(el, html, max) {
  var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.insertAdjacentHTML("beforeend", html);
  while (el.childElementCount > max) el.removeChild(el.firstChild);
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// The chips of a group act like radio buttons: the pressed one is "on".
function pressChip(groupId, attr, value) {
  document.querySelectorAll("#" + groupId + " button").forEach(function (b) { b.classList.toggle("on", b.dataset[attr] === value); });
}

// One answer of several packets: how many the mesh is known to have carried,
// with every packet's own result in the tooltip. Each packet used to write
// its result over the last one's, so the row showed whichever finished last.
function batchBadge(d) {
  var lines = (d.parts || []).map(function (p, i) {
    var n = (i + 1) + ": ";
    if (!p) return n + "waiting";
    var r = p.result === "echoed" ? "echo " + (p.echo_ms != null ? (p.echo_ms / 1000).toFixed(1) + " s" : "") + (p.via ? " via " + p.via : "") + (p.late ? " (late)" : "")
      : p.result === "skipped" ? "no echo, not resent: " + p.skipped
      : p.result === "no_echo" ? "no echo" : p.result;
    if (p.resent) r += ", resent";
    if (p.observed_repeats) r += ", repeat heard by " + p.observed_repeats;
    return n + r;
  });
  var cls = d.pending ? "" : d.heard === d.packets ? "ok" : d.heard ? "warn" : "bad";
  var b = " " + pill("heard " + d.heard + " of " + d.packets + (d.pending ? " · " + d.pending + " waiting" : ""), cls, lines.join("\n"));
  if (d.resent) b += " " + pill("resent ×" + d.resent, "warn");
  return b;
}

function deliveryBadge(d) {
  if (!d) return "";
  if (d.result === "batch") return batchBadge(d);
  var b = "";
  if (d.acked) b += " " + pill("ack " + (d.rtt_ms != null ? (d.rtt_ms / 1000).toFixed(1) + " s" : ""), "ok", "the recipient acknowledged it");
  else if (d.echo) {
    var tip = "a repeater repeated it, timed from the transmission that was echoed";
    if (d.resent && d.echo_total_ms != null) tip += ". " + (d.echo_total_ms / 1000).toFixed(1) + " s since the first send; the resend is byte-identical so we cannot tell which copy came back";
    if (d.late) tip += ". It came in after the wait was over";
    b += " " + pill("echo " + (d.echo_ms != null ? (d.echo_ms / 1000).toFixed(1) + " s" : "") + (d.via ? " via " + esc(d.via) : "") + (d.late ? " (late)" : ""), "ok", tip);
  }
  else if (d.result === "skipped") b += " " + pill("no echo · not resent: " + esc(d.skipped), "warn");
  else b += " " + pill(d.result === "no_ack" ? "no ack" : "no echo", "bad");
  if (d.resent) b += " " + pill("resent ×" + d.resent, "warn");
  // Only the settled CoreScope reading lands here. The probe taken to decide
  // the resend is seconds old and used to render as "direct only: 1" on
  // exactly the replies the mesh had in fact carried.
  if (d.observed_by) {
    var rep = d.observed_repeats || 0, direct = d.observed_by - rep;
    if (rep) b += " " + pill("repeat heard by " + rep + " observer" + (rep === 1 ? "" : "s"), "ok",
      "CoreScope: observers whose copy came through a repeater" + (d.observed_paths ? ": " + d.observed_paths.join(" | ") : ""));
    if (direct) b += " " + pill("direct only: " + direct, "", "CoreScope: heard us at zero hops, proves no repeat");
  }
  return b;
}

function nextRun(s) { return s == null ? "nothing due" : s === 0 ? "due at the next tick" : "next in " + ago(s); }

// How replies go out, as the Overview's bot card and the header strip say it.
var REPLY_MODES = { dm: "by DM", channel: "on the channel", dm_only: "by DM only" };
var STRIP_MODES = { dm: "DM replies", channel: "channel replies", dm_only: "DM only" };

// ---------------------------------------------------------------------------
// The portal
// ---------------------------------------------------------------------------

var Portal = {

  // -- Router: #tab or #tab/section --------------------------------------------

  router: {
    sections: ["overview", "mesh", "radio", "station", "settings", "logs"],
    // Old addresses, from bookmarks and the docs, land where their page went.
    legacy: { textbot: "mesh", broadcasts: "mesh/jobs", broadcast: "mesh/jobs", satellite: "station", sdr: "station",
              system: "logs", "system/logs": "logs", "system/settings": "settings", console: "logs", map: "overview" },
    current: null,

    init: function () {
      var self = this;
      window.addEventListener("hashchange", function () { self.apply(); });
      this.apply();
    },

    apply: function () {
      var raw = (window.location.hash || "#overview").slice(1);
      if (this.legacy[raw]) raw = this.legacy[raw];
      var parts = raw.split("/"), sec = parts[0], sub = parts[1] || null;
      if (this.legacy[sec]) { parts = this.legacy[sec].split("/"); sec = parts[0]; sub = sub || parts[1] || null; }
      if (this.sections.indexOf(sec) === -1) { sec = "overview"; sub = null; }
      if (sec !== this.current) {
        var prev = this.current;
        if (prev && Portal[prev].onLeave) Portal[prev].onLeave();
        this.current = sec;
        document.querySelectorAll("#main-nav a[data-section]").forEach(function (a) {
          a.setAttribute("aria-selected", a.dataset.section === sec ? "true" : "false");
        });
        document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("on", t.id === "tab-" + sec); });
        document.body.classList.toggle("saving", false);
        window.scrollTo(0, 0);
        if (Portal[sec].onEnter) Portal[sec].onEnter();
      }
      if (sub) this.scrollTo(sec + "-" + sub);
    },

    scrollTo: function (id) {
      setTimeout(function () { var el = $(id); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 30);
    },
  },

  // -- UI -----------------------------------------------------------------------

  ui: {
    _toastTimer: null,
    toast: function (msg, ok) {
      var el = $("toast");
      el.textContent = msg;
      el.className = "toast" + (ok === false ? " err" : "");
      el.hidden = false;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(function () { el.hidden = true; }, 4000);
    },
    openModal: function (html, wide) {
      var c = $("modal-content");
      c.innerHTML = html;
      c.className = "modal-content" + (wide ? " wide" : "");
      $("modal-overlay").hidden = false;
      var first = c.querySelector("input:not([type=hidden]):not([readonly]), select, button");
      if (first) first.focus();
    },
    closeModal: function () { $("modal-overlay").hidden = true; $("modal-content").innerHTML = ""; },
  },

  // -- One poller for the header strip and the Overview -------------------------

  poll: {
    _timer: null, last: null,
    start: function () {
      var self = this;
      this.tick();
      this._timer = setInterval(function () { self.tick(); }, 15000);
    },
    tick: function () {
      var self = this;
      api("/api/overview").then(function (d) {
        self.last = d;
        Portal.header.render(d);
        if (Portal.router.current === "overview") Portal.overview.render(d);
      }).catch(function (e) {
        Portal.header.offline(e.message);
        if (Portal.router.current === "overview") $("ov-updated").textContent = "The portal does not answer: " + e.message;
      });
    },
  },

  header: {
    _set: function (id, text, cls, title) {
      var el = $(id);
      el.className = "pill " + (cls || "");
      el.innerHTML = "<i></i>" + esc(text);
      el.title = title || "";
    },
    render: function (d) {
      var sat = d.satellite || {}, r = d.radio || {}, h = r.health || {}, hv = h.verdict;
      this._set("strip-sat", !sat.reachable ? "dish ?" : sat.mode === "point" ? "dish being aimed" : sat.locked ? "dish locked" : "no lock",
        !sat.reachable ? "bad" : sat.mode === "point" ? "info" : sat.locked ? "ok" : "warn", sat.error || "");
      var unwell = r.connected && (hv === "tx_suspect" || hv === "rx_silent" || r.pending_adoption);
      this._set("strip-radio", !r.connected ? "radio down" : (r.name || "radio") + (r.pending_adoption ? " · different radio" : hv === "tx_suspect" ? " · TX suspect" : hv === "rx_silent" ? " · hearing nothing" : ""),
        !r.connected ? "bad" : unwell ? "warn" : "ok", h.reason || r.error || "");
      this._set("strip-tx", r.tx_enabled ? "TX on · " + (STRIP_MODES[r.reply_mode] || r.reply_mode) : "TX off",
        r.tx_enabled ? "ok" : "warn", r.tx_enabled ? "" : "Receive only: no replies, adverts or broadcasts");
      var n = (d.problems || {}).errors_last_hour || 0, el = $("logs-n-errors");
      el.hidden = !n; el.textContent = n; el.title = n + " errors in the last hour";
      if (d.dashboard_url) {
        var base = d.dashboard_url.replace(/\/$/, "");
        $("pub-link").href = base + "/"; $("pub-station").href = base + "/#station"; $("pub-weather").href = base + "/#weather";
      }
    },
    offline: function (msg) {
      this._set("strip-sat", "portal ?", "bad", msg);
      this._set("strip-radio", "radio ?", "", msg);
      this._set("strip-tx", "transmit ?", "", msg);
    },
  },

  // -- Overview -----------------------------------------------------------------

  overview: {
    onEnter: function () {
      if (Portal.poll.last) this.render(Portal.poll.last);
      Portal.poll.tick();
    },
    _tabName: { overview: "Overview", mesh: "Mesh", radio: "Radio", station: "Station", settings: "Settings", logs: "Logs" },
    render: function (d) {
      var sat = d.satellite || {}, feed = d.feed || {}, r = d.radio || {}, tb = d.textbot || {}, au = d.audit || {}, host = d.host || {};
      var fill = feed.fill || {}, h = r.health || {}, self = this;

      // The four cards: bot, radio, dish and feed, host.
      var lastReq = tb.last_request_at ? "last request " + agoAt(tb.last_request_at) + " ago" : "no requests yet";
      var botCard = card("Weather bot", r.tx_enabled ? "Answering " + (REPLY_MODES[r.reply_mode] || r.reply_mode) : "Receive only",
        (tb.requests_24h || 0) + " requests and " + (tb.replies_24h || 0) + " replies in 24 h · " + lastReq, r.tx_enabled ? "ok" : "warn", "#mesh");
      var verdict = { ok: "healthy", idle: "idle", tx_off: "transmit off", tx_suspect: "transmit suspect", rx_silent: "hearing nothing", unknown: "unclear" }[h.verdict] || "";
      var radioCard = card("Radio", r.connected ? (r.name || "Connected") + (verdict ? " · " + verdict : "") : "Not connected",
        r.connected ? [r.freq_mhz != null ? r.freq_mhz + " MHz" : "", r.battery_mv ? (r.battery_mv / 1000).toFixed(2) + " V" : "", h.reason || ""].filter(Boolean).join(" · ") : (r.error || ""),
        !r.connected ? "bad" : (h.verdict === "tx_suspect" || h.verdict === "rx_silent" || r.pending_adoption) ? "warn" : "ok", "#radio");
      var age = feed.newest_age_s;
      var dishV = !sat.reachable ? "Receiver unreachable" : sat.mode === "point" ? "Being aimed" : sat.locked ? "Locked" : "No lock";
      var dishD = [sat.reachable && sat.mode !== "point" && sat.vit_avg != null ? "Viterbi " + sat.vit_avg : "",
        age != null ? "newest product " + ago(age) + " old" : "no products",
        feed.lag_min != null && feed.lag_min >= 5 ? "EMWIN " + Math.round(feed.lag_min) + " min behind" : "",
        fill.active ? "internet filling in" : ""].filter(Boolean).join(" · ");
      var dishCls = !sat.reachable || age == null ? "bad" : sat.mode === "point" ? "info" : !sat.locked || fill.active || age > 1800 || feed.lag_min >= 30 ? "warn" : "ok";
      var disk = host.disk_used_pct, temp = host.temp_c;
      var hostCls = disk > 85 || temp > 80 ? "bad" : disk > 75 || temp > 75 ? "warn" : "ok";
      var hostCard = card("Host", (disk != null ? disk + "% disk" : "–") + (temp != null ? " · " + temp + "°C" : ""),
        [host.mem_available_mb != null ? host.mem_available_mb + " MB free" : "", host.load ? "load " + host.load[0] : "",
         "bot up " + ago((d.bot || {}).uptime_s), (d.bot || {}).git ? "commit " + d.bot.git : ""].filter(Boolean).join(" · "), hostCls, "#settings/host");
      $("ov-cards").innerHTML = botCard + radioCard + card("Dish and feed", dishV, dishD, dishCls, "#station") + hostCard;

      // What needs the operator: worked out by the server (admin.attention).
      var items = d.attention || [];
      var label = { bad: "Problem", warn: "Check", info: "Note" };
      $("ov-attn").innerHTML = items.length ? items.map(function (i) {
        var tab = (i.href || "#overview").slice(1).split("/")[0];
        return '<li><a href="' + esc(i.href) + '">' + pill(label[i.level] || i.level, i.level) + "<span>" + esc(i.text) + '</span><span class="go">' +
          esc(self._tabName[tab] || "") + " →</span></a></li>";
      }).join("") : '<li class="allclear">' + pill("All clear", "ok") + " Nothing needs you right now.</li>";
      $("ov-updated").textContent = "Updated " + new Date().toLocaleTimeString();

      // Mesh activity.
      var dv = ((tb.delivery || {}).windows || {})["24h"] || {};
      $("ov-act").innerHTML =
        tile("requests", tb.requests_24h || 0, (tb.requests_1h || 0) + " in the last hour") +
        tile("replies", tb.replies_24h || 0, (tb.replies_1h || 0) + " in the last hour") +
        tile("heard back", dv.sent ? dv.heard_pct + "%" : "–", dv.sent ? dv.heard + " of " + dv.sent + " replies" : "no replies yet",
          dv.sent ? (dv.heard_pct >= 80 ? "ok" : dv.heard_pct >= 50 ? "warn" : "bad") : "dim") +
        tile("not answered", tb.dropped_24h || 0, "limits, hop gate, a nearer bot", tb.dropped_1h ? "warn" : "") +
        tile("nodes served", tb.senders_24h || 0, "distinct senders");
      var rec = $("ov-recent");
      rec.innerHTML = (d.recent || []).map(function (ev) { return Portal.traffic.fmt(ev); }).join("") ||
        '<div class="m">Nothing yet. A request on the channel or a DM shows up here.</div>';
      rec.scrollTop = rec.scrollHeight;

      this.renderAudit(au);
    },

    renderAudit: function (au) {
      var p = $("ov-audit-pill"), when = $("ov-audit-when"), el = $("ov-audit");
      if (!au.available) {
        p.className = "pill"; p.textContent = "Not run yet";
        when.textContent = "";
        el.innerHTML = '<p class="hint">No result yet. The audit timer (meshcore-weather-audit.timer) writes data/audit.json every hour.</p>';
        return;
      }
      var stale = au.age_s != null && au.age_s > 3 * 3600;
      p.className = "pill " + (stale ? "warn" : au.failed ? "warn" : "ok");
      p.textContent = stale ? "Stale" : au.failed ? au.failed + " failed" : "All passed";
      when.textContent = "Last run " + (au.age_s != null ? ago(au.age_s) + " ago" : new Date(au.at).toLocaleString()) + " · " + au.passed + " of " + (au.passed + au.failed) + " passed";
      var chips = Object.keys(au.by_check || {}).map(function (k) {
        var c = au.by_check[k];
        return pill(esc(k) + " " + c.pass + "/" + (c.pass + c.fail), c.fail ? "bad" : "ok");
      }).join(" ");
      var html = '<div class="chips">' + chips + "</div>";
      if ((au.failures || []).length) {
        html += '<div class="tbl mt"><table><tbody>' + au.failures.map(function (f) {
          return '<tr><td class="k">' + esc(f.check) + '</td><td class="k">' + esc(f.subject) + "</td><td>" + esc(f.detail) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
      }
      if (stale) html += '<p class="hint mt">The audit runs from a timer on the Pi: <code>systemctl status meshcore-weather-audit.timer</code>.</p>';
      el.innerHTML = html;
    },
  },

  // -- Mesh: the four parts load and stop together -------------------------------

  mesh: {
    onEnter: function () {
      Portal.textbot.enter();
      Portal.traffic.start();
      Portal.limits.start();
      Portal.broadcasts.start();
    },
    onLeave: function () { Portal.traffic.stop(); Portal.limits.stop(); Portal.broadcasts.stop(); },
  },

  traffic: {
    _events: [], _max: 1500, _kind: "all", _sse: null, _lastId: 0, _timer: null,
    _filters: {
      all: null,
      channel: ["channel_in", "reply_channel", "peer"],
      dm: ["dm_in", "reply_dm", "dm_failed", "admin"],
      dropped: ["dropped", "dm_failed"],
      adverts: ["advert", "advert_out", "link_test"],
      apps: ["data_request", "reply_data"],
    },

    start: function () {
      var self = this;
      api("/api/traffic?n=400").then(function (d) {
        self._events = d.events || [];
        self._lastId = self._events.length ? self._events[self._events.length - 1].id : 0;
        self.renderStats(d.stats);
        self.render();
        self._connect();
      }).catch(function (e) { Portal.ui.toast("Traffic: " + e.message, false); });
      if (this._timer) clearInterval(this._timer);
      this._timer = setInterval(function () {
        api("/api/traffic?n=1").then(function (d) { self.renderStats(d.stats); }).catch(function () {});
      }, 30000);
    },
    stop: function () {
      if (this._sse) { this._sse.close(); this._sse = null; }
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },
    _connect: function () {
      var self = this;
      if (this._sse) this._sse.close();
      this._sse = liveStream("/api/traffic/stream", function (ev) {
        if (ev.id && ev.id <= self._lastId) {          // an update to a line we have (delivery outcome)
          for (var i = self._events.length - 1; i >= 0; i--) if (self._events[i].id === ev.id) { self._events[i] = ev; break; }
          var line = $("traffic-body").querySelector('[data-id="' + ev.id + '"]');
          if (line) line.outerHTML = self.fmt(ev);
          return;
        }
        self._lastId = ev.id || self._lastId;
        self._events.push(ev);
        if (self._events.length > self._max) self._events.splice(0, self._events.length - self._max);
        if (self._show(ev)) appendLine($("traffic-body"), self.fmt(ev), self._max);
        self._status();
      }, "traffic-dot");
    },
    _status: function () { $("traffic-status").textContent = this._events.length + " events"; },
    setKind: function (k) {
      this._kind = k;
      pressChip("traffic-kinds", "k", k);
      this.render();
    },
    _show: function (ev) { var f = this._filters[this._kind]; return !f || f.indexOf(ev.kind) !== -1; },
    renderStats: function (st) {
      if (!st) return;
      var w24 = st.windows["24h"], w1 = st.windows["1h"], lt = st.lifetime, lat = st.latency || {};
      var top = Object.keys(w24.by_command || {}).sort(function (a, b) { return w24.by_command[b] - w24.by_command[a]; }).slice(0, 3)
        .map(function (k) { return k + " " + w24.by_command[k]; }).join(", ");
      var since = lt.since ? new Date(lt.since * 1000).toLocaleDateString() : "";
      var dv = ((st.delivery || {}).windows || {})["24h"] || {};
      var dvHint = dv.sent ? dv.heard + " of " + dv.sent + " heard back" + (dv.carried ? " · " + dv.carried + " more seen by CoreScope" : "") + (dv.echo_median_ms != null ? " · echo " + (dv.echo_median_ms / 1000).toFixed(1) + " s" : "") + (dv.resent ? " · " + dv.resent + " resent" : "") : "no replies yet";
      $("traffic-stats").innerHTML =
        tile("requests · 24 h", w24.requests, w1.requests + " in the last hour" + (top ? " · " + top : "") + " · " + lt.requests + " since " + since) +
        tile("heard back · 24 h", dv.sent ? dv.heard_pct + "%" : "–", dvHint, dv.sent ? (dv.heard_pct >= 80 ? "ok" : dv.heard_pct >= 50 ? "warn" : "bad") : "dim") +
        tile("replies · 24 h", w24.replies, w24.dm_replies + " by DM · " + w24.channel_replies + " on the channel · " + w24.chars_sent + " chars") +
        tile("not answered · 24 h", w24.dropped, "rate limits, hop gate, budgets, a nearer bot", w24.dropped ? "warn" : "") +
        tile("senders · 24 h", w24.senders, w24.senders ? "distinct nodes" : "nobody yet") +
        tile("reply time", lat.median_ms != null ? lat.median_ms + " ms" : "–", lat.p90_ms != null ? "median · p90 " + lat.p90_ms + " ms" : "receipt to send");
    },
    fmt: function (ev) {
      var arrow = ev.dir === "in" ? '<span class="in">← in </span>' : '<span class="out">→ out</span>';
      var tr = ev.transport === "channel" ? "CH" : ev.transport === "channel_data" ? "DGM" : ev.transport === "dm" ? "DM" : ev.transport === "console" ? "WEB" : (ev.kind || "").indexOf("advert") === 0 ? "ADV" : "";
      var who = ev.sender ? esc(ev.sender) : (ev.key ? '<span class="m">' + esc(ev.key) + "</span>" : "");
      var body = "", cls = "";
      var cmd = ev.command ? ' <span class="m">[' + esc(ev.command) + (ev.location ? " · " + esc(ev.location) : "") + "]</span>" : "";
      switch (ev.kind) {
        case "channel_in": case "dm_in":
          body = esc(ev.text) + cmd + (ev.hops != null ? ' <span class="m">' + ev.hops + " hops</span>" : "");
          break;
        case "reply_dm": case "reply_channel":
          cls = "ok";
          body = esc(ev.text) + ' <span class="m">' + (ev.chars || 0) + " ch" + (ev.ms != null ? " · " + ev.ms + " ms" : "") + (ev.ok === false ? " · " + esc(ev.reason || "TX off") : "") + "</span>" + deliveryBadge(ev.delivery);
          break;
        case "dropped":
          cls = "warn";
          body = '<span class="drop">not answered: ' + esc(ev.reason) + "</span>" + cmd;
          break;
        case "dm_failed": cls = "bad"; body = '<span class="err">DM failed</span> ' + esc(ev.text); break;
        case "peer": body = '<span class="m">peer bot, ignored:</span> ' + esc(ev.text); break;
        case "advert": body = '<span class="m">advert heard</span>'; break;
        case "advert_out": body = '<span class="m">our advert (flood)</span>'; break;
        case "link_test": body = '<span class="m">link test datagram (6 B)</span>' + deliveryBadge(ev.delivery); break;
        case "reply_data":
          cls = "ok";
          body = '<span class="m">app answer</span> ' + esc(ev.text || "") +
            (ev.ms != null ? ' <span class="m">· ' + ev.ms + " ms</span>" : "") +
            (ev.ok === false ? ' <span class="m">· TX off</span>' : "") + deliveryBadge(ev.delivery);
          break;
        case "data_request":
          body = '<span class="m">app data request</span> ' + esc(ev.text) +
            (ev.transport === "channel_data" ? ' <span class="m">datagram' + (ev.hops != null ? " · " + ev.hops + " hops" : "") + "</span>" : "");
          break;
        case "admin": body = '<span class="m">admin command:</span> ' + esc(ev.command); break;
        case "console": body = esc(ev.text) + ' <span class="m">[' + esc(ev.command) + (ev.location ? " · " + esc(ev.location) : "") + " · " + (ev.chars || 0) + " ch]</span>"; break;
        default: body = esc(ev.text || ev.reason || "");
      }
      return '<div data-id="' + (ev.id || "") + '"><span class="t">' + hhmmss(ev.t) + "</span> " + arrow + " " +
        '<span class="tag ' + cls + '">' + (tr || esc(ev.kind)) + "</span> " + (who ? '<span class="who">' + who + "</span> " : "") + body + "</div>";
    },
    render: function () {
      var self = this, el = $("traffic-body"), html = [];
      this._events.forEach(function (ev) { if (self._show(ev)) html.push(self.fmt(ev)); });
      el.innerHTML = html.join("") || '<div class="m">Nothing yet. A request on the channel or a DM shows up here.</div>';
      el.scrollTop = el.scrollHeight;
      this._status();
    },
  },

  // Every gate between a request and an answer: where it stands, and when it
  // opens. The bot rations itself in five places because it spends everyone's
  // airtime; until this card they were invisible, so a refused request and a
  // lost one looked the same from here. The numbers themselves are set under
  // Settings › Limits.
  limits: {
    _timer: null, _rows: [], _at: 0,

    start: function () {
      var self = this;
      this.refresh();
      if (this._timer) clearInterval(this._timer);
      this._timer = setInterval(function () { self.tick(); }, 1000);
    },
    stop: function () { if (this._timer) { clearInterval(this._timer); this._timer = null; } },

    refresh: function () {
      var self = this;
      api("/api/limits").then(function (d) {
        self._rows = d.rows || [];
        self._at = Date.now();
        self.render();
      }).catch(function () {});
    },

    // The countdowns run in the browser between polls, so the card ticks down
    // a second at a time instead of jumping every fifteen.
    tick: function () {
      var elapsed = (Date.now() - this._at) / 1000;
      var stale = false;
      this._rows.forEach(function (r) {
        if (r.opens_in_s > 0 && r.opens_in_s - elapsed <= 0) stale = true;
      });
      if (stale || elapsed > 15) { this.refresh(); return; }
      this.render(elapsed);
    },

    render: function (elapsed) {
      var body = $("limits-body");
      if (!body) return;
      elapsed = elapsed || 0;
      body.innerHTML = this._rows.map(function (r) {
        var left = Math.max(0, Math.round((r.opens_in_s || 0) - elapsed));
        var state = left > 0 ? "warn" : r.state === "spent" ? "bad" : "ok";
        var when = left > 0
          ? "in " + (left >= 60 ? Math.floor(left / 60) + "m " + ("0" + (left % 60)).slice(-2) + "s" : left + "s")
          : r.state === "spent" ? "spent" : "ready";
        var btn = r.resettable
          ? '<button class="mini" onclick="Portal.limits.reset(' + JSON.stringify(r.id).replace(/"/g, "&quot;") + ')">Reset</button>'
          : "";
        return '<div class="limit-row">' +
          '<div><span class="nm">' + esc(r.name) + '</span><div class="rule">' + esc(r.rule) + "</div></div>" +
          "<div>" + esc(r.detail) + "</div>" +
          "<div>" + pill(esc(when), state) + "</div>" +
          "<div>" + btn + "</div></div>";
      }).join("");
    },

    // Resetting spends airtime the rule was holding back, so it says so.
    reset: function (id) {
      var self = this;
      api("/api/limits/reset", { method: "POST", body: { id: id } }).then(function (d) {
        self._rows = d.rows || [];
        self._at = Date.now();
        self.render();
        Portal.ui.toast("Limit cleared: the next request is answered", true);
      }).catch(function (e) { Portal.ui.toast("Reset: " + e.message, false); });
    },
  },

  // The command tester and the line saying where the bot listens.
  textbot: {
    _loaded: false,

    enter: function () {
      if (!this._loaded) {
        this._loaded = true;
        var ex = ["wx round rock tx", "forecast austin", "warn TX", "storm TX", "space", "metar KAUS", "more", "help"];
        $("try-examples").innerHTML = ex.map(function (t) {
          return '<button onclick="Portal.textbot.send(' + JSON.stringify(t).replace(/"/g, "&quot;") + ')">' + esc(t) + "</button>";
        }).join("");
        api("/api/console/help").then(function (d) { $("help-text").textContent = d.help; }).catch(function () {});
      }
      api("/api/radio").then(function (d) {
        var cfg = d.configured_channels || {}, slots = (d.info && d.info.channels) || {};
        $("traffic-title").textContent = cfg.text || "the channel";
        var where = function (role) {
          if (!cfg[role]) return "off";
          return cfg[role] + " (" + (!d.connected ? "applied when the radio connects" : slots[role] != null ? "slot " + slots[role] : "not on the node") + ")";
        };
        var peers = d.peer_bots || [];
        $("mesh-listen").textContent = "Commands on " + where("text") + " · app data on " + where("data") + ". Peer bots heard: " +
          (peers.length ? peers.map(function (p) { return p.name + " (" + p.lat.toFixed(2) + ", " + p.lon.toFixed(2) + ")"; }).join(", ") : "none") +
          "; a request that names a place is answered only by the nearest bot. Channel names are set under Radio › Channels.";
      }).catch(function (e) { $("mesh-listen").textContent = "Radio state unavailable: " + e.message; });
    },

    send: function (preset) {
      var input = $("try-input");
      var text = (preset || input.value).trim();
      if (!text) return;
      if (!preset) input.value = "";
      var log = $("try-log"), id = "try" + Date.now();
      log.insertAdjacentHTML("beforeend", '<div><span class="in">you&gt;</span> ' + esc(text) + '</div><div id="' + id + '" class="m">…</div>');
      log.scrollTop = log.scrollHeight;
      api("/api/console", { method: "POST", body: { text: text } }).then(function (d) {
        var el = $(id);
        el.className = "";
        el.innerHTML = '<div style="margin:2px 0 8px"><span class="tag ok">DM · ' + d.chars + " ch</span> " + esc(d.reply || "(no reply)") +
          (d.has_more ? " " + pill('more pages: send "more"', "warn") : "") + "</div>" +
          '<span class="m">[' + esc(d.command) + (d.location ? " · " + esc(d.location) : "") + " · " + d.ms + " ms]</span>";
        log.scrollTop = log.scrollHeight;
      }).catch(function (e) { $(id).textContent = "error: " + e.message; });
    },
  },

  // -- Scheduled broadcasts: jobs, counters, the data channel log ------------------

  broadcasts: {
    _meta: null, _timer: null, _sse: null, _n: 0, _jobs: [], _previewN: 0, _previewTimer: null, _editing: null,
    _labels: { broadcast: "Broadcast", beacon: "Discovery beacon", app_request: "App request", app_response: "App reply",
               refresh: "App refresh", throttled: "Throttled" },

    start: function () {
      var self = this;
      if (!this._meta) api("/api/schedule/meta").then(function (d) { self._meta = d; }).catch(function () {});
      this.loadJobs(); this.loadStats();
      if (this._timer) clearInterval(this._timer);
      this._timer = setInterval(function () { self.loadJobs(); self.loadStats(); }, 30000);
      api("/api/activity?limit=150").then(function (d) {
        var el = $("bclog-body");
        var ev = d.events || [];
        self._n = ev.length;
        el.innerHTML = ev.slice().reverse().map(function (e) { return self.fmt(e); }).join("") || '<div class="m">Nothing sent on the data channel yet.</div>';
        el.scrollTop = el.scrollHeight;
        self._status();
        if (self._sse) self._sse.close();
        self._sse = liveStream("/api/activity/stream", function (e) {
          appendLine(el, self.fmt(e), 500); self._n++; self._status();
        }, "bclog-dot");
      }).catch(function (e) { $("bclog-body").textContent = "The data channel log is unavailable: " + e.message; });
    },
    stop: function () {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (this._sse) { this._sse.close(); this._sse = null; }
    },
    _status: function () { $("bclog-status").textContent = this._n + " events"; },
    fmt: function (e) {
      var dir = e.direction === "in" ? '<span class="in">← in </span>' : '<span class="out">→ out</span>';
      var label = this._labels[e.event_type] || e.event_type;
      var cls = e.event_type === "throttled" ? "warn" : e.direction === "out" ? "ok" : "";
      return '<div><span class="t">' + hhmmss(e.ts) + "</span> " + dir + ' <span class="tag ' + cls + '">' + esc(label) + "</span> " + esc(e.summary) + "</div>";
    },

    loadStats: function () {
      api("/api/stats").then(function (d) {
        var by = {}; (d.stats || []).forEach(function (s) { by[s.window_minutes] = s; });
        var h1 = by[60] || {}, d1 = by[1440] || {}, m15 = by[15] || {};
        var kb = function (b) { return b >= 1024 ? (b / 1024).toFixed(1) + " KB" : (b || 0) + " B"; };
        $("bc-tiles").innerHTML =
          tile("messages · 15 min", m15.messages || 0, kb(m15.bytes) + " on the data channel") +
          tile("messages · 1 h", h1.messages || 0, kb(h1.bytes)) +
          tile("messages · 24 h", d1.messages || 0, kb(d1.bytes));
      }).catch(function () {});
    },
    // "every 2 min", "every 6 h", "every 1 h 30 min"
    _every: function (m) {
      if (m < 60) return m + " min";
      var h = Math.floor(m / 60), r = m % 60;
      return h + " h" + (r ? " " + r + " min" : "");
    },
    _sent: function (r) {
      if (!r) return "";
      if (r.packets) return r.packets + (r.packets === 1 ? " packet, " : " packets, ") + r.bytes + " B" + (r.note ? ": " + r.note : "");
      return "nothing sent: " + (r.reason || "nothing to send");
    },

    loadJobs: function () {
      var self = this;
      api("/api/schedule/jobs").then(function (data) {
        self._jobs = data.jobs || [];
        var on = self._jobs.filter(function (j) { return j.enabled; }).length;
        var c = data.ceiling || {};
        $("jobs-sub").textContent = on + " of " + self._jobs.length + " on · about " + Math.round(data.estimated_per_hour || 0) +
          " scheduled packets an hour, of " + (c.cap || "?") + " allowed";
        $("jobs-problems").innerHTML = (data.problems || []).map(function (t) {
          return '<div class="notice warn mt">' + esc(t) + "</div>";
        }).join("");
        var tbody = $("jobs-body");
        if (!self._jobs.length) { tbody.innerHTML = '<tr><td colspan="5" class="hint">No broadcasts.</td></tr>'; return; }
        tbody.innerHTML = self._jobs.map(function (j) {
          var id = esc(j.id), r = j.last_result;
          var age = j.last_result_seconds_ago != null ? j.last_result_seconds_ago : j.last_run_seconds_ago;
          var last = age != null ? ago(age) + " ago" : "never";
          var sent = self._sent(r);
          if (j.waiting_since) sent = "waiting for room under the hourly ceiling";
          var warn = j.waiting_since || (r && !r.packets && !r.idle && j.product !== "warnings");
          var next = !j.enabled ? "off" : j.waiting_since ? "when there is room" :
            j.product === "radar" && (j.next_run_in_seconds || 0) <= 90 ? "at the next picture" :
            j.next_run_in_seconds ? "in " + ago(j.next_run_in_seconds) : "now";
          return "<tr" + (j.enabled ? "" : ' class="off"') + "><td><b>" + esc(j.name) + "</b>" +
            (j.builtin ? ' <span class="tag">built in</span>' : "") +
            '<div class="hint">' + esc(j.product_label) + " · " + esc(j.location_label) + "</div></td>" +
            '<td class="n">' + self._every(j.interval_minutes) + "</td>" +
            "<td>" + last + (sent ? '<div class="hint' + (warn ? " w" : "") + '">' + esc(sent) + "</div>" : "") + "</td>" +
            "<td>" + next + "</td>" +
            '<td class="act"><button class="mini" aria-pressed="' + (j.enabled ? "true" : "false") + '" onclick="Portal.broadcasts.toggleJob(\'' + id + '\')">' + (j.enabled ? "On" : "Off") + "</button> " +
            '<button class="mini" onclick="Portal.broadcasts.runNow(\'' + id + '\')"' + (j.enabled ? "" : " disabled") + ">" + (j.product === "warnings" ? "Check now" : "Send now") + "</button> " +
            '<button class="mini" onclick="Portal.broadcasts.openEdit(\'' + id + '\')">Edit</button>' +
            (j.builtin ? "" : ' <button class="mini danger" onclick="Portal.broadcasts.deleteJob(\'' + id + '\')">Delete</button>') + "</td></tr>";
        }).join("");
      }).catch(function (e) {
        $("jobs-body").innerHTML = '<tr><td colspan="5" class="hint">' + esc(e.message) + "</td></tr>";
      });
    },
    _job: function (id) { return (this._jobs || []).find(function (j) { return j.id === id; }); },

    _intervalOptions: function (choices, current) {
      var self = this;
      return choices.map(function (m) {
        return '<option value="' + m + '"' + (m === current ? " selected" : "") + ">every " + self._every(m) + "</option>";
      }).join("");
    },

    // What a run costs, from /api/schedule/preview.
    _previewHtml: function (d) {
      if (!d) return "";
      var out = [];
      if (d.errors && d.errors.length) return '<div class="notice bad">' + d.errors.map(esc).join("<br>") + "</div>";
      if (d.label) out.push("<b>" + esc(d.label) + "</b>");
      (d.notes || []).forEach(function (n) { out.push(esc(n)); });
      if (d.product === "radar") {
        var rd = d.radar || {};
        if (d.packets) out.push("On the " + esc(rd.taken) + " " + esc(rd.picture) + " picture: " + esc(rd.now) + ". It would send " +
          d.bytes + " B now, about " + (d.airtime_ms / 1000).toFixed(1) + " s on air before repeaters pass it on.");
        else if (d.reason) out.push("Now it would send nothing: " + esc(d.reason) + ".");
      } else if (d.active_warnings != null) {
        out.push("Sends a warning when one appears or changes, and a cancel when one ends early. " + d.active_warnings + " active in coverage now.");
      } else if (d.packets) {
        out.push("Each run: " + d.packets + (d.packets === 1 ? " packet, " : " packets, ") + d.bytes + " B, about " +
          (d.airtime_ms / 1000).toFixed(1) + " s on air before repeaters pass it on. " + d.runs_per_day + " runs a day.");
      } else if (d.reason && !(d.notes || []).length) {
        out.push("Right now it would send nothing: " + esc(d.reason) + ".");
      }
      var h = d.per_hour || {};
      var n = function (x) { return x < 10 ? x.toFixed(1) : String(Math.round(x)); };
      if (h.cap) out.push("Scheduled broadcasts: about " + n(h.others) + " packets an hour" +
        (h.this ? ", " + n(h.others + h.this) + (d.product === "radar" ? " while there is precipitation" : " with this one") : "") +
        ", of " + h.cap + " allowed.");
      return '<div class="notice info">' + out.join("<br>") + "</div>";
    },

    openAdd: function () {
      var meta = this._meta || {}, kinds = meta.kinds || {}, self = this;
      var radios = Object.keys(kinds).map(function (k, i) {
        return '<label class="choice"><input type="radio" name="jf-kind" value="' + k + '"' + (i === 0 ? " checked" : "") +
          ' onchange="Portal.broadcasts._onKind()"> <b>' + esc(kinds[k].label) + '</b><div class="hint">' + esc(kinds[k].desc) + "</div></label>";
      }).join("");
      Portal.ui.openModal(
        "<h2>Add a broadcast</h2>" +
        '<form onsubmit="Portal.broadcasts.saveAdd(event)">' +
        '<fieldset class="f"><legend>What to send</legend>' + radios + "</fieldset>" +
        '<div class="f mt" id="jf-where-row"><label for="jf-where" id="jf-where-label"></label><input type="text" id="jf-where" autocomplete="off" oninput="Portal.broadcasts._schedulePreview()"></div>' +
        this._radarFields(1, null) +
        '<div class="f mt"><label for="jf-interval">How often</label><select id="jf-interval" onchange="Portal.broadcasts._schedulePreview()"></select>' +
        '<div class="hint" id="jf-interval-hint"></div></div>' +
        '<div class="f mt"><label for="jf-name">Name</label><input type="text" id="jf-name" maxlength="120"></div>' +
        '<div id="jf-preview" class="mt" aria-live="polite"></div>' +
        '<label class="hint mt"><input type="checkbox" id="jf-enabled" checked> On</label>' +
        '<div class="row mt"><button type="submit" class="primary" id="jf-save" disabled>Add</button><button type="button" onclick="Portal.ui.closeModal()">Cancel</button></div></form>');
      this._editing = null;
      this._onKind();
      $("jf-where").focus();
    },
    // Radar's own settings: what counts as precipitation, and how far from home.
    _radarFields: function (level, km) {
      var meta = this._meta || {}, levels = meta.radar_levels || {}, r = meta.radius_km || "";
      var opts = Object.keys(levels).map(function (v) {
        return '<option value="' + v + '"' + (Number(v) === (level || 1) ? " selected" : "") + ">" + esc(levels[v]) + "</option>";
      }).join("");
      return '<div id="jf-radar" hidden><div class="f mt"><label for="jf-level">Send while there is</label>' +
        '<select id="jf-level" onchange="Portal.broadcasts._fieldsChanged()">' + opts + "</select></div>" +
        '<div class="f mt"><label for="jf-km">Within this many km of home</label>' +
        '<input type="number" id="jf-km" min="1" max="1000" step="1" value="' + esc(String(km || r)) + '" oninput="Portal.broadcasts._fieldsChanged()">' +
        '<div class="hint">The coverage radius is ' + esc(String(r)) + " km. The bot sends the narrowest radar tile that holds all of it.</div></div></div>";
    },
    _radarBody: function (body) {
      var el = $("jf-radar");
      if (el && !el.hidden) { body.min_level = parseInt($("jf-level").value, 10); body.within_km = $("jf-km").value.trim(); }
      return body;
    },
    _fieldsChanged: function () { if (this._editing) this._editPreview(this._editing); else this._schedulePreview(); },
    _kind: function () { var el = document.querySelector('input[name="jf-kind"]:checked'); return el ? el.value : ""; },
    _onKind: function () {
      var meta = this._meta || {}, k = (meta.kinds || {})[this._kind()] || {};
      $("jf-where-row").hidden = !k.field;
      $("jf-radar").hidden = k.product !== "radar";
      $("jf-where-label").textContent = k.field || "Where";
      $("jf-where").placeholder = k.placeholder || "";
      $("jf-interval").innerHTML = this._intervalOptions((meta.interval_choices || {})[k.product] || [], (meta.default_interval || {})[k.product]);
      $("jf-interval-hint").textContent = k.product === "radar" ? "A new radar picture comes every 15 minutes." : "";
      this._schedulePreview();
    },
    _schedulePreview: function () {
      var self = this;
      clearTimeout(this._previewTimer);
      $("jf-save").disabled = true;
      this._previewTimer = setTimeout(function () { self._preview(); }, 400);
    },
    _preview: function () {
      var where = $("jf-where").value.trim(), out = $("jf-preview"), self = this, n = ++this._previewN;
      if (!where && !$("jf-where-row").hidden) { out.innerHTML = ""; return; }
      var body = this._radarBody({ kind: this._kind(), interval_minutes: parseInt($("jf-interval").value, 10) });
      body[this._kind() === "station" ? "station" : "place"] = where;
      api("/api/schedule/preview", { method: "POST", body: body }).then(function (d) {
        if (n !== self._previewN) return;                 // a newer preview is on its way
        out.innerHTML = self._previewHtml(d);
        $("jf-name").placeholder = d.name || "";
        $("jf-save").disabled = !d.ok;
      }).catch(function (e) { if (n === self._previewN) out.innerHTML = '<div class="notice bad">' + esc(e.message) + "</div>"; });
    },
    saveAdd: function (ev) {
      ev.preventDefault();
      var self = this, where = $("jf-where").value.trim();
      var body = this._radarBody({ kind: this._kind(), name: $("jf-name").value.trim(), interval_minutes: parseInt($("jf-interval").value, 10),
                   enabled: $("jf-enabled").checked });
      body[this._kind() === "station" ? "station" : "place"] = where;
      api("/api/schedule/jobs", { method: "POST", body: body }).then(function (d) {
        Portal.ui.toast("Added " + d.job.name); Portal.ui.closeModal(); self.loadJobs();
      }).catch(function (e) { Portal.ui.toast(e.message, false); });
    },

    openEdit: function (id) {
      var j = this._job(id), self = this;
      if (!j) { Portal.ui.toast("That broadcast is gone", false); return; }
      Portal.ui.openModal(
        "<h2>" + esc(j.name) + "</h2>" +
        '<p class="hint">' + esc(j.product_label) + " · " + esc(j.location_label) +
        (j.builtin ? ". Built in: it can be turned off, not removed." : ". To send something else, add a new broadcast.") + "</p>" +
        '<form onsubmit="Portal.broadcasts.saveEdit(event, \'' + esc(id) + '\')">' +
        '<div class="f"><label for="jf-name">Name</label><input type="text" id="jf-name" required maxlength="120" value="' + esc(j.name) + '"></div>' +
        '<div class="f mt"><label for="jf-interval">How often</label><select id="jf-interval" onchange="Portal.broadcasts._editPreview(\'' + esc(id) + '\')">' +
        this._intervalOptions(j.interval_choices || [j.interval_minutes], j.interval_minutes) + "</select>" +
        (j.product === "warnings" ? '<div class="hint">How often the bot checks for new and changed warnings. Each goes out at the next check.</div>' : "") +
        (j.product === "radar" ? '<div class="hint">At most one picture per interval. A new radar picture comes every 15 minutes.</div>' : "") + "</div>" +
        (j.product === "radar" ? this._radarFields(j.min_level, j.within_km) : "") +
        '<div id="jf-preview" class="mt" aria-live="polite"></div>' +
        '<label class="hint mt"><input type="checkbox" id="jf-enabled"' + (j.enabled ? " checked" : "") + "> On</label>" +
        '<div class="row mt"><button type="submit" class="primary">Save</button><button type="button" onclick="Portal.ui.closeModal()">Cancel</button></div></form>');
      this._editing = id;
      if ($("jf-radar")) $("jf-radar").hidden = false;
      this._editPreview(id);
    },
    _editPreview: function (id) {
      var self = this;
      clearTimeout(this._previewTimer);
      this._previewTimer = setTimeout(function () {
        var n = ++self._previewN, j = self._job(id) || {};
        api("/api/schedule/preview", { method: "POST", body: self._radarBody({ job_id: id, interval_minutes: parseInt($("jf-interval").value, 10) }) })
          .then(function (d) {
            var el = $("jf-preview");
            if (n !== self._previewN || !el) return;
            if (j.product !== "radar") d.label = null;     // the radar label changes with its settings
            el.innerHTML = self._previewHtml(d);
          })
          .catch(function (e) { var el = $("jf-preview"); if (el && n === self._previewN) el.innerHTML = '<div class="notice bad">' + esc(e.message) + "</div>"; });
      }, 300);
    },
    _confirmWarningsOff: function () {
      return confirm("Turn off warnings? This bot stops sending alerts to MeshWX apps until you turn it back on.");
    },
    saveEdit: function (ev, id) {
      ev.preventDefault();
      var j = this._job(id) || {}, self = this, enabled = $("jf-enabled").checked;
      if (j.product === "warnings" && j.enabled && !enabled && !this._confirmWarningsOff()) return;
      api("/api/schedule/jobs/" + encodeURIComponent(id), { method: "PUT",
        body: this._radarBody({ name: $("jf-name").value.trim(), interval_minutes: parseInt($("jf-interval").value, 10), enabled: enabled }) })
        .then(function () { Portal.ui.toast("Saved"); Portal.ui.closeModal(); self.loadJobs(); Portal.poll.tick(); })
        .catch(function (e) { Portal.ui.toast(e.message, false); });
    },
    toggleJob: function (id) {
      var j = this._job(id) || {}, self = this;
      if (j.product === "warnings" && j.enabled && !this._confirmWarningsOff()) return;
      api("/api/schedule/jobs/" + encodeURIComponent(id) + "/toggle", { method: "POST" })
        .then(function () { self.loadJobs(); Portal.poll.tick(); }).catch(function (e) { Portal.ui.toast(e.message, false); });
    },
    runNow: function (id) {
      var self = this;
      api("/api/schedule/jobs/" + encodeURIComponent(id) + "/run-now", { method: "POST" })
        .then(function (d) {
          Portal.ui.toast(d.messages_sent ? "Sent " + d.messages_sent + (d.messages_sent === 1 ? " packet" : " packets") : "Nothing sent: " + (d.reason || "nothing to send"));
          setTimeout(function () { self.loadJobs(); self.loadStats(); }, 500);
        })
        .catch(function (e) { Portal.ui.toast(e.message, false); });
    },
    deleteJob: function (id) {
      var j = this._job(id) || { name: id }, self = this;
      if (!confirm("Delete “" + j.name + "”?")) return;
      api("/api/schedule/jobs/" + encodeURIComponent(id), { method: "DELETE" })
        .then(function () { Portal.ui.toast("Deleted " + j.name); self.loadJobs(); }).catch(function (e) { Portal.ui.toast(e.message, false); });
    },
  },

  // -- Radio -----------------------------------------------------------------------

  radio: {
    _state: null,
    onEnter: function () { this.load(); this.loadContacts(); this.loadHealth(); },

    // -- health and hardware --
    loadHealth: function () {
      var self = this;
      api("/api/radio/health").then(function (d) { self.renderHealth(d); })
        .catch(function (e) { $("health-reason").textContent = e.message; });
    },
    renderHealth: function (d) {
      var h = d.health || {}, fw = d.firmware || {}, dev = d.device || {}, rs = (d.radio_stats || {}).radio || null;
      var w1 = ((d.delivery || {})["1h"]) || {}, w24 = ((d.delivery || {})["24h"]) || {}, lag = d.loop_lag || null;
      var ld = d.link_drops || {};
      var labels = { ok: ["Healthy", "ok"], idle: ["Idle", ""], tx_off: ["Transmit off", ""],
                     tx_suspect: ["Transmit suspect", "bad"], rx_silent: ["Hearing nothing", "bad"], unknown: ["Unclear", "warn"] };
      var lb = labels[h.verdict] || ["?", ""];
      var badge = $("health-badge"); badge.textContent = lb[0]; badge.className = "pill " + lb[1];
      $("health-reason").textContent = h.reason || "";
      var pct = function (w) { return w.heard_pct == null ? "–" : w.heard_pct + "%"; };
      $("health-tiles").innerHTML =
        tile("heard back · 1 h", pct(w1), (w1.sent || 0) + " sent · " + (w1.resent || 0) + " resent" + (w1.carried ? " · " + w1.carried + " seen by CoreScope" : ""), w1.heard_pct == null ? "" : w1.heard_pct >= 70 ? "ok" : w1.heard_pct >= 40 ? "warn" : "bad") +
        tile("echo", w1.echo_median_ms != null ? w1.echo_median_ms + " ms" : "–", "median · 24 h: " + pct(w24) + " of " + (w24.sent || 0)) +
        tile("last heard", h.rx_age_s != null ? ago(h.rx_age_s) : "never", "any packet from anyone", h.verdict === "rx_silent" ? "bad" : "") +
        tile("unheard streak", String(h.unheard_streak || 0), "sends in a row with no echo", (h.unheard_streak || 0) >= 3 ? "bad" : "") +
        tile("noise floor", rs && rs.noise_floor != null ? rs.noise_floor + " dBm" : "–", rs ? "last RSSI " + rs.last_rssi + " · SNR " + rs.last_snr : "node counters unavailable",
          rs && rs.noise_floor != null && rs.noise_floor > -95 ? "warn" : "") +
        tile("airtime", rs ? Math.round((rs.tx_air_secs || 0) / 60) + " min TX" : "–", rs ? Math.round((rs.rx_air_secs || 0) / 60) + " min RX since boot" : "") +
        tile("loop lag", lag && lag.running ? lag.recent_worst_s + " s" : "–",
          lag && lag.running ? "worst stall in " + Math.round((lag.window_s || 300) / 60) + " min · late " + lag.pct + "% of it" : "not being measured",
          lag && lag.pct >= 2 ? "warn" : "") +
        tile("link drops · 24 h", String(ld["24h"] || 0), ld.last_at ? "last " + agoAt(ld.last_at) + " ago: " + (ld.last_reason || "") : "the radio stayed connected",
          (ld["24h"] || 0) > 1 ? "bad" : ld["24h"] ? "warn" : "");
      $("health-node").innerHTML = "Firmware " + esc(fw.ver || "?") + " " + (fw.ok ? pill("app datagrams ok", "ok") :
        pill("needs " + esc(fw.min || "1.15") + "+ for the app datagrams", "bad")) +
        (dev.model ? " · " + esc(dev.model) : "") + (dev.max_contacts ? " · " + dev.max_contacts + " contact slots" : "");
      this.renderHardware(d);
    },
    renderHardware: function (d) {
      var p = d.profile || {}, prof = p.profile, pend = p.pending, dev = d.device || {}, port = p.port || {};
      $("hw-board").innerHTML = "<b>" + esc(dev.model || "unknown board") + "</b>" + (dev.ver ? " · " + esc(dev.ver) : "") +
        (port.actual ? " · on " + esc(port.actual) : "") +
        (port.actual && port.configured && port.actual !== port.configured ? " " + pill("configured " + esc(port.configured), "warn") : "");
      $("hw-pending").hidden = !pend;
      if (pend) {
        var r = pend.radio || {}, pr = pend.profile || {};
        $("hw-pending-text").innerHTML = "This radio is <b>" + esc(r.name || "?") + "</b> (" + esc((r.public_key || "").slice(0, 8)) + "…" +
          (r.model ? ", " + esc(r.model) : "") + "), not the saved node <b>" + esc(pr.name || "?") + "</b> (" + esc((pr.public_key || "").slice(0, 8)) + "…). " +
          (pend.why_not ? "It cannot be adopted: " + esc(pend.why_not) + "." : pend.mode === "auto" ? "Automatic adoption did not take (" + (pend.attempts || 0) + " attempts)." : pend.mode === "off" ? "Adoption is switched off in Settings." : "Nothing has been written to it.") +
          " Adverts are held until you decide: adopt it to make it " + esc(pr.name || "the bot") + ", or start a new profile to keep its own identity.";
      }
      var la = p.last_adoption;
      $("hw-profile").innerHTML = !prof ? "No profile saved yet" + (p.note ? " (" + esc(p.note) + ")" : "") + "." :
        "Profile <b>" + esc(prof.name || "?") + "</b> " + esc((prof.public_key || "").slice(0, 8)) + "… · " +
        (prof.has_key ? "identity key saved" : pill("no identity key", "bad")) + " · " + (prof.contacts || 0) + " contacts · saved " + agoAt(prof.saved_at) + " ago" +
        (prof.radio ? " · " + prof.radio.freq_mhz + " MHz / " + prof.radio.bw_khz + " kHz / SF" + prof.radio.sf + " / CR" + prof.radio.cr + " / " + prof.tx_power + " dBm" : "") +
        (prof.path_hash_size ? " · " + prof.path_hash_size + "-byte path hashes" : "") +
        (p.note ? "<br>" + esc(p.note) : "") +
        (la ? "<br>Last adoption " + agoAt(la.t) + " ago: " + (la.ok ? "ok" : "failed") + (la.note ? " (" + esc(la.note) + ")" : "") + (la.steps && la.steps.length ? " · " + esc(la.steps.join("; ")) : "") : "") +
        " · adoption <b>" + esc(p.mode || "auto") + "</b>";
    },
    testTx: function (btn) {
      var out = $("health-test-result"), self = this;
      btn.disabled = true; out.textContent = "Sent one test datagram; waiting for a repeater's echo…";
      api("/api/radio/testtx", { method: "POST", body: {} }).then(function (d) {
        out.textContent = d.heard ? "Echo heard after " + d.echo_ms + " ms via " + (d.via || "?") + (d.snr != null ? " (SNR " + d.snr + ")" : "") + (d.attempts > 1 ? ", on attempt " + d.attempts : "")
          : "No echo" + (d.attempts > 1 ? " after " + d.attempts + " attempts" : "") + (d.skipped ? " (" + d.skipped + ")" : "") + ": nothing repeated this packet.";
        Portal.ui.toast(d.heard ? "Link test: echo heard" : "Link test: no echo", !!d.heard); self.loadHealth();
      }).catch(function (e) { out.textContent = e.message; Portal.ui.toast(e.message, false); }).finally(function () { btn.disabled = false; });
    },
    saveProfile: function (force) {
      if (force && !confirm("Start a new profile from this radio? The saved identity of the old node is discarded; phones will see a new bot.")) return;
      var out = $("hw-action-result"), self = this;
      api("/api/radio/profile/save", { method: "POST", body: { force: !!force } }).then(function (d) {
        out.textContent = "Profile saved: " + (d.profile.name || "?") + ", " + d.profile.contacts + " contacts" + (d.profile.has_key ? "" : " (no identity key: the firmware refused the export)");
        Portal.ui.toast("Profile saved"); self.loadHealth(); self.load();
      }).catch(function (e) { out.textContent = e.message; Portal.ui.toast(e.message, false); });
    },
    adopt: function (btn) {
      if (!confirm("Write the saved identity onto this radio and reboot it? Make sure the old radio is powered off: two nodes with one key confuse the mesh.")) return;
      var out = $("hw-action-result"), self = this;
      btn.disabled = true; out.textContent = "Writing the profile, rebooting the node, reconnecting… about 20 seconds.";
      api("/api/radio/profile/adopt", { method: "POST", body: {} }).then(function (d) {
        var la = (d.profile || {}).last_adoption || {};
        out.textContent = (la.ok ? "Adopted: " : "Adoption did not take: ") + (la.note || (d.steps || []).join("; ")) + (d.connected ? "" : " · radio not reconnected: " + (d.error || ""));
        Portal.ui.toast(la.ok ? "Radio adopted" : "Adoption failed", !!la.ok); self.load(); self.loadHealth(); self.loadContacts(); Portal.poll.tick();
      }).catch(function (e) { out.textContent = e.message; Portal.ui.toast(e.message, false); }).finally(function () { btn.disabled = false; });
    },

    load: function () {
      var self = this;
      api("/api/radio").then(function (d) { self._state = d; self.render(d); })
        .catch(function (e) { Portal.ui.toast("Radio: " + e.message, false); });
    },

    render: function (d) {
      var info = d.info || {}, conn = d.connected, dev = d.device || {};
      $("radio-offline-card").hidden = !!conn;
      $("radio-offline-reason").textContent = conn ? "" : (d.error || "") + " (" + d.serial_port + " @ " + d.serial_baud + ")";
      $("radio-stats").innerHTML =
        tile("link", conn ? "up" : "down", d.serial_port, conn ? "ok" : "bad") +
        tile("MHz", info.radio_freq != null ? info.radio_freq : "–",
          info.radio_bw != null ? "BW " + info.radio_bw + " kHz · SF" + info.radio_sf + " · CR" + info.radio_cr : "") +
        tile("dBm TX power", info.tx_power != null ? info.tx_power : "–", info.max_tx_power != null ? "at most " + info.max_tx_power : "") +
        tile("battery", info.battery_mv ? (info.battery_mv / 1000).toFixed(2) + " V" : "–", (dev.model ? dev.model + " · " : "") + (dev.ver || ""));

      setVal("radio-name", info.name); setVal("radio-lat", info.adv_lat); setVal("radio-lon", info.adv_lon);
      setVal("radio-freq", info.radio_freq); setVal("radio-bw", info.radio_bw); setVal("radio-sf", info.radio_sf); setVal("radio-cr", info.radio_cr);
      setVal("radio-txpower", info.tx_power);
      var ph = $("radio-pathhash"), phKnown = info.path_hash_size != null;
      if (document.activeElement !== ph) ph.value = phKnown ? String(info.path_hash_size) : "1";
      ph.disabled = $("radio-pathhash-set").disabled = !conn || !phKnown;
      if (conn && !phKnown) $("radio-pathhash-hint").textContent = "This node's firmware does not report a path hash size, so it uses 1 byte and has nothing to set.";
      $("radio-pubkey").textContent = info.public_key ? "public key " + info.public_key : "";
      var badge = $("radio-tx-badge");
      badge.textContent = d.tx_enabled ? "Transmit on" : "Receive only";
      badge.className = "pill " + (d.tx_enabled ? "ok" : "warn");
      $("radio-tx-toggle").textContent = d.tx_enabled ? "Turn transmit off" : "Turn transmit on";

      var sel = $("radio-preset"), presets = d.presets || {}, match = "";
      Object.keys(presets).forEach(function (k) {
        var p = presets[k];
        if (Math.abs((info.radio_freq || 0) - p.freq_mhz) < 0.001 && Math.abs((info.radio_bw || 0) - p.bw_khz) < 0.1 && info.radio_sf === p.sf && info.radio_cr === p.cr) match = k;
      });
      if (document.activeElement !== sel) {
        sel.innerHTML = '<option value="">custom</option>' + Object.keys(presets).map(function (k) {
          var p = presets[k];
          return '<option value="' + k + '">' + esc(p.label) + " · " + p.freq_mhz + " MHz / " + p.bw_khz + " kHz / SF" + p.sf + " / CR" + p.cr + "</option>";
        }).join("");
        sel.value = match;
      }

      var cfg = d.configured_channels || {};
      setVal("ch-text", cfg.text); setVal("ch-data", cfg.data);
      var slots = (info.channels) || {};
      $("ch-status").textContent = conn ? ["text", "data"].map(function (r) {
        return r + ": " + (slots[r] != null ? "slot " + slots[r] : (cfg[r] ? "not on the node" : "off"));
      }).join(" · ") : "Radio not connected: names apply when it connects";

      var tb = $("radio-channels");
      if (!conn) { tb.innerHTML = '<tr><td colspan="5" class="hint">Radio not connected</td></tr>'; }
      else {
        var rows = [];
        for (var i = 0; i < 8; i++) {
          var ch = (d.channels || []).filter(function (c) { return c.idx === i; })[0] || { idx: i, name: "", role: null };
          var roles = ch.roles || (ch.role ? [ch.role] : []);
          var roleBadge = roles.map(function (r) { return pill(esc(r), "ok"); }).join(" ");
          if (!ch.role && ch.name && [cfg.text, cfg.data].indexOf(ch.name) !== -1) roleBadge = pill("configured, not resolved", "warn");
          rows.push("<tr><td>" + i + (i === 0 ? ' <span class="hint">public</span>' : "") + "</td>" +
            "<td>" + (i === 0 ? esc(ch.name || "Public") : '<input style="max-width:260px" id="radio-ch-' + i + '" value="' + esc(ch.name || "") + '" placeholder="(empty slot)" aria-label="Slot ' + i + ' name">') + "</td>" +
            "<td>" + roleBadge + "</td>" +
            '<td class="mono hint">' + (ch.secret ? ch.secret.slice(0, 8) + "…" : "") + "</td>" +
            '<td class="act">' + (i === 0 ? "" : '<button class="mini" onclick="Portal.radio.saveSlot(' + i + ')">Save</button> ' +
              (ch.name && !ch.role ? '<button class="mini danger" onclick="Portal.radio.clearSlot(' + i + ')">Clear</button>' : "")) + "</td></tr>");
        }
        tb.innerHTML = rows.join("");
      }
      this.renderHousekeeping(d.housekeeping);
    },

    renderHousekeeping: function (h) {
      if (!h) return;
      var cb = $("env-MCW_CONTACT_HOUSEKEEPING");
      if (document.activeElement !== cb) cb.checked = !!h.enabled;
      setVal("env-MCW_CONTACT_KEEP_FREE", h.keep_free);
      $("contacts-help").textContent = "The node holds " + h.slots + " contacts and can only DM someone it has stored. With housekeeping on, it stores companions only: " +
        "repeaters, rooms and sensors are removed after every refresh, and when people alone come within " + h.keep_free + " of the limit the ones heard longest ago go. The admin and other WX- bots are never removed.";
      $("contacts-sub").textContent = h.last && h.last.t ? "housekeeping " + agoAt(h.last.t) + " ago: " + h.last.note :
        (h.enabled ? "housekeeping on, not run yet" : "housekeeping off: the firmware keeps whatever it hears");
    },

    _act: function (promise, okMsg) {
      var self = this, out = $("radio-action-result");
      return promise.then(function (d) {
        Portal.ui.toast(okMsg || "Done");
        out.textContent = (d && d.note) || "";
        self.load(); Portal.poll.tick();
      }).catch(function (e) { Portal.ui.toast(e.message, false); out.textContent = e.message; });
    },
    saveName: function () { this._act(api("/api/radio/name", { method: "POST", body: { name: $("radio-name").value } }), "Name saved"); },
    saveCoords: function () {
      this._act(api("/api/radio/coords", { method: "POST", body: { lat: parseFloat($("radio-lat").value), lon: parseFloat($("radio-lon").value) } }), "Location saved");
    },
    pickPreset: function () {
      var p = ((this._state || {}).presets || {})[$("radio-preset").value];
      if (!p) return;
      $("radio-freq").value = p.freq_mhz; $("radio-bw").value = p.bw_khz; $("radio-sf").value = p.sf; $("radio-cr").value = p.cr;
    },
    saveParams: function () {
      var body = { freq_mhz: parseFloat($("radio-freq").value), bw_khz: parseFloat($("radio-bw").value), sf: parseInt($("radio-sf").value, 10), cr: parseInt($("radio-cr").value, 10) };
      if (!confirm("Set the radio to " + body.freq_mhz + " MHz / " + body.bw_khz + " kHz / SF" + body.sf + " / CR" + body.cr + "? Every node on the mesh must use the same values.")) return;
      this._act(api("/api/radio/params", { method: "POST", body: body }), "Radio parameters applied");
    },
    savePathHash: function () {
      this._act(api("/api/radio/pathhash", { method: "POST", body: { bytes: parseInt($("radio-pathhash").value, 10) } }), "Path hash size set");
    },
    saveTxPower: function () { this._act(api("/api/radio/txpower", { method: "POST", body: { dbm: parseInt($("radio-txpower").value, 10) } }), "TX power set"); },
    toggleTx: function () {
      var on = !(this._state && this._state.tx_enabled);
      if (on && !confirm("Turn transmit on? The bot sends an advert now, then replies and scheduled broadcasts.")) return;
      if (!on && !confirm("Turn transmit off? The bot stops replying and broadcasting until it is turned back on.")) return;
      this._act(api("/api/radio/tx", { method: "POST", body: { enabled: on } }), on ? "Transmit on" : "Transmit off");
    },
    advert: function () { this._act(api("/api/radio/advert", { method: "POST", body: {} }), "Advert requested"); },
    reboot: function () { if (confirm("Reboot the radio node? The bot reconnects on its own.")) this._act(api("/api/radio/reboot", { method: "POST", body: {} }), "Rebooting"); },
    reconnect: function (btn) {
      btn.disabled = true;
      var self = this;
      api("/api/radio/reconnect", { method: "POST", body: {} }).then(function (d) {
        Portal.ui.toast(d.connected ? "Radio connected" : "Still not connected: " + (d.error || ""), d.connected); self.load(); Portal.poll.tick();
      }).catch(function (e) { Portal.ui.toast(e.message, false); }).finally(function () { btn.disabled = false; });
    },
    saveRoles: function (btn) {
      var st = $("ch-status"), self = this;
      btn.disabled = true; st.textContent = "Saving…";
      api("/api/settings/channels", { method: "POST", body: { text_channel: $("ch-text").value.trim(), data_channel: $("ch-data").value.trim() } })
        .then(function (d) { Portal.ui.toast(d.note || "Saved"); self.load(); })
        .catch(function (e) { st.textContent = e.message; Portal.ui.toast(e.message, false); })
        .finally(function () { btn.disabled = false; });
    },
    saveSlot: function (i) {
      var name = $("radio-ch-" + i).value.trim();
      if (!name) return this.clearSlot(i);
      this._act(api("/api/radio/channel", { method: "POST", body: { idx: i, name: name } }), "Slot " + i + " saved");
    },
    clearSlot: function (i) { if (confirm("Clear channel slot " + i + "?")) this._act(api("/api/radio/channel/" + i, { method: "DELETE" }), "Slot " + i + " cleared"); },
    saveHousekeeping: function () {
      var on = $("env-MCW_CONTACT_HOUSEKEEPING").checked, keep = $("env-MCW_CONTACT_KEEP_FREE").value.trim();
      var body = { MCW_CONTACT_HOUSEKEEPING: on ? "true" : "false" };
      if (keep !== "") body.MCW_CONTACT_KEEP_FREE = keep;
      this._act(api("/api/settings/env", { method: "POST", body: body }), on ? "Housekeeping on" : "Housekeeping off");
    },
    housekeepNow: function () {
      var self = this;
      api("/api/radio/housekeep", { method: "POST", body: {} }).then(function (d) { Portal.ui.toast(d.note); self.load(); self.loadContacts(); })
        .catch(function (e) { Portal.ui.toast(e.message, false); });
    },
    loadContacts: function () {
      api("/api/radio/contacts").then(function (d) {
        var tb = $("radio-contacts");
        if (!d.contacts.length) { tb.innerHTML = '<tr><td colspan="5" class="hint">No contacts</td></tr>'; return; }
        tb.innerHTML = d.contacts.map(function (c) {
          return "<tr><td>" + esc(c.name || "?") + "</td><td>" + ({ 1: "companion", 2: "repeater", 3: "room", 4: "sensor" }[c.type] || c.type || "") + "</td>" +
            "<td>" + (c.heard ? agoAt(c.heard) + " ago" : "–") + "</td>" +
            "<td>" + (c.out_path_len != null && c.out_path_len >= 0 ? c.out_path_len + " hops" : "flood") + "</td>" +
            '<td class="mono hint">' + (c.public_key || "").slice(0, 12) + "</td></tr>";
        }).join("");
      }).catch(function (e) { $("radio-contacts").innerHTML = '<tr><td colspan="5" class="hint">' + esc(e.message) + "</td></tr>"; });
    },
  },

  // -- Station: the receiver, the pointing meter, the feed and the fill -------------

  station: {
    _timer: null, _mtimer: null, _sse: null, _mode: null, _gains: null, _yMin: null, _yMax: null,
    _hovers: null, _hist: null, _snr: null, _spec: null, _trend: null, _trendH: 72,
    onEnter: function () {
      var s = this;
      this._hoverSetup();
      this.loadNotes();
      this.loadTrend();
      this.load();
      // The receiver as the dashboard streams it, twice a second, as on
      // goes.digitaino.com; the feed and the fill move by the minute.
      if (this._sse) this._sse.close();
      this._sse = liveStream("/api/sdr/events", function (r) { s.renderRx(r); }, "rx-dot");
      if (this._timer) clearInterval(this._timer);
      this._timer = setInterval(function () { s.load(); s.loadTrend(); }, 30000);
    },
    onLeave: function () {
      if (this._timer) clearInterval(this._timer); this._timer = null;
      if (this._sse) { this._sse.close(); this._sse = null; }
      this._stopMeter();
    },

    load: function () {
      var self = this;
      api("/api/sdr").then(function (d) {
        self.renderRx(d.receiver || {});
        self.renderFeed(d.feed || {});
      }).catch(function (e) { Portal.ui.toast("Station: " + e.message, false); });
    },

    // One state of the receiver: the whole of it from /api/sdr, or a frame of
    // the stream, where only every tenth carries the services and the chart.
    renderRx: function (r) {
      var self = this, st = r.stats || {}, err = r._error;
      self._showMode(err ? null : r.mode);
      var pillEl = $("rx-pill");
      pillEl.className = "pill " + (err ? "bad" : r.mode === "point" ? "info" : st.locked ? "ok" : "warn");
      pillEl.textContent = err ? "Unreachable" : r.mode === "point" ? "Being aimed" : st.locked ? "Locked" : "No lock";
      $("sat-signal-sub").textContent = err ? "The goestools dashboard does not answer: " + err :
        r.mode === "point" ? (r.mode_msg || "Pointing mode") :
        "Locked for " + (st.lock_since ? agoAt(st.lock_since) : "–") + " · tuner gain " + (st.gain != null ? st.gain.toFixed(1) : "?") + " dB · carrier offset " + (st.freq != null ? Math.round(st.freq) + " Hz" : "?");
      if (!err && r.mode !== "point") {
        var tot = st.totals || {};
        $("sat-stats").innerHTML =
          tile("Viterbi errors", st.vit_avg != null ? st.vit_avg : "–", "per frame, under 200 is good", st.vit_avg == null ? "" : st.vit_avg < 200 ? "ok" : st.vit_avg < 600 ? "warn" : "bad") +
          tile("dropped", st.drops != null ? st.drops : "–", "packets, last interval", st.drops ? "warn" : "ok") +
          tile("packets", tot.packets != null ? tot.packets.toLocaleString() : "–", "since goesrecv started") +
          tile("dropped in all", tot.drops != null ? tot.drops.toLocaleString() : "–", tot.packets ? (tot.drops * 100 / tot.packets).toFixed(2) + "% of them" : "") +
          tile("Reed-Solomon fixes", tot.rs_errors != null ? tot.rs_errors.toLocaleString() : "–", "bytes corrected");
        self.drawHistory(r.history);
      }
      if (!r.status && !err) return;
      var svc = (r.status || {}).services || {}, stt = r.status || {};
      $("sat-services").innerHTML = "<span>goesrecv <b>" + esc(svc.goesrecv || "?") + "</b>" + (stt.goesrecv_up_s ? " · up " + ago(stt.goesrecv_up_s) : "") + "</span>" +
        "<span>goesproc <b>" + esc(svc.goesproc || "?") + "</b>" + (stt.counts ? " · " + (stt.counts.emwin_today || 0) + " EMWIN files today" : "") + "</span>";
    },

    _showMode: function (mode) {
      var point = mode === "point";
      $("rx-receive").hidden = point;
      $("rx-point").hidden = !point;
      $("sat-mode-point").hidden = point || mode == null;
      $("sat-mode-receive").hidden = !point;
      if (point && !this._mtimer) this._startMeter();
      if (!point) this._stopMeter();
      this._mode = mode;
    },

    // -- signal and EMWIN delay, from the dashboard's 7-day history (/api/sdr/trend) --
    loadTrend: function () {
      var self = this;
      api("/api/sdr/trend?hours=" + this._trendH).then(function (d) {
        $("trend-msg").hidden = true;
        self._trend = d;
        self.drawTrend();
      }).catch(function (e) { $("trend-msg").textContent = e.message; $("trend-msg").hidden = false; });
    },
    trendRange: function (h) {
      this._trendH = h;
      pressChip("trend-range", "h", String(h));
      this.loadTrend();
    },
    drawTrend: function () {
      var d = this._trend;
      if (!d) return;
      var t1 = d.now, t0 = t1 - d.hours * 3600;
      this._drawLag(d.hourly.filter(function (r) { return r[0] + 3600 > t0; }), t0, t1, d.emwin_since);
      this._drawVit(d.signal.filter(function (r) { return r[0] >= t0; }), t0, t1, d.bucket_s || 60, d.signal_since);
      if (this._hovers) { this._hovers.lag(); this._hovers.vit(); }
    },
    _unrecorded: function (x, W, H, t0, t1, since) {
      if (since == null || since <= t0) return;
      var w = (since - t0) / (t1 - t0) * W, dpr = window.devicePixelRatio || 1;
      x.fillStyle = css("--dim"); x.globalAlpha = 0.12;
      x.fillRect(0, 0, w, H);
      x.globalAlpha = 1;
      if (w > 90 * dpr) x.fillText("not recorded", 6 * dpr, H / 2);
    },
    // Products per hour as bars (dish, the internet on top), the delay as a line over them.
    _drawLag: function (rows, t0, t1, since) {
      var c = canvas("trend-lag", 180), x = c[0], W = c[1], H = c[2], dpr = c[3];
      var px = function (t) { return (t - t0) / (t1 - t0) * W; }, base = H - 16 * dpr, top = 8 * dpr;
      var pmax = Math.max(1, Math.max.apply(null, rows.map(function (r) { return r[1] + r[2]; })));
      var lmax = Math.max(60, Math.max.apply(null, rows.map(function (r) { return r[3] || 0; }))) * 1.1;
      var py = function (m) { return base - Math.min(m, lmax) / lmax * (base - top); };
      this._unrecorded(x, W, H, t0, t1, since);
      timeTicks(x, W, H, dpr, t0, t1);
      var bw = Math.max(dpr, px(3600) - px(0) - dpr);
      rows.forEach(function (r) {
        var h1 = r[1] / pmax * (base - top) * 0.6, h2 = r[2] / pmax * (base - top) * 0.6;
        x.globalAlpha = 0.45;
        x.fillStyle = css("--series2"); x.fillRect(px(r[0]), base - h1, bw, h1);
        if (r[2]) { x.fillStyle = css("--warn"); x.fillRect(px(r[0]), base - h1 - h2, bw, h2); }
      });
      x.globalAlpha = 1;
      x.strokeStyle = css("--line"); x.fillStyle = css("--dim"); x.setLineDash([4 * dpr, 4 * dpr]);
      var lastY = null;
      [[720, "12 h"], [360, "6 h"], [180, "3 h"], [60, "1 h"], [30, "30 min"]].forEach(function (g) {
        if (g[0] > lmax || (lastY != null && py(g[0]) - lastY < 14 * dpr)) return;     // no labels on top of each other
        lastY = py(g[0]);
        x.beginPath(); x.moveTo(0, lastY); x.lineTo(W, lastY); x.stroke(); x.fillText(g[1], 4 * dpr, lastY - 3 * dpr);
      });
      x.setLineDash([]);
      x.strokeStyle = css("--alert"); x.lineWidth = 2 * dpr; x.beginPath();
      var pen = false;
      rows.forEach(function (r) {
        if (r[3] == null) { pen = false; return; }
        var X = px(r[0] + 1800), Y = py(r[3]);
        if (pen) x.lineTo(X, Y); else x.moveTo(X, Y);
        pen = true;
      });
      x.stroke();
      this._lagRows = rows;
    },
    // Viterbi errors per frame: the median line, the 10th-90th percentile band, no lock shaded.
    _drawVit: function (rows, t0, t1, bucket, since) {
      var c = canvas("trend-vit", 180), x = c[0], W = c[1], H = c[2], dpr = c[3];
      var px = function (t) { return (t - t0) / (t1 - t0) * W; }, base = H - 16 * dpr, top = 8 * dpr;
      var vmax = Math.min(1000, Math.max(400, Math.max.apply(null, rows.map(function (r) { return r[1] || 0; })) * 1.2));
      var py = function (v) { return base - Math.min(v, vmax) / vmax * (base - top); };
      this._unrecorded(x, W, H, t0, t1, since);
      x.fillStyle = css("--bad"); x.globalAlpha = 0.25;
      rows.forEach(function (r) { if (r[6] === 0) x.fillRect(px(r[0]), 0, Math.max(dpr, px(r[0] + bucket) - px(r[0])), base); });
      x.globalAlpha = 1;
      timeTicks(x, W, H, dpr, t0, t1);
      x.strokeStyle = css("--line"); x.fillStyle = css("--dim"); x.setLineDash([4 * dpr, 4 * dpr]);
      [[200, "200 good"], [600, "600 fair"]].forEach(function (g) {
        if (g[0] > vmax) return;
        x.beginPath(); x.moveTo(0, py(g[0])); x.lineTo(W, py(g[0])); x.stroke(); x.fillText(g[1], 4 * dpr, py(g[0]) - 3 * dpr);
      });
      x.setLineDash([]);
      var segs = [], cur = [];          // a gap of over 2.5 buckets breaks the line
      rows.forEach(function (r) {
        if (r[1] == null || (cur.length && r[0] - cur[cur.length - 1][0] > bucket * 2.5)) { if (cur.length) segs.push(cur); cur = []; }
        if (r[1] != null) cur.push(r);
      });
      if (cur.length) segs.push(cur);
      x.fillStyle = css("--series"); x.globalAlpha = 0.2;
      segs.forEach(function (g) {
        x.beginPath();
        g.forEach(function (r, i) { var Y = py(r[3] != null ? r[3] : r[1]); if (i) x.lineTo(px(r[0]), Y); else x.moveTo(px(r[0]), Y); });
        g.slice().reverse().forEach(function (r) { x.lineTo(px(r[0]), py(r[2] != null ? r[2] : r[1])); });
        x.fill();
      });
      x.globalAlpha = 1; x.strokeStyle = css("--alert"); x.lineWidth = 1.5 * dpr;
      segs.forEach(function (g) {
        x.beginPath();
        g.forEach(function (r, i) { if (i) x.lineTo(px(r[0]), py(r[1])); else x.moveTo(px(r[0]), py(r[1])); });
        x.stroke();
      });
      this._vitRows = rows; this._bucket = bucket;
    },
    _lagAt: function (f) {
      var d = this._trend, rows = this._lagRows;
      if (!d || !rows || !rows.length) return null;
      var t1 = d.now, t0 = t1 - d.hours * 3600, t = t0 + f * (t1 - t0), r = null;
      rows.forEach(function (q) { if (q[0] <= t && t < q[0] + 3600) r = q; });
      if (!r) return null;
      var span = function (m) { m = Math.round(m); return m < 1 ? "on time" : m < 120 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min"; };
      var at = function (t) { return new Date(t * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }); };
      return { x: (r[0] + 1800 - t0) / (t1 - t0), html: "<b>" + at(r[0]) + " – " + new Date((r[0] + 3600) * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + "</b>" +
        tipRows([["delay behind NOAA", r[3] == null ? "–" : span(r[3])], ["from the dish", r[1].toLocaleString()],
                 ["from the internet", r[2].toLocaleString()], ["in all", (r[1] + r[2]).toLocaleString()]]) };
    },
    _vitAt: function (f) {
      var d = this._trend, rows = this._vitRows, b = this._bucket || 60;
      if (!d || !rows || !rows.length) return null;
      var t1 = d.now, t0 = t1 - d.hours * 3600, t = t0 + f * (t1 - t0);
      var r = rows.reduce(function (a, q) { return Math.abs(q[0] + b / 2 - t) < Math.abs(a[0] + b / 2 - t) ? q : a; });
      if (Math.abs(r[0] + b / 2 - t) > b * 2) return null;          // a gap in the history
      var word = function (v) { return v < 200 ? "good" : v < 600 ? "fair" : "poor"; };
      var at = function (t) { return new Date(t * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }); };
      var drops = r[4] ? " (" + (r[5] * 100 / (r[4] + r[5])).toFixed(1) + "%)" : "";
      return { x: (r[0] + b / 2 - t0) / (t1 - t0), html: "<b>" + at(r[0]) + "</b> · " + Math.round(b / 60) + " min" +
        tipRows([["Viterbi errors", r[1] == null ? "–" : Math.round(r[1]) + " (" + word(r[1]) + ")"],
                 ["10th–90th percentile", r[2] == null ? "–" : Math.round(r[2]) + "–" + Math.round(r[3])],
                 ["packets", (r[4] || 0).toLocaleString()], ["dropped", (r[5] || 0).toLocaleString() + drops],
                 ["locked", r[6] == null ? "–" : Math.round(r[6] * 100) + "% of the time"]]) };
    },

    // -- notes on the public page (kept by the dashboard; see /api/public-notes) --
    loadNotes: function () {
      var self = this;
      api("/api/public-notes").then(function (d) { self.renderNotes(d); }).catch(function (e) {
        $("notes-pill").className = "pill bad"; $("notes-pill").textContent = "Unreachable";
        $("notes-list").innerHTML = '<tr><td class="hint">' + esc(e.message) + "</td></tr>";
      });
    },
    renderNotes: function (d) {
      var up = d.up || [], ids = {};
      up.forEach(function (n) { ids[n.id] = true; });
      if (d.page) $("notes-page").href = d.page;
      $("notes-pill").className = "pill " + (up.length ? "info" : "");
      $("notes-pill").textContent = up.length ? up.length + " up" : "None up";
      var kind = { info: ["info", "Information"], warn: ["warn", "Warning"], bad: ["bad", "Problem"] };
      var at = function (t) { return new Date(t * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }); };
      $("notes-list").innerHTML = (d.recent || []).map(function (n) {
        var k = kind[n.level] || ["", n.level], isUp = ids[n.id];
        var span = "posted " + at(n.t) + " · " + (isUp ? (n.t_end ? "up until " + at(n.t_end) : "up until taken down") : "ended " + at(n.t_end));
        return "<tr><td>" + pill(isUp ? "up" : "ended", isUp ? k[0] : "") + "</td><td><b>" + esc(n.title) + "</b>" +
          (n.detail ? '<div class="hint">' + esc(n.detail) + "</div>" : "") + '<div class="hint">' + esc(k[1] + " · " + span) + "</div></td>" +
          '<td class="act">' + (isUp ? '<button onclick="Portal.station.noteAction(' + n.id + ', \'end\')">Take down</button> ' : "") +
          '<button class="danger" onclick="Portal.station.noteAction(' + n.id + ', \'delete\')">Delete</button></td></tr>';
      }).join("") || '<tr><td class="hint">No notes in the last two weeks.</td></tr>';
    },
    postNote: function () {
      var self = this, title = $("note-title").value.trim(), hours = $("note-hours").value;
      if (!title) { Portal.ui.toast("A note needs a headline", false); $("note-title").focus(); return; }
      $("note-post").disabled = true;
      api("/api/public-notes", { method: "POST", body: { title: title, detail: $("note-detail").value.trim(),
                                                        level: $("note-level").value, hours: hours ? parseFloat(hours) : null } })
        .then(function () {
          Portal.ui.toast("Posted to the public page");
          $("note-title").value = ""; $("note-detail").value = "";
          self.loadNotes();
        })
        .catch(function (e) { Portal.ui.toast("Note: " + e.message, false); })
        .then(function () { $("note-post").disabled = false; });
    },
    noteAction: function (id, action) {
      var self = this;
      if (action === "delete" && !confirm("Delete this note? It goes from the public page and its events list.")) return;
      api("/api/public-notes/" + id + "/" + action, { method: "POST", body: {} })
        .then(function () { Portal.ui.toast(action === "end" ? "Taken down" : "Deleted"); self.loadNotes(); })
        .catch(function (e) { Portal.ui.toast("Note: " + e.message, false); });
    },

    // Hover on the three graphs: the second (or the frequency) under the pointer, in figures.
    _hoverSetup: function () {
      if (this._hovers) return;
      var s = this;
      this._hovers = {
        hist: chartHover("sat-chart", function (f) { return s._histAt(f); }),
        snr: chartHover("m-snrh", function (f) { return s._snrAt(f); }),
        spec: chartHover("m-spec", function (f) { return s._specAt(f); }),
        lag: chartHover("trend-lag", function (f) { return s._lagAt(f); }),
        vit: chartHover("trend-vit", function (f) { return s._vitAt(f); }),
      };
    },
    _histAt: function (f) {
      var h = this._hist;
      if (!h || !h.length) return null;
      var i = Math.min(h.length - 1, Math.floor(f * h.length)), r = h[i];
      // The minute up to it as well: one second's figures jump about.
      var vits = [], pk = 0, dr = 0;
      h.forEach(function (q) {
        if (q[0] > r[0] - 60 && q[0] <= r[0]) { if (q[1] != null) vits.push(q[1]); pk += q[2] || 0; dr += q[3] || 0; }
      });
      var avg = vits.length ? Math.round(vits.reduce(function (a, b) { return a + b; }, 0) / vits.length) : null;
      var word = function (v) { return v == null ? "–" : v + (v < 200 ? " (good)" : v < 600 ? " (fair)" : " (poor)"); };
      return { x: (i + 0.5) / h.length, html: "<b>" + hhmmss(r[0]) + "</b> · " + agoAt(r[0]) + " ago" +
        tipRows([["Viterbi errors", word(r[1])], ["packets", r[2] != null ? r[2] : "–"], ["dropped", r[3] != null ? r[3] : "–"],
                 ["Reed-Solomon fixes", r[4] != null ? r[4] + " bytes" : "–"]]) +
        '<div class="sub">the minute up to then</div>' +
        tipRows([["Viterbi errors", avg == null ? "–" : "avg " + word(avg)], ["packets", pk.toLocaleString()],
                 ["dropped", dr + (pk ? " (" + (dr * 100 / pk).toFixed(1) + "%)" : "")]]) };
    },
    _snrAt: function (f) {
      var d = this._snr;
      if (!d || !d.h.length) return null;
      var t = d.t0 + f * (d.t1 - d.t0), r = d.h.reduce(function (a, b) { return Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a; });
      var s = r[1];
      return { x: (r[0] - d.t0) / ((d.t1 - d.t0) || 1), html: "<b>" + hhmmss(r[0]) + "</b> · " + agoAt(r[0]) + " ago" +
        tipRows([["signal", s == null ? "–" : s.toFixed(1) + " dB"],
                 ["", s == null ? "" : s < 2 ? "no signal" : s < 5 ? "signal found, fine-tune" : s < 9 ? "good, will decode" : "excellent"]]) };
    },
    _specAt: function (f) {
      var d = this._spec;
      if (!d) return null;
      var fq = d.f0 + f * (d.f1 - d.f0), i = 0;
      d.freqs.forEach(function (v, j) { if (Math.abs(v - fq) < Math.abs(d.freqs[i] - fq)) i = j; });
      var at = d.freqs[i], inside = function (r) { return r && at >= r[0] && at <= r[1]; };
      return { x: (at - d.f0) / ((d.f1 - d.f0) || 1), html: "<b>" + (at / 1e6).toFixed(3) + " MHz</b>" +
        tipRows([["level", d.db[i] != null ? d.db[i].toFixed(1) + " dB" : "–"],
                 ["", inside(d.inband) ? "the downlink" : (d.oob || []).some(inside) ? "noise reference" : ""]]) };
    },

    // Viterbi errors (line) and dropped packets (bars) over the last 15 minutes,
    // from the receiver's own history: [t, vit, packets, drops, rs].
    drawHistory: function (h) {
      if (!Array.isArray(h) || !h.length) return;
      h = this._hist = h.slice(-900);
      var c = canvas("sat-chart", 160), x = c[0], W = c[1], H = c[2], dpr = c[3];
      var vit = h.map(function (r) { return r[1]; }), drops = h.map(function (r) { return r[3]; });
      var vmax = Math.max(400, Math.max.apply(null, vit)), dmax = Math.max(5, Math.max.apply(null, drops));
      var n = h.length, dx = W / n;
      x.strokeStyle = css("--line"); x.fillStyle = css("--dim"); x.setLineDash([4 * dpr, 4 * dpr]);
      [200, 600].forEach(function (v) { if (v > vmax) return; var y = H - 6 * dpr - v / vmax * (H - 18 * dpr); x.beginPath(); x.moveTo(0, y); x.lineTo(W, y); x.stroke(); x.fillText(String(v), W - 30 * dpr, y - 3 * dpr); });
      x.setLineDash([]);
      x.fillStyle = css("--warn"); x.globalAlpha = 0.7;
      drops.forEach(function (v, i) { if (v > 0) { var bh = v / dmax * (H * 0.35); x.fillRect(i * dx, H - bh, Math.max(dpr, dx), bh); } });
      x.globalAlpha = 1; x.strokeStyle = css("--alert"); x.lineWidth = 1.5 * dpr; x.beginPath();
      vit.forEach(function (v, i) { var y = H - 6 * dpr - (v / vmax) * (H - 18 * dpr); if (i === 0) x.moveTo(0, y); else x.lineTo(i * dx, y); });
      x.stroke();
      if (this._hovers) this._hovers.hist();
    },

    renderFeed: function (feed) {
      var f = feed.fill || null, h = (f && f.last_hour) || {};
      var p = $("fill-pill");
      if (!f) { p.className = "pill"; p.textContent = "No fill on this feed"; }
      else if (!f.enabled) { p.className = "pill"; p.textContent = "Fill off"; }
      else if (f.active) { p.className = "pill warn"; p.textContent = "Filling in since " + agoAt(f.since) + " ago"; }
      else { p.className = "pill ok"; p.textContent = "Standing by"; }
      if (f && f.grace_min) {
        var g = f.grace_min;
        $("fill-why").textContent = "The feed comes first. A product it has not delivered within " + g.warnings + " min of issue (warnings) or " + g.other +
          " min (everything else; radar " + g.radar + " min) is taken from NWS: text from api.weather.gov, airport reports from NWS's METAR and TAF feeds, radar from radar.weather.gov.";
      }
      var age = feed.newest_age_s, lag = feed.lag_min;
      var took = (h.text || 0) + (h.obs_files || 0) + (h.radar || 0);
      $("feed-tiles").innerHTML =
        tile("products · 1 h", feed.products_last_hour != null ? feed.products_last_hour : "–", (feed.warnings_last_hour || 0) + " of them warnings") +
        tile("newest product", age != null ? ago(age) + " old" : "none", feed.source === "sdr" ? "from the dish" : "NOAA's bundles", age == null ? "bad" : age > 1800 ? "warn" : "") +
        tile("behind NOAA", lag != null ? Math.round(lag) + " min" : "–", "EMWIN's delay on the uplink", lag == null ? "" : lag >= 30 ? "warn" : "ok") +
        tile("in time · 1 h", h.in_time_pct != null ? h.in_time_pct + "%" : "–", h.issued ? h.in_time + " of " + h.issued + " came down the feed in time" : "nothing to go by yet",
          h.in_time_pct == null ? "" : h.in_time_pct >= 90 ? "ok" : h.in_time_pct >= 50 ? "warn" : "bad") +
        tile("filled · 1 h", f ? took : "–", f ? (h.text || 0) + " text · " + (h.obs_files || 0) + " airport · " + (h.radar || 0) + " radar" : "", f && f.active ? "warn" : "");
      $("sat-feed-types").innerHTML = (feed.top_types_last_hour || []).map(function (t) {
        return '<tr><td class="mono">' + esc(t[0]) + '</td><td class="n">' + t[1] + "</td></tr>";
      }).join("") || '<tr><td class="hint">Nothing in the last hour.</td></tr>';
      var rows = [];
      if (f) {
        rows.push(["state", !f.enabled ? "off (Settings › Feed and internet fill)" : f.active ? "filling in: " + f.reason : "standing by: " + f.reason]);
        rows.push(["text products", h.text || 0]);
        rows.push(["airport report files", h.obs_files || 0]);
        rows.push(["radar pictures", h.radar || 0]);
        rows.push(["still waiting", f.waiting != null ? f.waiting : "–"]);
        rows.push(["last fetch", f.last_ok ? agoAt(f.last_ok) + " ago" : "none yet"]);
        Object.keys(f.errors || {}).forEach(function (k) { rows.push(["error, " + k, f.errors[k]]); });
      }
      $("fill-detail").innerHTML = rows.map(function (r) { return '<tr><td class="k">' + esc(r[0]) + "</td><td>" + esc(r[1]) + "</td></tr>"; }).join("") ||
        '<tr><td class="hint">This feed has no internet fill.</td></tr>';
      $("sat-feed-sub").textContent = (feed.products_total || 0) + " products in the store" + (feed.directory ? " from " + feed.directory : "") + ".";
    },

    // -- the pointing meter: polled every second while the dish is aimed --
    _startMeter: function () {
      var self = this;
      this._yMin = this._yMax = null;
      this.meter();
      this._mtimer = setInterval(function () { self.meter(); }, 1000);
    },
    _stopMeter: function () { if (this._mtimer) { clearInterval(this._mtimer); this._mtimer = null; } },
    meter: function () {
      var self = this;
      api("/api/sdr/meter").then(function (d) {
        if (d.error) return;
        if (d.mode !== "point") { self._stopMeter(); self.load(); return; }
        if (!self._gains && d.gains) {
          self._gains = d.gains;
          $("m-gain").innerHTML = d.gains.map(function (g) { return '<option value="' + g + '">' + g + " dB</option>"; }).join("");
        }
        self.renderMeter(d.meter);
      }).catch(function () {});
    },
    renderMeter: function (m) {
      if (!m) { $("snr").textContent = "–"; return; }
      var g = $("m-gain");
      if (m.gain != null && document.activeElement !== g && g.options.length) {
        var best = [].slice.call(g.options).reduce(function (a, b) { return Math.abs(b.value - m.gain) < Math.abs(a.value - m.gain) ? b : a; });
        g.value = best.value;
      }
      if (m.snr != null) {
        var s = m.snr;
        $("snr").textContent = s.toFixed(1);
        $("m-peak").textContent = (m.peak || 0).toFixed(1);
        $("m-inb").textContent = m.inband_lvl != null ? m.inband_lvl.toFixed(1) : "–";
        $("m-oob").textContent = m.oob_lvl != null ? m.oob_lvl.toFixed(1) : "–";
        $("m-fill").style.width = Math.max(0, Math.min(100, s / 20 * 100)) + "%";
        $("m-pk").style.left = Math.max(0, Math.min(100, (m.peak || 0) / 20 * 100)) + "%";
        $("m-verdict").textContent = s < 2 ? "no signal" : s < 5 ? "signal found, fine-tune" : s < 9 ? "good, will decode" : "excellent";
      }
      this.drawSpec(m);
      this.drawSnr(m.history || []);
    },
    drawSpec: function (d) {
      if (!d.freqs || !d.freqs.length) return;
      var c = canvas("m-spec", 220), x = c[0], W = c[1], H = c[2], dpr = c[3];
      var f0 = d.freqs[0], f1 = d.freqs[d.freqs.length - 1], mn = Math.min.apply(null, d.db), mx = Math.max.apply(null, d.db);
      if (this._yMin == null) { this._yMin = mn - 4; this._yMax = mx + 4; }
      this._yMin += (mn - 4 - this._yMin) * 0.1; this._yMax += (mx + 4 - this._yMax) * 0.1;
      var yMin = this._yMin, yMax = this._yMax;
      var px = function (f) { return (f - f0) / (f1 - f0) * W; }, py = function (v) { return H - (v - yMin) / (yMax - yMin) * H; };
      if (d.inband) { x.fillStyle = css("--series2"); x.globalAlpha = 0.15; x.fillRect(px(d.inband[0]), 0, px(d.inband[1]) - px(d.inband[0]), H); }
      x.fillStyle = css("--dim"); x.globalAlpha = 0.12;
      (d.oob || []).forEach(function (r) { x.fillRect(px(r[0]), 0, px(r[1]) - px(r[0]), H); });
      x.globalAlpha = 1; x.strokeStyle = css("--line"); x.fillStyle = css("--dim");
      for (var f = Math.ceil(f0 / 1e6); f <= f1 / 1e6; f++) { x.beginPath(); x.moveTo(px(f * 1e6), 0); x.lineTo(px(f * 1e6), H); x.stroke(); x.fillText(f + " MHz", px(f * 1e6) + 3 * dpr, H - 6 * dpr); }
      x.strokeStyle = css("--series"); x.lineWidth = 1.5 * dpr; x.beginPath();
      d.freqs.forEach(function (fq, i) { if (i) x.lineTo(px(fq), py(d.db[i])); else x.moveTo(px(fq), py(d.db[i])); });
      x.stroke();
      if (d.oob_lvl != null) { x.strokeStyle = css("--dim"); x.setLineDash([6 * dpr, 4 * dpr]); x.beginPath(); x.moveTo(0, py(d.oob_lvl)); x.lineTo(W, py(d.oob_lvl)); x.stroke(); x.setLineDash([]); }
      this._spec = { freqs: d.freqs, db: d.db, f0: f0, f1: f1, inband: d.inband, oob: d.oob };
      if (this._hovers) this._hovers.spec();
    },
    drawSnr: function (h) {
      if (!h.length) return;
      var c = canvas("m-snrh", 110), x = c[0], W = c[1], H = c[2], dpr = c[3];
      var t1 = h[h.length - 1][0], t0 = Math.min(h[0][0], t1 - 60), mx = Math.max(15, Math.max.apply(null, h.map(function (p) { return p[1]; })));
      var px = function (t) { return (t - t0) / ((t1 - t0) || 1) * W; }, py = function (v) { return H - Math.max(0, v) / mx * H; };
      x.strokeStyle = css("--line"); x.fillStyle = css("--dim");
      for (var v = 0; v <= mx; v += 5) { x.beginPath(); x.moveTo(0, py(v)); x.lineTo(W, py(v)); x.stroke(); x.fillText(v + " dB", 4 * dpr, py(v) - 3 * dpr); }
      x.strokeStyle = css("--series2"); x.lineWidth = 2 * dpr; x.beginPath();
      h.forEach(function (p, i) { if (i) x.lineTo(px(p[0]), py(p[1])); else x.moveTo(px(p[0]), py(p[1])); });
      x.stroke();
      this._snr = { h: h, t0: t0, t1: t1 };
      if (this._hovers) this._hovers.snr();
    },

    setMode: function (mode) {
      if (mode === "point" && !confirm("Switch the receiver to pointing mode? EMWIN and HRIT reception stop until it is back in receive mode.")) return;
      var self = this;
      api("/api/sdr/mode", { method: "POST", body: { mode: mode } }).then(function () {
        Portal.ui.toast(mode === "point" ? "Pointing mode: the meter starts in a few seconds" : "Back to receiving");
        setTimeout(function () { self.load(); Portal.poll.tick(); }, 3000);
      }).catch(function (e) { Portal.ui.toast(e.message, false); });
    },
    setGain: function (g) {
      api("/api/sdr/gain", { method: "POST", body: { gain: parseFloat(g) } }).then(function () { Portal.ui.toast("Gain " + g + " dB"); })
        .catch(function (e) { Portal.ui.toast(e.message, false); });
    },
    resetPeak: function () {
      api("/api/sdr/resetpeak", { method: "POST", body: {} }).then(function () { Portal.ui.toast("Peak reset"); })
        .catch(function (e) { Portal.ui.toast(e.message, false); });
    },
  },

  // -- Settings: every .env setting the portal may write, in one place ---------------

  // Each field is one MCW_ key; its value comes from /api/system's settings
  // (the key without MCW_, lower case) and whether it applies at once from its
  // live_keys. Nothing is saved until Save, and Save sends every change in one
  // request: the server checks them all before it writes any.
  settings: {
    _orig: {}, _live: {}, _built: false, _help: false, _restart: [],
    spec: [
      { id: "replies", title: "Replies", why: "How the bot answers on the mesh.", fields: [
        { k: "MCW_REPLY_MODE", label: "Reply mode", type: "select", wide: true, opts: [
          ["dm", "DM: a private reply; a nearby stranger gets one channel reply and an advert"],
          ["channel", "Channel: every reply floods on the channel"],
          ["dm_only", "DM only: never reply on the channel"]] },
        { k: "MCW_CHANNEL_REPLY_MAX_HOPS", label: "Stranger reply, max hops", type: "number", min: 0, max: 15,
          hint: "In DM mode, someone the node cannot DM yet gets one channel reply if they are this many hops away or closer." },
        { k: "MCW_ADVERT_INTERVAL_HOURS", label: "Advert every (hours)", type: "number", min: 1, max: 168,
          hint: "How often the bot floods an advert so phones can DM it." },
        { k: "MCW_PEER_BOT_PREFIX", label: "Peer bot name prefix", ph: "WX-",
          hint: "Bots whose name starts with this are never answered, and a request that names a place is answered only by the nearest bot." },
        { k: "MCW_STATUS_CHANNEL", label: "Status channel", ph: "#meshwx-status",
          hint: "One short line per change (lock lost or back, the internet fill, the Pi's disk or temperature) on a public hashtag channel. Never the request channel. Empty = no status lines." },
      ] },
      { id: "delivery", title: "Delivery", why: "The node hears a repeater's copy of each reply. A reply with no echo inside the window is sent once more, byte for byte the same, so nobody sees it twice; DMs wait for the recipient's ACK instead.", fields: [
        { k: "MCW_RETRANSMIT_MAX", label: "Resend if not heard, at most", type: "select", opts: [["0", "0 (measure only)"], ["1", "1"], ["2", "2"]] },
        { k: "MCW_ECHO_WINDOW_S", label: "Echo window (s)", type: "number", min: 1, max: 60, step: 0.5 },
        { k: "MCW_RETRANSMIT_PER_HOUR", label: "Resends per hour, at most", type: "number", min: 0, max: 500 },
        { k: "MCW_RELAYED_REPLY_DELAY_S", label: "Wait before answering a relayed request (s)", type: "number", min: 0, max: 10, step: 0.1,
          hint: "A request that came through repeaters is answered after this wait plus up to half as much again at random, so the answer does not go out while the repeaters are still passing the request on. 0 answers at once." },
      ] },
      { id: "limits", title: "Limits", why: "Every answer floods the mesh, so a higher limit spends other people's airtime. Where each limit stands right now is under Mesh › Limits and cooldowns.", fields: [
        { group: "App answers" },
        { k: "MCW_APP_PACKETS_PER_HOUR", label: "Packets per hour, every app together", type: "number", min: 1, max: 5000,
          hint: "Once spent, a request is answered \"busy\", once a minute per radio; a radar request gets no reply, because both apps read a radar refusal as \"sent a few minutes ago\"." },
        { k: "MCW_APP_SENDER_GAP_S", label: "One app's requests, at most every (s)", type: "number", min: 0.5, max: 60, step: 0.5,
          hint: "The apps space their own requests 5 s apart." },
        { k: "MCW_PART_RESEND_FLOOR_S", label: "The same missing packet again after (s)", type: "number", min: 0, max: 600 },
        { k: "MCW_SWEEP_WINDOW_S", label: "Alert map of the same area again after (s)", type: "number", min: 0, max: 3600 },
        { k: "MCW_RADAR_WINDOW_S", label: "The same radar tile again after (s)", type: "number", min: 0, max: 3600 },
        { group: "Text replies" },
        { k: "MCW_TEXT_REPLIES_PER_HOUR", label: "Per hour, everyone", type: "number", min: 1, max: 10000 },
        { k: "MCW_TEXT_REPLIES_PER_SENDER_PER_HOUR", label: "Per hour, one person", type: "number", min: 1, max: 1000 },
        { group: "Channel replies to strangers (reply mode DM only)" },
        { k: "MCW_STRANGER_REPLIES_PER_HOUR", label: "Per hour", type: "number", min: 1, max: 1000 },
        { k: "MCW_STRANGER_REPLY_GAP_S", label: "The same person again after (s)", type: "number", min: 0, max: 86400 },
        { group: "Scheduled broadcasts" },
        { k: "MCW_SCHEDULED_PACKETS_PER_HOUR", label: "Packets per hour, every job together", type: "number", min: 1, max: 5000,
          hint: "Tornado, severe thunderstorm, flash flood and extreme wind warnings and their one repeat always go out and count; past the ceiling everything else waits for the hour to free up." },
      ] },
      { id: "coverage", title: "Coverage", why: "The area the scheduled broadcasts and the \"nearest bot\" rule use. Text replies cover the whole country either way.", fields: [
        { k: "MCW_HOME_CITIES", label: "Home city, then any extra cities", ph: "Austin TX, San Antonio TX", wide: true,
          hint: "Comma separated. The radius is drawn around the first one." },
        { k: "MCW_HOME_RADIUS_KM", label: "Radius (km)", type: "number", min: 0 },
        { k: "MCW_HOME_STATES", label: "States", ph: "TX,OK" },
        { k: "MCW_HOME_WFOS", label: "Forecast offices", ph: "EWX,FWD" },
      ] },
      { id: "feed", title: "Feed and internet fill", why: "Where the products come from, and how long the feed gets before NWS fills in over the internet.", fields: [
        { k: "MCW_EMWIN_SOURCE", label: "EMWIN source", type: "select", opts: [["sdr", "sdr: the dish (goesproc directory)"], ["internet", "internet: NOAA's bundles"]] },
        { k: "MCW_SDR_EMWIN_DIR", label: "EMWIN directory" },
        { k: "MCW_SDR_POLL_INTERVAL", label: "Directory scan (s)", type: "number", min: 5 },
        { k: "MCW_FILL_ENABLED", label: "Internet fill", type: "select", opts: [["true", "on"], ["false", "off"]] },
        { k: "MCW_FILL_GRACE_WARNING_MIN", label: "Grace for warnings (min)", type: "number", min: 0, max: 120,
          hint: "A warning the feed has not delivered this long after it was issued is taken from api.weather.gov." },
        { k: "MCW_FILL_GRACE_MIN", label: "Grace for everything else (min)", type: "number", min: 0, max: 240 },
        { k: "MCW_SDR_DASHBOARD_URL", label: "Receiver dashboard, for the bot", ph: "http://127.0.0.1:8080",
          hint: "The goestools dashboard on localhost. Never its public hostname: a poll that leaves the house and comes back through Cloudflare fails." },
        { k: "MCW_SDR_DASHBOARD_PUBLIC_URL", label: "Receiver dashboard, for people", ph: "https://goes.digitaino.com",
          hint: "The address the links and the public bundle give out. Empty = the same as the one above." },
        { k: "MCW_OPERATOR_CONTACT", label: "Operator contact for NOAA", ph: "you@example.org",
          hint: "An email address or URL added to the User-Agent of every NOAA fetch, so their administrators can reach you." },
      ] },
      { id: "radiolink", title: "Radio link", why: "How the bot reaches its node, and what it does when another radio turns up on the port.", fields: [
        { k: "MCW_SERIAL_PORT", label: "Serial port", ph: "/dev/meshcore" },
        { k: "MCW_SERIAL_BAUD", label: "Baud", type: "number" },
        { k: "MCW_RADIO_ADOPT", label: "Replacement radio", type: "select", wide: true, opts: [
          ["manual", "manual: ask first, under Radio › Hardware and swap"],
          ["auto", "auto: a new radio takes over the saved identity on its own"],
          ["off", "off: never adopt"]],
          hint: "The profile (key, name, position, LoRa settings, contacts) is saved on every connect either way." },
        { k: "MCW_RADIO_RX_SILENT_MIN", label: "Receiver silent after (min)", type: "number", min: 1, max: 1440,
          hint: "Nothing heard from anyone for this long is flagged as a deaf radio." },
      ] },
      { id: "corescope", title: "CoreScope", why: "Optional, over the internet: CoreScope's observers say who heard each reply.", fields: [
        { k: "MCW_SCOPE_URL", label: "CoreScope URL", ph: "https://scope.digitaino.com", hint: "Empty = off." },
        { k: "MCW_SCOPE_MODE", label: "CoreScope use", type: "select", opts: [["stats", "stats: note who heard each reply"], ["decide", "decide: also skip a resend the mesh observed"]] },
        { k: "MCW_SCOPE_MIN_OBSERVERS", label: "Observers of a repeat needed", type: "number", min: 1, max: 20,
          hint: "Only observers whose copy went through a repeater count, and one is proof enough. A neighbour hearing us direct proves nothing." },
      ] },
      { id: "host", title: "Host", why: "This Pi, and the bot's own process.", fields: [
        { k: "MCW_TIMEZONE", label: "Time zone", ph: "America/Chicago" },
        { k: "MCW_LOG_LEVEL", label: "Log level", type: "select", opts: [["INFO", "INFO"], ["DEBUG", "DEBUG"], ["WARNING", "WARNING"], ["ERROR", "ERROR"]] },
      ] },
    ],

    _keys: function () {
      var out = [];
      this.spec.forEach(function (g) { g.fields.forEach(function (f) { if (f.k) out.push(f); }); });
      return out;
    },

    build: function () {
      var self = this;
      $("set-nav").innerHTML = this.spec.map(function (g) { return '<button data-go="settings-' + g.id + '">' + esc(g.title) + "</button>"; }).join("");
      $("set-groups").innerHTML = this.spec.map(function (g) {
        var extra = g.id === "coverage" ? '<p class="hint mt" id="coverage-summary"></p>' :
          g.id === "host" ? '<div class="tiles mt" id="sys-tiles"></div><div class="row mt"><button class="danger" onclick="Portal.settings.restart()">Restart the bot</button><span class="hint">Back in about 90 seconds; the radio link drops briefly.</span></div>' : "";
        return '<section class="block" id="settings-' + g.id + '"><div class="bh"><h2>' + esc(g.title) + "</h2></div>" +
          (g.why ? '<p class="why">' + esc(g.why) + "</p>" : "") +
          '<div class="fields">' + g.fields.map(function (f) { return self._field(f); }).join("") + "</div>" + extra + "</section>";
      }).join("");
      $("set-groups").addEventListener("input", function () { self.dirty(); });
      $("set-groups").addEventListener("change", function () { self.dirty(); });
      this._built = true;
    },

    _field: function (f) {
      if (f.group) return '<div class="group-label">' + esc(f.group) + "</div>";
      var id = "set-" + f.k, input;
      if (f.type === "select") {
        input = '<select id="' + id + '" data-k="' + f.k + '">' + f.opts.map(function (o) { return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + "</option>"; }).join("") + "</select>";
      } else {
        input = '<input id="' + id + '" data-k="' + f.k + '" type="' + (f.type === "number" ? "number" : "text") + '"' +
          (f.min != null ? ' min="' + f.min + '"' : "") + (f.max != null ? ' max="' + f.max + '"' : "") + (f.step ? ' step="' + f.step + '"' : "") +
          (f.ph ? ' placeholder="' + esc(f.ph) + '"' : "") + ' autocomplete="off" spellcheck="false">';
      }
      return '<div class="f' + (f.wide ? " wide" : "") + '" id="f-' + f.k + '"><label for="' + id + '">' + esc(f.label) + ' <span class="pill" data-chip="' + f.k + '"></span></label>' +
        input + (f.hint ? '<div class="fh">' + esc(f.hint) + "</div>" : "") + "</div>";
    },

    onEnter: function () {
      if (!this._built) this.build();
      if (!this._changes().length) this.load();
      this.dirty();
    },
    onLeave: function () { $("savebar").hidden = true; },

    toggleHelp: function () {
      this._help = !this._help;
      $("set-groups").classList.toggle("showhelp", this._help);
      $("set-help").setAttribute("aria-pressed", this._help ? "true" : "false");
      $("set-help").textContent = this._help ? "Hide help" : "Show help";
    },

    load: function () {
      var self = this;
      return api("/api/system").then(function (d) {
        var b = d.bot || {}, h = d.host || {}, s = d.settings || {}, cov = d.coverage || {};
        self._live = {}; (d.live_keys || []).forEach(function (k) { self._live[k] = true; });
        self._keys().forEach(function (f) {
          var v = s[f.k.slice(4).toLowerCase()];
          var str = v == null ? "" : String(v);
          self._orig[f.k] = str;
          var el = $("set-" + f.k);
          if (el.tagName === "SELECT" && ![].some.call(el.options, function (o) { return o.value === str; })) {
            el.insertAdjacentHTML("afterbegin", '<option value="' + esc(str) + '">' + esc(str || "(default)") + "</option>");
          }
          el.value = str;
          var chip = document.querySelector('[data-chip="' + f.k + '"]');
          chip.textContent = self._live[f.k] ? "live" : "restart";
          chip.className = "pill " + (self._live[f.k] ? "" : "warn");
          chip.title = self._live[f.k] ? "Applied the moment it is saved" : "Saved to .env; takes effect when the bot restarts";
        });
        $("coverage-summary").innerHTML = "<b>" + esc(cov.summary || "") + "</b>";
        $("sys-tiles").innerHTML =
          tile("bot up", ago(b.uptime_s), (h.hostname || "") + (b.git ? " · commit " + b.git : "")) +
          tile("host up", ago(h.uptime_s), h.load ? "load " + h.load.join(" / ") : "") +
          tile("memory free", h.mem_available_mb != null ? h.mem_available_mb + " MB" : "–", "of " + h.mem_total_mb + " MB") +
          tile("disk free", h.disk_free_gb != null ? h.disk_free_gb + " GB" : "–", h.disk_used_pct + "% used", h.disk_used_pct > 85 ? "bad" : h.disk_used_pct > 75 ? "warn" : "") +
          tile("CPU", h.temp_c != null ? h.temp_c + "°C" : "–", b.products + " products in the store", h.temp_c > 80 ? "bad" : h.temp_c > 75 ? "warn" : "");
        self.dirty();
      }).catch(function (e) { Portal.ui.toast(e.message, false); });
    },

    _label: function (k) {
      var f = this._keys().filter(function (x) { return x.k === k; })[0];
      return f ? f.label : k;
    },
    _show: function (f, v) {
      if (v === "") return "(default)";
      if (f && f.type === "select") { var o = f.opts.filter(function (x) { return x[0] === v; })[0]; if (o) return o[1].split(":")[0]; }
      return v;
    },
    _changes: function () {
      var self = this, out = [];
      if (!this._built) return out;
      this._keys().forEach(function (f) {
        var el = $("set-" + f.k), v = el.value.trim();
        if (self._orig[f.k] !== undefined && v !== self._orig[f.k]) out.push({ f: f, from: self._orig[f.k], to: v });
      });
      return out;
    },

    // The save bar: what changed, from what to what, and which need a restart.
    dirty: function () {
      var self = this, ch = this._changes();
      this._keys().forEach(function (f) { $("f-" + f.k).classList.remove("changed"); });
      ch.forEach(function (c) { $("f-" + c.f.k).classList.add("changed"); });
      var bar = $("savebar");
      if (!ch.length && !this._restart.length) { bar.hidden = true; document.body.classList.remove("saving"); return; }
      bar.hidden = Portal.router.current !== "settings";
      document.body.classList.toggle("saving", !bar.hidden);
      if (ch.length) {
        var needs = ch.filter(function (c) { return !self._live[c.f.k]; }).length;
        $("save-what").innerHTML = "<b>" + ch.length + " unsaved change" + (ch.length === 1 ? "" : "s") + "</b>" + (needs ? " · " + needs + " take effect after a restart" : "") +
          "<small>" + ch.map(function (c) { return esc(c.f.label) + ": " + esc(self._show(c.f, c.from)) + " → " + esc(self._show(c.f, c.to)); }).join(" · ") + "</small>";
        $("save-btn").textContent = "Save"; $("save-btn").onclick = function () { self.save(this); };
        $("save-discard").textContent = "Discard"; $("save-discard").onclick = function () { self.discard(); };
      } else {
        $("save-what").innerHTML = "<b>Saved.</b> A restart applies " + this._restart.map(function (k) { return esc(self._label(k)); }).join(", ") + ".";
        $("save-btn").textContent = "Restart the bot"; $("save-btn").onclick = function () { self.restart(); };
        $("save-discard").textContent = "Later"; $("save-discard").onclick = function () { self._restart = []; self.dirty(); };
      }
    },

    discard: function () {
      var self = this;
      this._keys().forEach(function (f) { $("set-" + f.k).value = self._orig[f.k]; $("f-" + f.k).classList.remove("bad"); });
      this.dirty();
    },

    save: function (btn) {
      var self = this, ch = this._changes(), body = {};
      if (!ch.length) return;
      ch.forEach(function (c) { body[c.f.k] = c.to; });
      if (body.MCW_REPLY_MODE === "channel" && !confirm("Switch to channel replies? Every answer will flood the mesh through every repeater in range.")) return;
      if (body.MCW_FILL_ENABLED === "false" && !confirm("Turn the internet fill off? Anything the feed misses or delivers late stays missing.")) return;
      btn.disabled = true;
      this._keys().forEach(function (f) { $("f-" + f.k).classList.remove("bad"); });
      api("/api/settings/env", { method: "POST", body: body }).then(function (d) {
        Portal.ui.toast(d.note || "Saved");
        self._restart = (d.restart_needed || []).slice();
        return self.load();
      }).then(function () { Portal.poll.tick(); })
        .catch(function (e) {
          // The server names the key it refused ("MCW_X: must be ..."), and nothing was written.
          var k = (e.message.match(/^(MCW_[A-Z0-9_]+):/) || [])[1];
          if (k && $("f-" + k)) { $("f-" + k).classList.add("bad"); $("set-" + k).focus(); }
          Portal.ui.toast(k ? self._label(k) + ": " + e.message.slice(k.length + 2) : e.message, false);
        })
        .finally(function () { btn.disabled = false; });
    },

    restart: function () {
      if (!confirm("Restart the bot now? It is back in about 90 seconds; the radio link drops briefly.")) return;
      var self = this;
      api("/api/system/restart", { method: "POST", body: {} }).then(function (d) {
        Portal.ui.toast(d.note || "Restarting"); self._restart = []; self.dirty();
      }).catch(function (e) { Portal.ui.toast(e.message, false); });
    },
  },

  // -- Logs ----------------------------------------------------------------------------

  logs: {
    _lines: [], _max: 3000, _cat: "all", _paused: false, _sse: null, _pending: 0, _lastId: 0,
    onEnter: function () { this.start(); },
    onLeave: function () { this.stop(); },
    start: function () {
      var self = this;
      api("/api/logs?n=800").then(function (d) {
        self._lines = d.lines || [];
        self._lastId = self._lines.length ? self._lines[self._lines.length - 1].id : 0;
        self._counts(d.counts);
        self.render(true);
        self._connect();
      }).catch(function (e) { Portal.ui.toast("Logs: " + e.message, false); });
    },
    stop: function () { if (this._sse) { this._sse.close(); this._sse = null; } },
    _connect: function () {
      var self = this;
      if (this._sse) this._sse.close();
      this._sse = liveStream("/api/logs/stream", function (l) {
        if (l.id && l.id <= self._lastId) return;
        self._lastId = l.id || self._lastId;
        self._lines.push(l);
        if (self._lines.length > self._max) self._lines.splice(0, self._lines.length - self._max);
        if (self._paused) { self._pending++; self._status(); return; }
        if (self._show(l)) appendLine($("logs-body"), self._fmt(l), self._max);
      }, "logs-dot");
    },
    _counts: function (c) {
      if (!c) return;
      ["satellite", "radio", "bot"].forEach(function (k) { $("logs-n-" + k).textContent = c[k] || 0; });
    },
    _status: function () {
      $("logs-status").textContent = this._paused ? "paused" + (this._pending ? " · " + this._pending + " new" : "") : this._lines.length + " lines";
    },
    setCat: function (cat) {
      this._cat = cat;
      pressChip("logs-cats", "cat", cat);
      this.render(true);
    },
    togglePause: function () {
      this._paused = !this._paused;
      $("logs-pause").textContent = this._paused ? "Resume" : "Pause";
      $("logs-pause").setAttribute("aria-pressed", this._paused ? "true" : "false");
      if (!this._paused) { this._pending = 0; this.render(true); }
      this._status();
    },
    clear: function () { this._lines = []; this.render(true); },
    _show: function (l) {
      if (this._cat !== "all" && l.cat !== this._cat) return false;
      var lv = $("logs-level").value, order = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
      if (lv && order.indexOf(l.level) < order.indexOf(lv)) return false;
      var q = $("logs-q").value.trim().toLowerCase();
      return !q || l.msg.toLowerCase().indexOf(q) !== -1;
    },
    _fmt: function (l) {
      var lc = l.level === "ERROR" || l.level === "CRITICAL" ? "bad" : l.level === "WARNING" ? "warn" : "";
      var cc = { satellite: "in", radio: "out" }[l.cat] || "m";
      return '<div><span class="t">' + hhmmss(l.t) + '</span> <span class="' + cc + '" style="display:inline-block;min-width:64px">' + esc(l.cat) + "</span>" +
        '<span class="tag ' + lc + '">' + esc(l.level.slice(0, 4)) + "</span> " + (lc === "bad" ? '<span class="err">' + esc(l.msg) + "</span>" : esc(l.msg)) + "</div>";
    },
    render: function (scroll) {
      var self = this, el = $("logs-body"), html = [];
      this._lines.forEach(function (l) { if (self._show(l)) html.push(self._fmt(l)); });
      el.innerHTML = html.join("") || '<div class="m">Nothing matches.</div>';
      if (scroll !== false) el.scrollTop = el.scrollHeight;
      this._status();
    },
  },

  init: function () {
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") Portal.ui.closeModal(); });
    // Section links inside a tab (the pill rows) scroll, and keep the address.
    document.addEventListener("click", function (e) {
      var b = e.target.closest("[data-go]");
      if (b) {
        var id = b.dataset.go, el = $(id);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        var sec = id.split("-")[0];
        history.replaceState(null, "", "#" + sec + "/" + id.slice(sec.length + 1));
        return;
      }
      var k = e.target.closest("#traffic-kinds button");
      if (k) { Portal.traffic.setKind(k.dataset.k); return; }
      var c = e.target.closest("#logs-cats button");
      if (c) { Portal.logs.setCat(c.dataset.cat); }
    });
    window.addEventListener("beforeunload", function (e) {
      if (Portal.settings._changes().length) { e.preventDefault(); e.returnValue = ""; }
    });
    this.poll.start();
    this.router.init();
  },
};

document.addEventListener("DOMContentLoaded", function () { Portal.init(); });
