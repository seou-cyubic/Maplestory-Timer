"""Static server for Astra Web.

Plain http.server lets the browser hold on to a cached copy of the app's
scripts, so an edit does not show up on reload. Everything here is served
with no-store; the ONNX models are the only thing worth caching and they
never change, so they keep a long max-age.
"""
import argparse
import functools
import json
import re
import http.server
import socketserver
import sys
from pathlib import Path

# 모델만 오래 캐시한다.
#
# 예전에는 이미지도 하루씩 캐시했다. 그런데 아이콘 템플릿과 표본 캡처는 개발
# 중에 바뀌는 파일이고, 브라우저가 옛 판을 들고 있으면 **시험이 거짓말을 한다**
# (2026-09-07: U20.png 를 고쳐 놓고도 selftest 가 계속 옛 판을 보고 실패했다.
# 디스크와 서버 응답은 새 파일이었다). 모델(.onnx)은 수십 MB인 데다 바뀌지
# 않으므로 그대로 둔다.
CACHEABLE = ('.onnx',)
PNG_MAGIC = bytes([137, 80, 78, 71, 13, 10, 26, 10])


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files, plus one write endpoint used to harvest real game frames.

    POST /_capture?name=<slug>[&dir=<slug>] saves the request body as
    assets/samples/[<dir>/]<slug>.png. The observer page uses it to hand a
    frame of the shared MapleStory window to the analysis work, so the glyph
    atlases can be built from true-colour captures instead of the washed-out
    icon templates. `dir` exists for session recordings, which write ~1800
    files and should not be scattered among the hand-picked references.

    POST /_manifest?name=<slug>[&dir=<slug>] saves a JSON index next to them.

    Deliberately narrow: bound to 127.0.0.1 like the rest of the server, PNG
    magic bytes (or parseable JSON) required, every name restricted to a slug,
    fixed output directory with at most one level below it, size capped. It
    writes nowhere else.
    """

    CAPTURE_DIR = 'assets/samples'
    MAX_CAPTURE = 12 * 1024 * 1024
    MAX_MANIFEST = 32 * 1024 * 1024
    SLUG = r'[A-Za-z0-9_\-]{1,64}'

    def _slug(self, query, key, required=True):
        """One slug-valued query parameter, or None."""
        for part in query.split('&'):
            if part.startswith(key + '='):
                v = part[len(key) + 1:]
                return v if re.fullmatch(self.SLUG, v or '') else False
        return None if not required else False

    def _out_dir(self, query):
        """assets/samples, optionally one slug-named subdirectory below it.

        A session recording writes ~1800 files, so it gets its own folder
        instead of scattering them among the hand-picked references.
        """
        root = Path(self.directory)
        base = root / self.CAPTURE_DIR
        sub = self._slug(query, 'dir', required=False)
        if sub is False:
            return None, None
        out = base / sub if sub else base
        out.mkdir(parents=True, exist_ok=True)
        # 고정 디렉터리 밖으로는 절대 쓰지 않는다.
        if base.resolve() not in out.resolve().parents and out.resolve() != base.resolve():
            return None, None
        return root, out

    def _reply(self, obj):
        msg = json.dumps(obj).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(msg)))
        self.end_headers()
        self.wfile.write(msg)

    def _body(self, limit):
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if length <= 0 or length > limit:
            return None
        return self.rfile.read(length)

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        query = self.path.split('?', 1)[1] if '?' in self.path else ''
        if path == '/_capture':
            self._do_capture(query)
        elif path == '/_manifest':
            self._do_manifest(query)
        else:
            self.send_error(404, 'not found')

    def _do_capture(self, query):
        name = self._slug(query, 'name')
        if not name:
            self.send_error(400, 'bad name')
            return
        body = self._body(self.MAX_CAPTURE)
        if body is None:
            self.send_error(413, 'bad length')
            return
        if body[:8] != PNG_MAGIC:
            self.send_error(415, 'png only')
            return
        root, out_dir = self._out_dir(query)
        if out_dir is None:
            self.send_error(400, 'bad dir')
            return
        out = out_dir / (name + '.png')
        out.write_bytes(body)
        rel = str(out.relative_to(root)).replace('\\', '/')
        self._reply({'saved': rel, 'bytes': len(body)})
        if not query.startswith('dir='):      # 한 장짜리 캡처만 로그로 남긴다
            print('  captured %s (%d bytes)' % (out.name, len(body)), file=sys.stderr)

    def _do_manifest(self, query):
        """The recording's index: frame list, region rects, live judgements.

        JSON only, same fixed directory, same slug rules as the frames.
        """
        name = self._slug(query, 'name')
        if not name:
            self.send_error(400, 'bad name')
            return
        body = self._body(self.MAX_MANIFEST)
        if body is None:
            self.send_error(413, 'bad length')
            return
        try:
            json.loads(body.decode('utf-8'))
        except Exception:
            self.send_error(415, 'json only')
            return
        root, out_dir = self._out_dir(query)
        if out_dir is None:
            self.send_error(400, 'bad dir')
            return
        out = out_dir / (name + '.json')
        out.write_bytes(body)
        rel = str(out.relative_to(root)).replace('\\', '/')
        self._reply({'saved': rel, 'bytes': len(body)})
        print('  manifest %s (%d bytes)' % (rel, len(body)), file=sys.stderr)

    def end_headers(self):
        path = self.path.split('?', 1)[0]
        if path.endswith(CACHEABLE):
            self.send_header('Cache-Control', 'public, max-age=86400')
        else:
            self.send_header('Cache-Control', 'no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '404' in (fmt % args):
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--root', default=str(Path(__file__).resolve().parent.parent))
    args = ap.parse_args()

    handler = functools.partial(Handler, directory=args.root)
    with Server(('127.0.0.1', args.port), handler) as httpd:
        print(f'  http://localhost:{args.port}/              관측 화면')
        print(f'  http://localhost:{args.port}/selftest.html  이식 검증')
        print('  종료: Ctrl+C', flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n중지됨')
            return 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
