#!/usr/bin/env node
// 자체 검증: 시각을 일부러 틀어놓은 가짜 서버를 띄우고,
// 추정한 오프셋이 실제로 틀어놓은 값과 맞는지 확인한다.
//
//   node test/clock.test.mjs

import http from 'node:http';
import assert from 'node:assert/strict';
import { ServerTimeTracker } from '../lib/probe.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 서버 시계를 FAKE_OFFSET 만큼 틀어놓고, 응답에 인위적 지연을 넣는다 */
function startFakeServer({ fakeOffsetMs, delayMs, jitterMs }) {
  const server = http.createServer(async (req, res) => {
    await sleep(delayMs + Math.random() * jitterMs);
    // Date 헤더는 초 단위로 버림되어 나간다 (실제 HTTP와 동일)
    res.setHeader('Date', new Date(Date.now() + fakeOffsetMs).toUTCString());
    res.writeHead(200, { 'content-length': 0 });
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function run(name, { fakeOffsetMs, delayMs, jitterMs, tolerance, seconds = 4, opts = {} }) {
  const { server, port } = await startFakeServer({ fakeOffsetMs, delayMs, jitterMs });
  const tracker = new ServerTimeTracker(`http://127.0.0.1:${port}/`, {
    burstIntervalMs: 25,
    targetUncertaintyMs: 5,
    maxBurstProbes: 200,
    ...opts,
  }).start();

  await sleep(seconds * 1000);
  const s = tracker.state();
  tracker.stop();
  server.close();

  const err = s.offsetMs - fakeOffsetMs;
  console.log(
    `${name}\n` +
      `  실제 오프셋 ${fakeOffsetMs}ms / 추정 ${s.offsetMs?.toFixed(1)}ms  → 오차 ${err.toFixed(1)}ms\n` +
      `  보고된 불확실도 ±${s.uncertaintyMs?.toFixed(1)}ms, 표본 ${s.clockSamples}, 요청 ${s.probeCount}회, ` +
      `RTT min ${s.latency.min?.toFixed(1)}ms\n`,
  );

  // 1) 추정값이 실제와 충분히 가까울 것
  assert.ok(Math.abs(err) <= tolerance, `오차 ${err.toFixed(1)}ms 가 허용치 ${tolerance}ms 초과`);
  // 2) 보고하는 불확실도가 실제 오차를 덮을 것 (거짓 정밀도 금지)
  assert.ok(
    Math.abs(err) <= s.uncertaintyMs + 1,
    `실제 오차(${err.toFixed(1)}ms)가 보고된 ±${s.uncertaintyMs.toFixed(1)}ms 를 벗어남`,
  );
}

await run('빠른 회선 (지연 5ms)', { fakeOffsetMs: 1234, delayMs: 5, jitterMs: 3, tolerance: 15 });
await run('느린 회선 (지연 60ms, 지터 40ms)', { fakeOffsetMs: -3456, delayMs: 60, jitterMs: 40, tolerance: 60 });
await run('음수 오프셋 (서버가 느림)', { fakeOffsetMs: -777, delayMs: 10, jitterMs: 5, tolerance: 20 });

// 기본 설정 그대로: 초기 버스트 후 "초 경계 저격"으로 정밀도를 유지하는지
await run('기본 설정 (경계 저격 포함)', {
  fakeOffsetMs: 421,
  delayMs: 15,
  jitterMs: 10,
  tolerance: 40,
  seconds: 14,
  opts: { burstIntervalMs: undefined, targetUncertaintyMs: undefined, maxBurstProbes: undefined, minIdleGapMs: 3000 },
});

console.log('모든 검증 통과');
