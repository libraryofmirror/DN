// ==UserScript==
// @name         서버시간 오버레이 (클릭 → 서버 도달 시각)
// @namespace    https://github.com/libraryofmirror/dn
// @version      1.0
// @description  보고 있는 사이트의 서버 시각을 ms 단위로 맞추고, 신청 버튼을 눌렀을 때 그 신호가 서버에 닿는 시각을 기록한다.
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
//
// 쓰는 법 (셋 중 하나)
//   1) 신청 페이지에서 F12 → Console → 이 파일 내용을 통째로 붙여넣고 Enter
//      (크롬은 처음 한 번 "allow pasting" 을 입력해야 붙여넣기가 허용된다)
//   2) Tampermonkey 같은 유저스크립트 매니저에 등록하고 @match 를 해당 사이트로 좁힌다
//   3) 북마크릿으로 이 파일을 주입 (사이트 CSP 가 막을 수 있음)
//
// 이 스크립트는 자기가 보고 있는 페이지와 같은 출처(same-origin)로 HEAD 요청만 보낸다.
// 대신 눌러 주거나, 요청을 만들어 보내거나, 무언가를 신청하지 않는다. 측정과 표시만 한다.

(() => {
  "use strict";

  if (window.__serverTimeOverlay) { window.__serverTimeOverlay.toggle(); return; }

  /* ================= 상태 ================= */
  const S = {
    samples: [],        // {L, U, rttMs, netMs, at}
    est: null,          // {lo, hi, mid, err, n, total}
    netRtt: null,
    rttMedian: null,
    probeUrl: null,
    running: true,
    clicks: [],
    lastNote: "",
  };

  const WINDOW_MS = 180000;
  const MAX_SAMPLES = 80;
  const CLICK_ATTRIBUTION_MS = 6000;   // 클릭 후 이 시간 안에 나간 요청을 그 클릭의 신호로 본다
  const STORE_KEY = "__serverTimeOverlay_click";
  const MARK = "_stq";                  // 우리 프로브 요청 표시(사이트 요청과 구분)

  const p2 = n => String(n).padStart(2, "0");
  const p3 = n => String(n).padStart(3, "0");
  const fmt = ms => {
    const d = new Date(ms);
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
  };
  const median = a => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  /* ================= 시계 차이 추정 =================
     응답의 Date 헤더는 초 단위로 잘려 있고, 서버가 그것을 만든 순간은
     요청을 보낸 시각과 응답 첫 바이트를 받은 시각 사이에 있다.
       offset(= 서버시계 − 내시계) ∈ (Date − 수신시각, Date + 1000 − 송신시각)
     이 구간들을 겹쳐 나가면 폭이 왕복지연 수준까지 줄어든다. */
  function intersect(samples) {
    if (!samples.length) return null;
    const ev = [];
    for (const s of samples) ev.push([s.L, 1], [s.U, -1]);
    ev.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let cur = 0, best = 0, bestX = ev[0][0];
    for (const [x, d] of ev) { cur += d; if (cur > best) { best = cur; bestX = x; } }
    const cov = samples.filter(s => s.L <= bestX && bestX <= s.U);
    let lo = -Infinity, hi = Infinity;
    for (const s of cov) { if (s.L > lo) lo = s.L; if (s.U < hi) hi = s.U; }
    return { lo, hi, mid: (lo + hi) / 2, err: (hi - lo) / 2, n: cov.length, total: samples.length };
  }

  function recompute() {
    const cutoff = Date.now() - WINDOW_MS;
    S.samples = S.samples.filter(s => s.at >= cutoff).slice(-MAX_SAMPLES);
    S.est = intersect(S.samples);
    const nets = S.samples.map(s => s.netMs).filter(v => v != null && isFinite(v));
    S.netRtt = nets.length ? Math.min(...nets) : null;
    S.rttMedian = median(S.samples.map(s => s.rttMs));
  }

  const upstream = () => (S.netRtt == null ? null : S.netRtt / 2);
  const serverNow = () => (S.est ? Date.now() + S.est.mid : null);
  function totalErr() {
    if (!S.est) return null;
    const jitter = (S.rttMedian != null && S.netRtt != null) ? Math.max(0, S.rttMedian - S.netRtt) / 2 : 0;
    return S.est.err + (S.netRtt == null ? 0 : S.netRtt / 4) + jitter;
  }

  /* ================= 리소스 타이밍 관찰 ================= */
  const probeWaiters = new Map();     // url -> resolve
  let pendingClick = null;

  const observer = new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      const waiter = probeWaiters.get(e.name);
      if (waiter) { probeWaiters.delete(e.name); waiter(e); continue; }
      if (pendingClick) attributeToClick(e);
    }
  });
  try { observer.observe({ type: "resource", buffered: false }); } catch (_) { /* 구형 브라우저 */ }

  /* ================= 프로브 ================= */
  async function pickProbeUrl() {
    const candidates = [];
    try {
      for (const e of performance.getEntriesByType("resource")) {
        if (!e.name.startsWith(location.origin)) continue;
        if (e.name.includes(MARK)) continue;
        if (!/^(link|script|img|css|other)$/.test(e.initiatorType)) continue;
        candidates.push([e.transferSize || e.encodedBodySize || 1e9, e.name.split("?")[0]]);
      }
    } catch (_) { /* 무시 */ }
    candidates.sort((a, b) => a[0] - b[0]);
    const list = [...new Set(candidates.map(c => c[1]))].slice(0, 3);
    list.push(location.href.split("#")[0], location.origin + "/favicon.ico");

    let fallback = null;
    for (const url of list) {
      try {
        const s = await probe(url);
        if (!s) continue;
        if (s.status < 400) { S.probeUrl = url; return url; }   // 정상 응답을 우선한다
        if (!fallback) fallback = url;                          // 404 도 Date 는 정확하므로 최후 수단
      } catch (_) { /* 다음 후보 */ }
    }
    if (fallback) { S.probeUrl = fallback; return fallback; }
    throw new Error("서버 시각을 읽을 수 있는 주소를 찾지 못했습니다.");
  }

  async function probe(base) {
    const url = base + (base.includes("?") ? "&" : "?") + MARK + "=" + Date.now().toString(36) +
                Math.random().toString(36).slice(2, 7);
    const abs = new URL(url, location.href).href;

    const entryPromise = new Promise(res => {
      probeWaiters.set(abs, res);
      setTimeout(() => { probeWaiters.delete(abs); res(null); }, 4000);
    });

    const t0 = Date.now();
    const resp = await fetch(url, { method: "HEAD", cache: "no-store", credentials: "omit", redirect: "follow" });
    const t1 = Date.now();
    const dateRaw = resp.headers.get("date");
    const ageRaw = resp.headers.get("age");

    if (!dateRaw) { S.lastNote = "Date 헤더가 없는 응답"; return null; }
    if (ageRaw && Number(ageRaw) > 0) { S.lastNote = `캐시된 응답(Age=${ageRaw}s) 무시`; return null; }
    const dateMs = Date.parse(dateRaw);
    if (!isFinite(dateMs)) return null;

    // 네트워크 타이밍이 있으면 훨씬 좁은 구간을 얻는다(브라우저 내부 지연을 뺀 실제 송·수신 시각)
    const entry = await entryPromise;
    let sendWall = t0, recvWall = t1, netMs = null, rttMs = t1 - t0;
    if (entry && entry.requestStart > 0 && entry.responseStart > 0) {
      sendWall = performance.timeOrigin + entry.requestStart;
      recvWall = performance.timeOrigin + entry.responseStart;
      rttMs = entry.responseStart - entry.requestStart;
      netMs = entry.connectEnd > entry.connectStart ? entry.connectEnd - entry.connectStart : rttMs;
    }

    S.samples.push({ L: dateMs - recvWall, U: dateMs + 1000 - sendWall, rttMs, netMs, at: Date.now() });
    S.lastNote = "";
    recompute();
    return { status: resp.status };
  }

  function goodEnough() { return Math.max(5, (S.netRtt == null ? 30 : S.netRtt) * 0.75); }

  function nextDelay() {
    const n = S.samples.length;
    if (n < 6) return 260 + Math.random() * 160;
    if (!S.est || S.est.err > 80) return 260 + Math.random() * 200;
    const up = upstream() ?? 20;
    let wait = (1000 - ((Date.now() + S.est.mid) % 1000)) - up + (Math.random() * 50 - 25);
    while (wait < 200) wait += 1000;
    if (S.est.err <= goodEnough()) while (wait < 2500) wait += 1000;   // 유지 단계
    return wait;
  }

  async function loop() {
    try { if (!S.probeUrl) await pickProbeUrl(); } catch (e) { S.lastNote = e.message; }
    let fails = 0;
    while (S.running) {
      try {
        if (S.probeUrl) { await probe(S.probeUrl); fails = 0; }
      } catch (e) {
        fails++;
        S.lastNote = "측정 실패: " + e.message;
        if (fails >= 6) { S.probeUrl = null; fails = 0; try { await pickProbeUrl(); } catch (_) {} }
      }
      await new Promise(r => setTimeout(r, fails ? 1500 * fails : nextDelay()));
    }
  }

  /* ================= 클릭 → 서버 도달 ================= */
  function onClick(ev) {
    if (hud && hud.contains(ev.target)) return;      // 오버레이 자체 클릭은 제외
    const handlerWall = Date.now();
    const pressWall = performance.timeOrigin + ev.timeStamp;
    let inputLag = handlerWall - pressWall;
    if (!isFinite(inputLag) || inputLag < 0 || inputLag > 2000) inputLag = null;

    const rec = {
      i: S.clicks.length + 1,
      label: describe(ev.target),
      pressServer: (inputLag == null ? handlerWall : pressWall) + (S.est ? S.est.mid : 0),
      pressPerf: ev.timeStamp,
      inputLag,
      arrivalServer: null,
      via: "대기",
      err: totalErr(),
      offset: S.est ? S.est.mid : null,
      upstream: upstream(),
    };
    if (!S.est) rec.via = "동기화 전";
    S.clicks.push(rec);
    pendingClick = rec;
    setTimeout(() => { if (pendingClick === rec && rec.arrivalServer == null) { rec.via = "요청 없음"; pendingClick = null; render(); } },
               CLICK_ATTRIBUTION_MS);
    render();
  }

  function describe(el) {
    if (!el || !el.tagName) return "?";
    const t = (el.innerText || el.value || el.getAttribute?.("aria-label") || el.tagName).trim().replace(/\s+/g, " ");
    return t.slice(0, 14) || el.tagName;
  }

  /* 클릭 직후 나간 요청의 requestStart 가 '브라우저가 신호를 내보낸 시각'이다.
     여기에 상행 지연(왕복/2)을 더하면 서버에 닿은 시각이 된다. */
  function attributeToClick(entry) {
    if (!pendingClick) return;
    if (entry.name.includes(MARK)) return;
    if (!/^(xmlhttprequest|fetch|beacon|other|iframe|navigation)$/.test(entry.initiatorType)) return;
    if (entry.startTime < pendingClick.pressPerf - 20) return;
    if (entry.startTime > pendingClick.pressPerf + CLICK_ATTRIBUTION_MS) return;

    const start = entry.requestStart > 0 ? entry.requestStart : entry.startTime;
    finishClick(pendingClick, performance.timeOrigin + start, "요청(" + entry.initiatorType + ")");
    pendingClick = null;
  }

  function finishClick(rec, sendWall, via) {
    const off = S.est ? S.est.mid : rec.offset;
    const up = upstream() ?? rec.upstream ?? 0;
    if (off == null) return;
    rec.arrivalServer = sendWall + off + up;
    rec.upstream = up;
    rec.err = totalErr();
    rec.via = via;
    render();
  }

  /* 신청 버튼이 페이지 이동을 일으키면 이 스크립트도 같이 사라진다.
     클릭 정보를 남겨 두었다가, 새 페이지에서 navigation timing 으로 도달 시각을 복원한다. */
  window.addEventListener("pagehide", () => {
    if (pendingClick && pendingClick.arrivalServer == null) {
      try {
        sessionStorage.setItem(STORE_KEY, JSON.stringify({
          label: pendingClick.label, pressServer: pendingClick.pressServer,
          inputLag: pendingClick.inputLag, offset: S.est ? S.est.mid : null,
          upstream: upstream(), err: totalErr(), savedAt: Date.now(),
        }));
      } catch (_) { /* 무시 */ }
    }
  });

  function restorePreviousClick() {
    let raw;
    try { raw = sessionStorage.getItem(STORE_KEY); } catch (_) { return; }
    if (!raw) return;
    try { sessionStorage.removeItem(STORE_KEY); } catch (_) { /* 무시 */ }
    let saved;
    try { saved = JSON.parse(raw); } catch (_) { return; }
    if (!saved || Date.now() - saved.savedAt > 120000) return;

    const nav = performance.getEntriesByType("navigation")[0];
    const rec = {
      i: 1, label: saved.label + " ↗", pressServer: saved.pressServer, inputLag: saved.inputLag,
      upstream: saved.upstream, err: saved.err, arrivalServer: null, via: "페이지 이동",
    };
    if (nav && saved.offset != null) {
      const sendWall = performance.timeOrigin + (nav.requestStart > 0 ? nav.requestStart : nav.startTime);
      rec.arrivalServer = sendWall + saved.offset + (saved.upstream ?? 0);
    }
    S.clicks.push(rec);
  }

  /* ================= 화면 ================= */
  let hud, root, els = {};

  function buildHud() {
    hud = document.createElement("div");
    hud.style.cssText = "position:fixed;top:14px;right:14px;z-index:2147483647;";
    root = hud.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host,*{box-sizing:border-box}
        .p{width:268px;background:#0d0f13;color:#eee;border:1px solid #2a3140;border-radius:10px;
           font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
           box-shadow:0 10px 32px rgba(0,0,0,.55);overflow:hidden;user-select:none}
        .h{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#151a22;cursor:move;border-bottom:1px solid #222a36}
        .h b{font-size:10px;letter-spacing:1.5px;color:#7aa7ff;font-weight:700;flex:1}
        .h button{background:none;border:none;color:#7a8494;cursor:pointer;font-size:13px;padding:0 4px;line-height:1}
        .h button:hover{color:#fff}
        .b{padding:10px}
        .clk{font-size:27px;font-weight:700;letter-spacing:-.5px;text-align:center;font-variant-numeric:tabular-nums;color:#fff}
        .clk .ms{color:#5b9dff;font-size:.62em}
        .st{text-align:center;color:#7a8494;font-size:10px;margin-top:2px}
        .st b{color:#4ade80}
        .g{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:9px}
        .g div{background:#141821;border-radius:4px;padding:5px 7px}
        .g i{display:block;color:#6b7484;font-style:normal;font-size:9px;letter-spacing:.5px}
        .g span{font-weight:700;font-size:12px}
        .lg{margin-top:9px;border-top:1px solid #222a36;padding-top:7px;max-height:150px;overflow:auto}
        .lg .r{display:flex;justify-content:space-between;gap:6px;padding:2px 0;border-bottom:1px dotted #1e242e}
        .lg .r:last-child{border-bottom:none}
        .lg .n{color:#8a94a6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:96px}
        .lg .t{color:#fff;font-weight:700}
        .lg .w{color:#5b6472;font-size:9px}
        .note{color:#ffb020;font-size:10px;margin-top:6px;word-break:break-all}
      </style>
      <div class="p">
        <div class="h"><b>SERVER TIME</b><button id="min">–</button><button id="cls">×</button></div>
        <div class="b">
          <div class="clk" id="clk">--:--:--<span class="ms">.---</span></div>
          <div class="st" id="st">동기화 중…</div>
          <div class="g">
            <div><i>오차</i><span id="err">–</span></div>
            <div><i>왕복</i><span id="rtt">–</span></div>
            <div><i>상행(클릭→서버)</i><span id="up">–</span></div>
            <div><i>샘플</i><span id="n">–</span></div>
          </div>
          <div class="lg" id="lg"></div>
          <div class="note" id="note"></div>
        </div>
      </div>`;
    (document.body || document.documentElement).appendChild(hud);
    for (const id of ["clk", "st", "err", "rtt", "up", "n", "lg", "note", "min", "cls"]) els[id] = root.getElementById(id);

    els.cls.onclick = () => { S.running = false; hud.remove(); window.__serverTimeOverlay = null; };
    els.min.onclick = () => { const b = root.querySelector(".b"); b.style.display = b.style.display === "none" ? "" : "none"; };

    // 드래그
    const head = root.querySelector(".h");
    let dx = 0, dy = 0, dragging = false;
    head.addEventListener("mousedown", e => {
      dragging = true;
      const r = hud.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", e => {
      if (!dragging) return;
      hud.style.left = (e.clientX - dx) + "px";
      hud.style.top = (e.clientY - dy) + "px";
      hud.style.right = "auto";
    });
    window.addEventListener("mouseup", () => { dragging = false; });
  }

  function render() {
    if (!els.err) return;
    const e = totalErr();
    els.err.textContent = e == null ? "–" : "±" + e.toFixed(0) + "ms";
    els.rtt.textContent = S.netRtt == null ? "–" : S.netRtt.toFixed(0) + "ms";
    els.up.textContent = upstream() == null ? "–" : upstream().toFixed(0) + "ms";
    els.n.textContent = S.est ? `${S.est.n}/${S.est.total}` : "–";
    els.st.innerHTML = S.est
      ? `내 시계보다 <b>${Math.abs(S.est.mid).toFixed(0)}ms ${S.est.mid >= 0 ? "빠름" : "느림"}</b>`
      : "동기화 중…";
    els.note.textContent = S.lastNote || "";

    els.lg.innerHTML = "";
    for (const c of [...S.clicks].reverse().slice(0, 6)) {
      const row = document.createElement("div");
      row.className = "r";
      row.innerHTML = `<span class="n" title="${c.label}">${c.label}</span>` +
        (c.arrivalServer == null
          ? `<span class="w">${c.via}</span>`
          : `<span class="t">${fmt(c.arrivalServer)}</span>`);
      els.lg.appendChild(row);
    }
  }

  function tick() {
    if (!S.running) return;
    const now = serverNow();
    if (now != null && els.clk) {
      const d = new Date(now);
      els.clk.innerHTML = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` +
                          `<span class="ms">.${p3(d.getMilliseconds())}</span>`;
    }
    requestAnimationFrame(tick);
  }

  /* ================= 시작 ================= */
  buildHud();
  restorePreviousClick();
  window.addEventListener("click", onClick, true);
  document.addEventListener("submit", ev => { if (!pendingClick) onClick(ev); }, true);
  loop();
  tick();
  setInterval(render, 500);

  window.__serverTimeOverlay = {
    state: S,
    now: serverNow,
    error: totalErr,
    toggle: () => { hud.style.display = hud.style.display === "none" ? "" : "none"; },
    stop: () => { S.running = false; hud.remove(); window.__serverTimeOverlay = null; },
  };
  console.log("[서버시간] 오버레이 시작. window.__serverTimeOverlay.now() 로 서버 시각(ms)을 얻을 수 있습니다.");
})();
