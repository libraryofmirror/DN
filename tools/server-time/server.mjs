#!/usr/bin/env node
// 로컬 헬퍼 서버.
//
// 브라우저에서 다른 사이트로 직접 요청하면 CORS 때문에 Date 헤더를 읽을 수 없다.
// 그래서 실제 측정은 이 Node 프로세스가 하고, UI는 여기서 서빙한다.
// 측정이 사용자의 회선에서 이루어지므로 지연 값도 실제 상황과 같다.
//
//   node server.mjs [대상URL] [--port 8787] [--method HEAD|GET]
//
// 보안상 기본으로 127.0.0.1에만 바인딩한다 (외부에 열면 임의 URL을 대신
// 요청해 주는 프록시가 되어버린다).

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerTimeTracker, probeOnce, hiresNow } from './lib/probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

const PORT = Number(flag('port', process.env.PORT ?? 8787));
const HOST = flag('host', process.env.HOST ?? '127.0.0.1');
const METHOD = String(flag('method', 'HEAD')).toUpperCase();
const INITIAL_URL = positional[0] ?? null;

/** @type {ServerTimeTracker | null} */
let tracker = null;

function normalizeUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('URL을 입력해 주세요');
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if (hasScheme && !/^https?:\/\//i.test(value)) {
    throw new Error('http/https 주소만 측정할 수 있습니다');
  }
  const url = new URL(hasScheme ? value : `https://${value}`); // 형식 오류면 여기서 throw
  if (!url.hostname) throw new Error('호스트가 없는 주소입니다');
  return url.toString();
}

function setTarget(rawUrl, method = METHOD) {
  const url = normalizeUrl(rawUrl);
  if (tracker) tracker.stop();
  tracker = new ServerTimeTracker(url, { method }).start();
  return tracker;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}

async function sendStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  // 경로 탈출 방지
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new Error('요청 본문이 너무 큽니다'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('JSON 파싱 실패'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (pathname === '/api/state') {
      return sendJson(res, 200, tracker ? tracker.state() : { url: null, running: false, helperEpochMs: hiresNow() });
    }

    if (pathname === '/api/target' && req.method === 'POST') {
      const body = await readBody(req);
      const t = setTarget(body.url, (body.method ?? METHOD).toUpperCase());
      return sendJson(res, 200, t.state());
    }

    if (pathname === '/api/resync' && req.method === 'POST') {
      if (!tracker) return sendJson(res, 400, { error: '측정 대상이 설정되지 않았습니다' });
      const body = await readBody(req).catch(() => ({}));
      tracker.resync({ hard: Boolean(body.hard) });
      return sendJson(res, 200, tracker.state());
    }

    // 클릭 순간에 실제 요청을 한 번 날려서 "이 요청이 서버에 닿은 시각"을 실측한다.
    if (pathname === '/api/click' && req.method === 'POST') {
      if (!tracker) return sendJson(res, 400, { error: '측정 대상이 설정되지 않았습니다' });

      const est = tracker.clock.estimate();
      const oneWay = tracker.oneWayMs();
      const p = await probeOnce(tracker.url, { method: tracker.method });
      tracker.ingest(p);

      if (!p.ok) return sendJson(res, 200, { ok: false, error: p.error, rtt: p.rtt });

      // 요청이 서버에 도달한 로컬 시각 ≈ 보낸 시각 + 편도 지연
      const arrivalLocal = p.t0 + (oneWay ?? p.rtt / 2);
      const offset = est?.offsetMs ?? null;

      return sendJson(res, 200, {
        ok: true,
        sentAtServerMs: offset == null ? null : p.t0 + offset,
        arrivalServerMs: offset == null ? null : arrivalLocal + offset,
        uncertaintyMs: est?.uncertaintyMs ?? null,
        oneWayMs: oneWay ?? p.rtt / 2,
        rtt: p.rtt,
        status: p.status,
        dateHeader: p.dateHeader,
        // 서버가 이 요청을 처리한 순간은 [dateMs, dateMs+1000) 안에 있었다 = 실측 검증값
        serverSecondMs: p.dateMs,
        cached: p.cached,
      });
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: '알 수 없는 API' });
    }

    return await sendStatic(res, pathname);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
});

if (INITIAL_URL) {
  try {
    setTarget(INITIAL_URL);
  } catch (err) {
    console.error(`대상 설정 실패: ${err.message}`);
    process.exit(1);
  }
}

server.listen(PORT, HOST, () => {
  console.log(`\n  서버시간 측정기  →  http://${HOST}:${PORT}`);
  if (tracker) console.log(`  측정 대상: ${tracker.url} (${tracker.method})`);
  else console.log('  브라우저에서 측정할 사이트 주소를 입력하세요.');
  console.log('  종료: Ctrl+C\n');
});

const shutdown = () => {
  tracker?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
