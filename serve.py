"""コード読解リーダーを、このPCで動かすための小さなWebサーバー（Python標準ライブラリだけ）。

  python serve.py            … http://localhost:8765/ をブラウザで開く
  python serve.py --port 9000

同じWi-Fiにつながった iPad / Android からも、表示される「http://192.168.x.x:8765/」で開けます。
止めるときはこの画面で Ctrl+C（またはウィンドウを閉じる）。
"""
import argparse
import functools
import http.server
import os
import socket
import webbrowser

APP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # 実際には送信しない。どのLANアドレスを使うか調べるだけ
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # アクセスログは出さない


def main():
    ap = argparse.ArgumentParser(description="コード読解リーダーをローカルで動かす")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true", help="ブラウザを自動で開かない")
    ap.add_argument("--local-only", action="store_true", help="このPCからだけ開けるようにする（iPad等からは開けない）")
    args = ap.parse_args()

    host = "127.0.0.1" if args.local_only else "0.0.0.0"
    handler = functools.partial(Handler, directory=APP_DIR)
    server = http.server.ThreadingHTTPServer((host, args.port), handler)
    url = f"http://localhost:{args.port}/"
    print("コード読解リーダーを起動しました")
    print(f"  このPCで開く : {url}")
    ip = lan_ip()
    if ip and not args.local_only:
        print(f"  iPad/Androidで開く（同じWi-Fi）: http://{ip}:{args.port}/")
    print("止めるときは Ctrl+C（またはこのウィンドウを閉じる）")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了しました")


if __name__ == "__main__":
    main()
