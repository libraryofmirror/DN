#!/usr/bin/env node
// 터미널용 서버시계. 브라우저 UI 없이 서버 시각과 지연만 빠르게 보고 싶을 때.
//
//   node cli.mjs https://example.com
//   node cli.mjs https://example.com --method GET
//
// 표시되는 값
//   서버 시각   : Date 헤더를 구간교차로 좁혀 추정한 현재 서버 시각(밀리초)
//   ±           : 추정 오차 한계
//   내 PC 차이  : 내 컴퓨터 시계가 서버보다 얼마나 빠른지(+)/느린지(-)
//   RTT         : 왕복 지연 (최소 / 중앙값)
//   편도        : 클릭 신호가 서버까지 가는 데 걸리는 시간 추정 = 최소RTT / 2

import { ServerTimeTracker } from './lib/probe.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const url = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

if (!url) {
  console.error('사용법: node cli.mjs <URL> [--method HEAD|GET]');
  process.exit(1);
}

const pad = (n, w = 2) => String(Math.trunc(n)).padStart(w, '0');
const fmtClock = (epochMs) => {
  const d = new Date(epochMs);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};
const fmtMs = (v, digits = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}ms`);

const tracker = new ServerTimeTracker(/^https?:\/\//i.test(url) ? url : `https://${url}`, {
  method: String(flag('method', 'HEAD')).toUpperCase(),
}).start();

console.log(`측정 대상: ${tracker.url} (${tracker.method})   중단: Ctrl+C\n`);

const render = () => {
  const s = tracker.state();
  const now = tracker.serverNow();

  if (now == null) {
    const msg = s.lastError ? `오류: ${s.lastError}` : '동기화 중…';
    process.stdout.write(`\r  ${msg}   (요청 ${s.probeCount}회)          `);
    return;
  }

  const drift = -s.offsetMs; // 내 PC 시계가 서버보다 빠른 정도
  const line =
    `  ${fmtClock(now)}  ±${s.uncertaintyMs.toFixed(1)}ms` +
    `   내PC ${fmtMs(drift, 0)}` +
    `   RTT ${s.latency.min?.toFixed(1)}/${s.latency.p50?.toFixed(1)}ms` +
    `   편도 ~${s.oneWayMs?.toFixed(1)}ms` +
    `   표본 ${s.clockSamples}${s.syncing ? ' (조정중)' : ''}`;
  process.stdout.write(`\r${line.padEnd(110)}`);
};

const timer = setInterval(render, 47);

process.on('SIGINT', () => {
  clearInterval(timer);
  tracker.stop();
  const s = tracker.state();
  console.log('\n');
  if (s.offsetMs != null) {
    console.log(`  최종 오프셋: ${fmtMs(s.offsetMs, 1)} (서버 - 내PC), 오차 ±${s.uncertaintyMs.toFixed(1)}ms`);
    console.log(`  편도 지연 추정: ${s.oneWayMs?.toFixed(1)}ms  → 목표 시각보다 이만큼 먼저 눌러야 정각에 도달`);
  }
  process.exit(0);
});
