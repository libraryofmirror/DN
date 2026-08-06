// UI 로직.
//
// 시각 계산 사슬:
//   서버 시각 = 브라우저 시각 + (헬퍼 - 브라우저 오프셋) + (서버 - 헬퍼 오프셋)
// 헬퍼는 보통 같은 PC(localhost)라 두 번째 항은 1ms 미만이지만, 다른 기기에서
// 열어도 맞도록 매 폴링마다 왕복시간을 재서 보정한다.

const $ = (sel) => document.querySelector(sel);
const hires = () => performance.timeOrigin + performance.now();

const S = {
  state: null,          // 헬퍼의 /api/state 응답
  helperOffset: null,   // 헬퍼시각 - 브라우저시각
  helperSamples: [],    // {offset, rtt}
  history: [],
  countdown: null,      // {targetMs, leadMs, fired:Set}
};

/* ---------- 포맷 ---------- */

const pad = (n, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0');

function fmtClock(epochMs, withMs = true) {
  const d = new Date(epochMs);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

const fmtMs = (v, digits = 1) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}ms`);
const fmtDur = (v, digits = 1) => (v == null ? '—' : `${v.toFixed(digits)}ms`);

/* ---------- 헬퍼 통신 ---------- */

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `요청 실패 (${res.status})`);
  return json;
}

async function pollState() {
  const b0 = hires();
  let json;
  try {
    json = await api('/api/state');
  } catch {
    return; // 헬퍼가 잠깐 멈춘 경우: 다음 폴링에서 회복
  }
  const b1 = hires();

  if (json.helperEpochMs != null) {
    // 헬퍼가 응답을 만든 순간은 [b0, b1] 사이 — 중점으로 근사
    S.helperSamples.push({ offset: json.helperEpochMs - (b0 + b1) / 2, rtt: b1 - b0 });
    if (S.helperSamples.length > 20) S.helperSamples.shift();
    // 왕복이 가장 짧았던 표본이 가장 대칭적이라 오차가 작다
    S.helperOffset = S.helperSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
  }

  S.state = json;
  renderStatus();
}

/* ---------- 서버 시각 ---------- */

function serverNow() {
  if (S.state?.offsetMs == null || S.helperOffset == null) return null;
  return hires() + S.helperOffset + S.state.offsetMs;
}

const oneWay = () => S.state?.oneWayMs ?? null;

/* ---------- 렌더 ---------- */

function chip(text, cls = '') {
  const el = document.createElement('span');
  el.className = `chip ${cls}`;
  el.textContent = text;
  return el;
}

function renderStatus() {
  const s = S.state;
  const chips = $('#status-chips');
  chips.replaceChildren();
  if (!s || !s.url) {
    chips.append(chip('대기 중'));
    return;
  }

  if (s.lastError) chips.append(chip(`오류: ${s.lastError}`, 'bad'));
  else if (s.offsetMs == null) chips.append(chip('동기화 중…', 'warn'));
  else if (s.syncing) chips.append(chip('정밀 조정 중', 'warn'));
  else chips.append(chip('동기화 완료', 'ok'));

  chips.append(chip(`요청 ${s.probeCount}회`));
  chips.append(chip(`유효 표본 ${s.clockSamples}`));
  if (s.lastStatus) chips.append(chip(`HTTP ${s.lastStatus}`, s.lastStatus < 400 ? '' : 'warn'));
  if (s.serverHeader) chips.append(chip(s.serverHeader.slice(0, 28)));
  if (s.failCount) chips.append(chip(`실패 ${s.failCount}`, 'warn'));

  const warn = $('#warnings');
  warn.replaceChildren();
  for (const w of s.warnings ?? []) {
    const d = document.createElement('div');
    d.textContent = w;
    warn.append(d);
  }

  $('#click-btn').disabled = s.offsetMs == null || clickBusy;
}

function renderClock() {
  const now = serverNow();
  const clock = $('#clock');
  const s = S.state;

  if (now == null) {
    clock.innerHTML = '--:--:--<span class="ms">.---</span>';
    $('#clock-sub').textContent = s?.url ? '동기화 중…' : '대상을 입력하면 동기화를 시작합니다';
  } else {
    const d = new Date(now);
    clock.innerHTML =
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
      `<span class="ms">.${pad(d.getMilliseconds(), 3)}</span>`;
    $('#clock-sub').textContent = `${s.url}  ·  ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  $('#stat-unc').textContent = s?.uncertaintyMs == null ? '—' : `±${s.uncertaintyMs.toFixed(1)}ms`;
  // 오프셋이 양수면 서버가 더 빠르다 = 내 PC가 그만큼 느리다
  $('#stat-drift').textContent = s?.offsetMs == null ? '—' : fmtMs(-s.offsetMs, 0);
  $('#stat-rtt').textContent =
    s?.latency?.min == null ? '—' : `${s.latency.min.toFixed(1)} / ${s.latency.p50.toFixed(1)}ms`;
  $('#stat-oneway').textContent = oneWay() == null ? '—' : `~${oneWay().toFixed(1)}ms`;

  renderCountdown(now);
  requestAnimationFrame(renderClock);
}

/* ---------- 클릭 테스트 ---------- */

let clickBusy = false;

async function runClickTest() {
  const clickAtServer = serverNow();
  if (clickAtServer == null || clickBusy) return; // 연타/키반복으로 요청이 겹치지 않게
  clickBusy = true;
  $('#click-btn').disabled = true;

  const lead = oneWay() ?? 0;
  const unc = S.state?.uncertaintyMs ?? 0;
  const expectedArrival = clickAtServer + lead;

  const result = $('#click-result');
  const rows = [
    ['클릭한 순간의 서버 시각', fmtClock(clickAtServer), false],
    ['서버 도달 예상 시각', fmtClock(expectedArrival), true],
    ['편도 지연 / 추정 오차', `${fmtDur(lead)} · ±${unc.toFixed(1)}ms`, false],
    ['실측 검증', '요청 중…', false],
  ];
  result.replaceChildren(...rows.map(([k, v, big]) => kv(k, v, big)));

  let measured = null;
  try {
    const r = await api('/api/click', { at: clickAtServer });
    if (r.ok) {
      measured = r;
      const sec = fmtClock(r.serverSecondMs, false);
      const arrival = r.arrivalServerMs;
      const inWindow = arrival >= r.serverSecondMs && arrival < r.serverSecondMs + 1000;
      result.lastElementChild.replaceWith(
        kv(
          '실측 검증 (직후 보낸 실제 요청)',
          `도달 ${fmtClock(arrival)} · 응답 Date ${sec} ${inWindow ? '✓ 일치' : '⚠ 불일치'}`,
          false,
        ),
      );
    } else {
      result.lastElementChild.replaceWith(kv('실측 검증', `실패: ${r.error}`, false));
    }
  } catch (err) {
    result.lastElementChild.replaceWith(kv('실측 검증', `실패: ${err.message}`, false));
  } finally {
    clickBusy = false;
    $('#click-btn').disabled = serverNow() == null;
  }

  S.history.unshift({
    clickAtServer,
    expectedArrival,
    lead,
    measuredDate: measured ? fmtClock(measured.serverSecondMs, false) : '—',
  });
  S.history = S.history.slice(0, 12);
  renderHistory();
}

function kv(k, v, big) {
  const el = document.createElement('div');
  el.className = 'kv';
  const a = document.createElement('span');
  a.textContent = k;
  const b = document.createElement('span');
  if (big) b.className = 'big';
  b.textContent = v;
  el.append(a, b);
  return el;
}

function renderHistory() {
  const table = $('#history');
  const tbody = table.querySelector('tbody');
  tbody.replaceChildren();
  S.history.forEach((h, i) => {
    const tr = document.createElement('tr');
    for (const text of [
      String(S.history.length - i),
      fmtClock(h.clickAtServer),
      fmtClock(h.expectedArrival),
      fmtDur(h.lead),
      h.measuredDate,
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    tbody.append(tr);
  });
  table.classList.toggle('hidden', S.history.length === 0);
}

/* ---------- 소리 ---------- */

let audioCtx = null;
function beep(freq = 880, ms = 60, gain = 0.12) {
  if (!$('#sound-toggle').checked) return;
  audioCtx ??= new (window.AudioContext ?? window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.frequency.value = freq;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + ms / 1000);
}

/* ---------- 카운트다운 ---------- */

function parseTargetTime(text, nowMs) {
  const m = String(text).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?$/);
  if (!m) throw new Error('시각 형식은 HH:MM:SS.mmm 입니다');
  const [, hh, mm, ss = '0', frac = '0'] = m;
  const d = new Date(nowMs);
  d.setHours(Number(hh), Number(mm), Number(ss), Number(frac.padEnd(3, '0')));
  // 이미 지난 시각이면 내일로 해석
  return d.getTime() <= nowMs ? d.getTime() + 86400000 : d.getTime();
}

function startCountdown() {
  const now = serverNow();
  if (now == null) {
    alert('먼저 동기화를 완료해 주세요.');
    return;
  }
  try {
    const targetMs = parseTargetTime($('#target-time').value, now);
    const extra = Number($('#lead-extra').value) || 0;
    S.countdown = { targetMs, leadExtra: extra, fired: new Set() };
    $('#countdown').classList.remove('hidden');
    $('#countdown-stop').classList.remove('hidden');
    beep(660, 40);
  } catch (err) {
    alert(err.message);
  }
}

function stopCountdown() {
  S.countdown = null;
  $('#countdown').classList.add('hidden');
  $('#countdown-stop').classList.add('hidden');
}

function renderCountdown(now) {
  const cd = S.countdown;
  if (!cd || now == null) return;

  const lead = (oneWay() ?? 0) + cd.leadExtra;
  const clickAt = cd.targetMs - lead;
  const remain = clickAt - now;
  const box = $('#countdown');

  // 남은 초마다 신호음 (5,4,3,2,1 → 0)
  for (const mark of [5, 4, 3, 2, 1]) {
    if (remain <= mark * 1000 && remain > (mark - 1) * 1000 && !cd.fired.has(mark)) {
      cd.fired.add(mark);
      beep(700, 50);
    }
  }
  if (remain <= 0 && !cd.fired.has(0)) {
    cd.fired.add(0);
    beep(1320, 220, 0.2);
  }

  box.classList.toggle('armed', remain > 0 && remain <= 5000);
  box.classList.toggle('fire', remain <= 0 && remain > -3000);

  if (remain > 0) {
    $('#cd-value').textContent =
      remain >= 60000
        ? `${pad(remain / 60000)}:${pad((remain % 60000) / 1000)}.${pad(remain % 1000, 3)}`
        : `${(remain / 1000).toFixed(2)}s`;
    $('#cd-label').textContent = '클릭까지 남은 시간';
  } else if (remain > -3000) {
    $('#cd-value').textContent = '지금!';
    $('#cd-label').textContent = '클릭';
  } else {
    $('#cd-value').textContent = `+${(-remain / 1000).toFixed(2)}s`;
    $('#cd-label').textContent = '클릭 시점 경과';
  }

  $('#cd-detail').textContent =
    `목표 ${fmtClock(cd.targetMs)} · 권장 클릭 ${fmtClock(clickAt)} ` +
    `(편도 ${fmtDur(oneWay() ?? 0)}${cd.leadExtra ? ` + 여유 ${cd.leadExtra}ms` : ''} 선행)`;
}

/* ---------- 이벤트 ---------- */

$('#target-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#url-input').value.trim();
  if (!url) return;
  localStorage.setItem('server-time:url', url);
  S.history = [];
  renderHistory();
  $('#click-result').replaceChildren();
  try {
    S.state = await api('/api/target', { url });
    renderStatus();
  } catch (err) {
    alert(err.message);
  }
});

$('#resync-btn').addEventListener('click', async () => {
  try {
    S.state = await api('/api/resync', { hard: true });
    renderStatus();
  } catch (err) {
    alert(err.message);
  }
});

$('#click-btn').addEventListener('click', runClickTest);
$('#countdown-btn').addEventListener('click', startCountdown);
$('#countdown-stop').addEventListener('click', stopCountdown);

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || e.target.matches('input, button, textarea')) return;
  e.preventDefault();
  if (!$('#click-btn').disabled) runClickTest();
});

/* ---------- 시작 ---------- */

(async function init() {
  try {
    S.state = await api('/api/state');
  } catch {
    /* 헬퍼 준비 전 */
  }
  $('#url-input').value = S.state?.url ?? localStorage.getItem('server-time:url') ?? '';
  renderStatus();
  setInterval(pollState, 1000);
  pollState();
  requestAnimationFrame(renderClock);
})();
