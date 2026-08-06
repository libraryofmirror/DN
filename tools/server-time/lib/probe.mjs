// 서버 시각 측정 코어.
//
// HTTP 응답의 Date 헤더는 초 단위(밀리초 없음)라서 그대로 쓰면 오차가 ±500ms다.
// 대신 요청 한 번에서 얻는 "부등식"을 여러 번 교집합해서 오프셋을 좁힌다.
//
//   t0 = 요청을 내보낸 로컬 시각, t1 = 응답 헤더를 받은 로컬 시각
//   서버가 Date를 찍은 순간 t_s 는 반드시 t0 <= t_s <= t1
//   Date 헤더 값 D 는 그 순간의 서버 시각을 초 단위로 버림한 값이므로
//   서버시각(t_s) ∈ [D, D + 1000)
//
//   offset = 서버시각 - 로컬시각 이라 하면
//   offset ∈ [D - t1, D + 1000 - t0)
//
// 요청을 촘촘히 반복하면 Date 값이 바뀌는 "초 경계"를 자연스럽게 끼고 있는
// 구간들이 쌓이고, 교집합의 폭은 대략 (요청 간격 + RTT) 수준까지 줄어든다.

import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';

/** 고해상도 epoch 밀리초 (시스템 시계 점프의 영향을 덜 받음) */
export const hiresNow = () => performance.timeOrigin + performance.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 2 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 2 }),
};

/**
 * 대상에 요청 한 번을 보내고 타이밍/Date 헤더를 회수한다.
 * 본문은 필요 없으므로 기본은 HEAD. (405가 와도 Date 헤더는 오므로 문제없다)
 */
export function probeOnce(rawUrl, { method = 'HEAD', timeoutMs = 8000 } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return Promise.resolve({ ok: false, error: 'URL 형식이 올바르지 않습니다', rtt: 0 });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.resolve({ ok: false, error: 'http/https 주소만 측정할 수 있습니다', rtt: 0 });
  }

  const mod = url.protocol === 'https:' ? https : http;
  const agent = agents[url.protocol];

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    const t0 = hiresNow();
    const req = mod.request(
      url,
      {
        method,
        agent,
        timeout: timeoutMs,
        headers: {
          'user-agent': 'server-time-probe/1.0 (+timing measurement)',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          accept: '*/*',
        },
      },
      (res) => {
        const t1 = hiresNow(); // 응답 헤더가 도착한 순간
        res.resume(); // 본문은 버리되 소켓은 재사용할 수 있게 비운다

        const dateHeader = res.headers['date'] ?? null;
        const dateMs = dateHeader ? Date.parse(dateHeader) : NaN;
        const age = Number(res.headers['age'] ?? 0);

        done({
          ok: Number.isFinite(dateMs),
          t0,
          t1,
          rtt: t1 - t0,
          status: res.statusCode,
          dateMs: Number.isFinite(dateMs) ? dateMs : null,
          dateHeader,
          // 캐시에서 나온 응답의 Date는 "생성 시각"이라 현재 시각이 아니다
          cached: Number.isFinite(age) && age > 0,
          server: res.headers['server'] ?? null,
          error: Number.isFinite(dateMs) ? null : 'Date 헤더가 없습니다',
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error('응답 시간 초과')));
    req.on('error', (err) => {
      const t1 = hiresNow();
      done({ ok: false, t0, t1, rtt: t1 - t0, dateMs: null, error: err.message });
    });
    req.end();
  });
}

/** 구간 교차로 서버-로컬 오프셋을 추정하는 시계 모델 */
export class ServerClock {
  constructor({ maxSamples = 600 } = {}) {
    this.maxSamples = maxSamples;
    this.samples = []; // 오래된 것 -> 최신 순
  }

  add({ t0, t1, dateMs }) {
    this.samples.push({ lo: dateMs - t1, hi: dateMs + 1000 - t0 });
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  reset() {
    this.samples = [];
  }

  /**
   * 최신 표본부터 거꾸로 교집합을 취한다.
   * 서버 시계가 조정되거나 로컬 시계가 튀어서 교집합이 비면 거기서 멈추므로
   * 과거의 잘못된 제약이 현재 추정을 오염시키지 않는다.
   */
  estimate() {
    if (this.samples.length === 0) return null;

    let lo = -Infinity;
    let hi = Infinity;
    let used = 0;

    for (let i = this.samples.length - 1; i >= 0; i--) {
      const s = this.samples[i];
      const nextLo = Math.max(lo, s.lo);
      const nextHi = Math.min(hi, s.hi);
      if (nextLo > nextHi) break; // 여기서부터는 현재와 모순되는 과거 표본
      lo = nextLo;
      hi = nextHi;
      used++;
    }

    // 유효한 표본만 남긴다 (모순된 과거는 버림)
    if (used < this.samples.length) {
      this.samples = this.samples.slice(this.samples.length - used);
    }

    return {
      offsetMs: (lo + hi) / 2,
      uncertaintyMs: (hi - lo) / 2,
      lo,
      hi,
      samples: used,
    };
  }
}

const quantile = (sortedArr, q) => {
  if (sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.round((sortedArr.length - 1) * q)));
  return sortedArr[idx];
};

/**
 * 대상 URL을 계속 측정하면서 서버 시계와 지연 통계를 유지한다.
 * 처음에는 촘촘히(버스트) 찔러 초 경계를 잡고, 정확도가 확보되면
 * 느린 주기로 전환해 서버에 부담을 주지 않는다.
 */
export class ServerTimeTracker {
  constructor(url, opts = {}) {
    this.url = url;
    this.method = opts.method ?? 'HEAD';
    this.burstIntervalMs = opts.burstIntervalMs ?? 45;
    this.targetUncertaintyMs = opts.targetUncertaintyMs ?? 25;
    this.maxBurstProbes = opts.maxBurstProbes ?? 60;
    // 정밀도 확보 후에는 다음 초 경계 부근만 노려서 찌른다
    this.boundaryProbes = opts.boundaryProbes ?? 10;
    this.minIdleGapMs = opts.minIdleGapMs ?? 8000;

    this.clock = new ServerClock();
    this.rtts = [];
    this.burstLeft = this.maxBurstProbes;
    this.windowLeft = 0;
    this.stopped = true;
    this.probeCount = 0;
    this.failCount = 0;
    this.lastProbe = null;
    this.lastError = null;
    this.warnings = [];
  }

  start() {
    if (!this.stopped) return this;
    this.stopped = false;
    this.#loop();
    return this;
  }

  stop() {
    this.stopped = true;
  }

  /** 초 경계를 다시 잡고 싶을 때 (네트워크 상태가 바뀐 경우 등) */
  resync({ hard = false } = {}) {
    if (hard) {
      this.clock.reset();
      this.rtts = [];
    }
    this.burstLeft = this.maxBurstProbes;
    this.windowLeft = 0;
  }

  /**
   * 다음 "초 경계 저격 창"까지 기다릴 시간.
   * Date 값이 바뀌는 순간을 사이에 끼고 있는 요청 쌍만이 오차를 좁혀 주므로,
   * 아무 때나 찌르는 대신 경계 직전에 깨어나 짧게 몰아 찌른다.
   */
  #msUntilBoundaryWindow(est) {
    const serverNow = hiresNow() + est.offsetMs;
    const margin = Math.min(500, est.uncertaintyMs + (this.latency().min ?? 100) + 20);
    let wait = 1000 - (serverNow % 1000) - margin;
    while (wait < this.minIdleGapMs) wait += 1000; // 너무 잦은 요청 방지
    return wait;
  }

  async #loop() {
    while (!this.stopped) {
      const p = await probeOnce(this.url, { method: this.method });
      this.ingest(p);

      const est = this.clock.estimate();
      if (!est) {
        await sleep(this.burstIntervalMs); // 아직 유효 표본 없음 (오류/캐시 응답)
        continue;
      }

      if (this.windowLeft > 0) {
        this.windowLeft--; // 경계 저격 중
        await sleep(this.burstIntervalMs);
        continue;
      }

      if (est.uncertaintyMs > this.targetUncertaintyMs && this.burstLeft > 0) {
        this.burstLeft--; // 초기 동기화
        await sleep(this.burstIntervalMs);
        continue;
      }

      this.windowLeft = this.boundaryProbes;
      await sleep(this.#msUntilBoundaryWindow(est));
    }
  }

  /** 외부(클릭 테스트 등)에서 얻은 측정도 시계에 반영할 수 있게 공개 */
  ingest(p) {
    this.probeCount++;
    this.lastProbe = p;

    if (!p.ok) {
      this.failCount++;
      this.lastError = p.error ?? '알 수 없는 오류';
      return p;
    }

    this.lastError = null;
    this.rtts.push(p.rtt);
    if (this.rtts.length > 100) this.rtts.shift();

    if (p.cached) {
      this.#warn('CDN/프록시 캐시 응답이 섞여 있습니다 (Age > 0). 해당 표본은 제외했습니다.');
      return p; // 캐시된 Date는 현재 시각이 아니므로 시계에 넣지 않는다
    }

    this.clock.add(p);
    return p;
  }

  #warn(msg) {
    if (!this.warnings.includes(msg)) {
      this.warnings.push(msg);
      if (this.warnings.length > 5) this.warnings.shift();
    }
  }

  latency() {
    if (this.rtts.length === 0) return { min: null, p50: null, last: null, samples: 0 };
    const sorted = [...this.rtts].sort((a, b) => a - b);
    return {
      min: sorted[0],
      p50: quantile(sorted, 0.5),
      last: this.rtts[this.rtts.length - 1],
      samples: this.rtts.length,
    };
  }

  /** 편도(업링크) 지연 추정. 최소 RTT의 절반 — 큐잉 노이즈가 가장 적은 값 */
  oneWayMs() {
    const l = this.latency();
    return l.min == null ? null : l.min / 2;
  }

  /** 지금 이 순간의 서버 시각(epoch ms). 아직 동기화 전이면 null */
  serverNow() {
    const est = this.clock.estimate();
    return est ? hiresNow() + est.offsetMs : null;
  }

  state() {
    const est = this.clock.estimate();
    return {
      url: this.url,
      method: this.method,
      running: !this.stopped,
      syncing: this.burstLeft > 0 && (!est || est.uncertaintyMs > this.targetUncertaintyMs),
      offsetMs: est?.offsetMs ?? null,
      uncertaintyMs: est?.uncertaintyMs ?? null,
      clockSamples: est?.samples ?? 0,
      probeCount: this.probeCount,
      failCount: this.failCount,
      latency: this.latency(),
      oneWayMs: this.oneWayMs(),
      serverHeader: this.lastProbe?.server ?? null,
      lastStatus: this.lastProbe?.status ?? null,
      lastDateHeader: this.lastProbe?.dateHeader ?? null,
      lastError: this.lastError,
      warnings: [...this.warnings],
      helperEpochMs: hiresNow(),
    };
  }
}
