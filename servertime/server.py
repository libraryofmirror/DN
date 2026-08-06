#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""서버시간 측정용 로컬 프록시 겸 정적 파일 서버.

브라우저는 CORS 때문에 다른 도메인 응답의 Date 헤더를 읽을 수 없다.
이 서버가 대신 대상 사이트로 HEAD(또는 GET) 요청을 보내고,
 - 요청을 보낸 시각(t0)
 - 응답 헤더를 다 받은 시각(t1)
 - 응답의 Date 헤더
를 그대로 돌려준다. 브라우저는 이 세 값으로 서버 시계와 내 시계의 차이를 좁혀 나간다.

  서버가 Date를 만든 순간은 반드시 [t0, t1] 사이에 있고,
  Date는 초 단위로 잘려 있으므로 실제 서버시간은 [Date, Date+1초) 안에 있다.
  => offset(= 서버시계 - 내시계) 은 (Date - t1, Date + 1000 - t0) 구간 안에 있다.

이 구간을 여러 번 교집합하면 오차가 왕복지연(RTT) 수준까지 줄어든다.

기본적으로 127.0.0.1 에만 바인딩된다(다른 기기에서 열지 못하게).
"""

from __future__ import annotations

import argparse
import email.utils
import http.client
import http.server
import json
import os
import ssl
import sys
import threading
import time
import urllib.parse
import webbrowser
from datetime import timezone
from functools import partial

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

MAX_REDIRECTS = 4
IDLE_LIMIT = 20.0          # keep-alive 연결을 재사용할 수 있는 최대 유휴 시간(초)
DEFAULT_TIMEOUT = 8.0
ALLOWED_METHODS = ("HEAD", "GET")   # 남의 사이트에 POST 를 대신 보내지는 않는다
USER_AGENT = "server-time-probe/1.0 (local measurement tool)"


def _safe_close(conn) -> None:
    try:
        conn.close()
    except Exception:
        pass


class ConnPool:
    """origin 별 keep-alive 연결 풀.

    실제 '신청' 버튼이 보내는 요청은 대부분 이미 열려 있는 연결을 쓴다.
    측정도 같은 조건이어야 하므로(TLS 핸드셰이크 제외) 연결을 재사용한다.
    """

    def __init__(self, insecure: bool = False) -> None:
        self._lock = threading.Lock()
        self._idle: dict[tuple, list] = {}
        self._ctx = ssl.create_default_context()
        if insecure:
            self._ctx.check_hostname = False
            self._ctx.verify_mode = ssl.CERT_NONE

    def acquire(self, origin: tuple, timeout: float):
        """(conn, reused, connect_ms) 반환."""
        scheme, host, port = origin
        now = time.time()
        with self._lock:
            bucket = self._idle.get(origin, [])
            while bucket:
                conn, last_used = bucket.pop()
                if now - last_used < IDLE_LIMIT:
                    self._idle[origin] = bucket
                    return conn, True, None
                _safe_close(conn)
            self._idle[origin] = bucket

        if scheme == "https":
            conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=self._ctx)
        else:
            conn = http.client.HTTPConnection(host, port, timeout=timeout)
        c0 = time.perf_counter()
        conn.connect()
        connect_ms = (time.perf_counter() - c0) * 1000.0
        return conn, False, connect_ms

    def release(self, origin: tuple, conn) -> None:
        with self._lock:
            self._idle.setdefault(origin, []).append((conn, time.time()))

    def close_all(self) -> None:
        with self._lock:
            for bucket in self._idle.values():
                for conn, _ in bucket:
                    _safe_close(conn)
            self._idle.clear()


class RateLimiter:
    """origin 당 초당 요청 수 제한(대상 사이트에 부담을 주지 않기 위한 안전장치)."""

    def __init__(self, rate: float = 10.0, burst: float = 10.0) -> None:
        self.rate = rate
        self.burst = burst
        self._lock = threading.Lock()
        self._state: dict[tuple, list] = {}

    def allow(self, origin: tuple) -> bool:
        now = time.monotonic()
        with self._lock:
            tokens, last = self._state.get(origin, (self.burst, now))
            tokens = min(self.burst, tokens + (now - last) * self.rate)
            if tokens < 1.0:
                self._state[origin] = (tokens, now)
                return False
            self._state[origin] = (tokens - 1.0, now)
            return True


POOL: ConnPool
LIMITER = RateLimiter()


def _parse_http_date(value: str | None) -> float | None:
    """HTTP-date 문자열 -> epoch milliseconds(초 단위로 잘려 있음)."""
    if not value:
        return None
    try:
        dt = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp() * 1000.0


def _split(url: str):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise ValueError("http / https 주소만 측정할 수 있습니다.")
    if not parts.hostname:
        raise ValueError("호스트가 없는 주소입니다.")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    origin = (parts.scheme, parts.hostname, port)
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    return origin, path


def _single_request(url: str, method: str, timeout: float, nocache: bool) -> dict:
    origin, path = _split(url)

    if not LIMITER.allow(origin):
        raise RuntimeError("요청이 너무 잦습니다(초당 10회 제한). 잠시 후 다시 시도하세요.")

    if nocache:
        # 중간 캐시가 오래된 Date 를 돌려주면 측정이 통째로 어긋난다.
        path += ("&" if "?" in path else "?") + "_st=" + str(int(time.time() * 1000))

    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-cache, no-store, max-age=0",
        "Pragma": "no-cache",
        "Connection": "keep-alive",
    }

    last_error: Exception | None = None
    for attempt in range(2):
        conn, reused, connect_ms = POOL.acquire(origin, timeout)
        try:
            t0 = time.time()
            p0 = time.perf_counter()
            conn.request(method, path, headers=headers)
            resp = conn.getresponse()          # 상태줄 + 헤더까지만 읽는다
            p1 = time.perf_counter()
            t1 = time.time()
            body = resp.read()                 # keep-alive 유지를 위해 본문은 비워 준다
        except Exception as exc:               # 재사용하던 연결이 이미 끊긴 경우
            _safe_close(conn)
            last_error = exc
            if reused and attempt == 0:
                continue
            raise
        else:
            if resp.will_close:
                _safe_close(conn)
            else:
                POOL.release(origin, conn)

            age = resp.getheader("Age")
            try:
                age_sec = int(age) if age is not None else None
            except ValueError:
                age_sec = None

            return {
                "url": url,
                "status": resp.status,
                "location": resp.getheader("Location"),
                "t0": t0 * 1000.0,
                "t1": t1 * 1000.0,
                "rttMs": (p1 - p0) * 1000.0,
                "connectMs": connect_ms,
                "reused": reused,
                "dateMs": _parse_http_date(resp.getheader("Date")),
                "dateRaw": resp.getheader("Date"),
                "ageSec": age_sec,
                "cacheStatus": resp.getheader("X-Cache") or resp.getheader("CF-Cache-Status"),
                "server": resp.getheader("Server"),
                "bodyBytes": len(body),
            }

    raise last_error or RuntimeError("요청 실패")


def probe(url: str, method: str = "HEAD", timeout: float = DEFAULT_TIMEOUT,
          nocache: bool = True, follow: bool = True) -> dict:
    """리다이렉트를 따라가며 최종 응답의 타이밍을 돌려준다."""
    current = url
    hops = 0
    while True:
        result = _single_request(current, method, timeout, nocache)
        loc = result.get("location")
        if follow and result["status"] in (301, 302, 303, 307, 308) and loc and hops < MAX_REDIRECTS:
            current = urllib.parse.urljoin(current, loc)
            hops += 1
            continue
        result["redirects"] = hops
        result["finalUrl"] = current
        result["ok"] = True
        return result


class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = "ServerTimeProbe/1.0"
    protocol_version = "HTTP/1.1"   # keep-alive (자기 자신을 대상으로 시험할 때도 조건이 같아진다)
    quiet = True

    def log_message(self, fmt, *args):  # noqa: A003
        if not self.quiet:
            super().log_message(fmt, *args)

    def _send_json(self, payload: dict, status: int = 200) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":       # HEAD 응답에 본문을 붙이면 keep-alive 프레이밍이 깨진다
            self.wfile.write(raw)

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/api/probe":
            self._handle_probe(urllib.parse.parse_qs(parsed.query))
            return
        if parsed.path == "/api/health":
            self._send_json({"ok": True, "nowMs": time.time() * 1000.0})
            return
        super().do_GET()

    def do_HEAD(self):  # noqa: N802
        # /api/* 는 HEAD 로도 응답한다(이 서버 자체를 측정 대상으로 삼아 시험할 수 있게).
        if urllib.parse.urlsplit(self.path).path.startswith("/api/"):
            self.do_GET()
            return
        super().do_HEAD()

    def _handle_probe(self, qs: dict) -> None:
        url = (qs.get("url") or [""])[0].strip()
        method = (qs.get("method") or ["HEAD"])[0].upper()
        nocache = (qs.get("nocache") or ["1"])[0] != "0"
        follow = (qs.get("follow") or ["1"])[0] != "0"

        if not url:
            self._send_json({"ok": False, "error": "url 파라미터가 필요합니다."})
            return
        if method not in ALLOWED_METHODS:
            self._send_json({"ok": False, "error": "HEAD 또는 GET 만 사용할 수 있습니다."})
            return
        try:
            self._send_json(probe(url, method=method, nocache=nocache, follow=follow))
        except Exception as exc:
            self._send_json({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="서버시간 측정 로컬 서버")
    ap.add_argument("-p", "--port", type=int, default=8765, help="포트 (기본 8765)")
    ap.add_argument("--host", default="127.0.0.1", help="바인딩 주소 (기본 127.0.0.1)")
    ap.add_argument("--insecure", action="store_true", help="TLS 인증서 검증 생략(사내망 등)")
    ap.add_argument("--open", action="store_true", help="브라우저 자동 실행")
    ap.add_argument("-v", "--verbose", action="store_true", help="접속 로그 출력")
    args = ap.parse_args(argv)

    global POOL
    POOL = ConnPool(insecure=args.insecure)

    handler = partial(Handler, directory=BASE_DIR)
    Handler.quiet = not args.verbose

    httpd = http.server.ThreadingHTTPServer((args.host, args.port), handler)
    httpd.daemon_threads = True

    url = f"http://{args.host}:{args.port}/"
    print(f"서버시간 측정기 실행 중 → {url}")
    print("종료하려면 Ctrl+C")
    if args.open:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")
    finally:
        httpd.server_close()
        POOL.close_all()
    return 0


if __name__ == "__main__":
    sys.exit(main())
