#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Universal Translator - Desktop App
双击运行：内置服务（静态文件 + 翻译代理） + 内嵌窗口（pywebview），关窗口即退出。
前端资源位于 web/ 目录（开发模式：与脚本同级；打包后：_MEIPASS/web）。
"""
import base64
import functools
import hashlib
import http.server
import json
import os
import shutil
import socket
import socketserver
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
import webbrowser

from unpack.xp3 import Xp3Error, pack_bytes, unpack_bytes
from pdf import PdfError, extract_pdf, export_translated, export_html_pdf, start_ocr, ocr_status
from img import ImgError, ocr_image

APP_NAME = 'Universal Translator'
CANDIDATE_PORTS = (8123, 8000, 8124, 8125, 8130, 8888)

UNPACK_ROOT = None  # xp3 解包临时根目录（应用退出时清理）
MAX_XP3_SIZE = 300 * 1024 * 1024


def ensure_unpack_root():
    global UNPACK_ROOT
    if UNPACK_ROOT is None:
        UNPACK_ROOT = tempfile.mkdtemp(prefix='ut_xp3_')
    return UNPACK_ROOT


def clean_unpack_root():
    global UNPACK_ROOT
    if UNPACK_ROOT and os.path.isdir(UNPACK_ROOT):
        shutil.rmtree(UNPACK_ROOT, ignore_errors=True)
        UNPACK_ROOT = None


PDF_ROOT = None  # PDF 解析临时根目录（应用退出时清理）


def ensure_pdf_root():
    global PDF_ROOT
    if PDF_ROOT is None:
        PDF_ROOT = tempfile.mkdtemp(prefix='ut_pdf_')
    return PDF_ROOT


def clean_pdf_root():
    global PDF_ROOT
    if PDF_ROOT and os.path.isdir(PDF_ROOT):
        shutil.rmtree(PDF_ROOT, ignore_errors=True)
        PDF_ROOT = None


def safe_join(base, rel):
    """把 rel 安全地拼到 base 下（防目录穿越）"""
    base_real = os.path.realpath(base)
    p = os.path.realpath(os.path.join(base_real, rel.replace('\\', os.sep)))
    if not p.startswith(base_real + os.sep) and p != base_real:
        return None
    return p


def get_web_root():
    if getattr(sys, 'frozen', False):
        base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
        web = os.path.join(base, 'web')
        return web if os.path.isdir(web) else base
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web')


def _ocr_log(msg):
    """图片 OCR 请求日志（诊断用）：写到临时目录 ut_img_ocr.log。

    前端报 Failed to fetch 时，翻这个日志就能分清：
    请求根本没到（没有 recv 行） = 浏览器/网络层问题
    有 recv 但没有 ok 行          = 服务端处理中挂了
    """
    try:
        path = os.path.join(tempfile.gettempdir(), 'ut_img_ocr.log')
        with open(path, 'a', encoding='utf-8') as f:
            f.write('%s %s\n' % (time.strftime('%H:%M:%S'), msg))
    except Exception:
        pass


def find_free_port():
    for port in CANDIDATE_PORTS:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(('127.0.0.1', port))
            return port
        except OSError:
            pass
        finally:
            s.close()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def baidu_translate(texts, settings):
    appid = (settings.get('baiduAppid') or '').strip()
    key = (settings.get('apiKey') or '').strip()
    if not appid or not key:
        raise RuntimeError('请先填写百度 APP ID 和密钥（右上角设置）')
    lang = {'zh-CN': 'zh', 'zh-TW': 'cht', 'en': 'en', 'ja': 'jp'}.get(settings.get('targetLang', 'zh-CN'), 'zh')
    results = []
    for i in range(0, len(texts), 5):
        batch = texts[i:i + 5]
        q = '\n'.join(batch)
        salt = str(int(time.time() * 1000))
        sign = hashlib.md5((appid + q + salt + key).encode('utf-8')).hexdigest()
        params = urllib.parse.urlencode({'q': q, 'from': 'auto', 'to': lang, 'appid': appid, 'salt': salt, 'sign': sign})
        url = 'https://fanyi-api.baidu.com/api/trans/vip/translate?' + params
        with urllib.request.urlopen(url, timeout=20) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        if data.get('error_code'):
            raise RuntimeError('百度 ' + str(data['error_code']) + ' ' + str(data.get('error_msg', '')))
        results.extend(x['dst'] for x in data.get('trans_result', []))
    return results


def deepl_translate(texts, settings):
    key = (settings.get('apiKey') or '').strip()
    if not key:
        raise RuntimeError('请先填写 DeepL API Key（右上角设置）')
    target = {'zh-CN': 'ZH-HANS', 'zh-TW': 'ZH-HANT', 'en': 'EN-US', 'ja': 'JA'}.get(settings.get('targetLang', 'zh-CN'), 'ZH-HANS')
    body = urllib.parse.urlencode([('target_lang', target)] + [('text', t) for t in texts]).encode('utf-8')
    req = urllib.request.Request('https://api-free.deepl.com/v2/translate', data=body,
                                 headers={'Authorization': 'DeepL-Auth-Key ' + key})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    return [x['text'] for x in data.get('translations', [])]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=(directory or get_web_root()), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        if self.path.startswith('/api/unpack-file?'):
            self._handle_unpack_file()
            return
        if self.path.startswith('/api/pdf/ocr/status?'):
            self._handle_pdf_ocr_status()
            return
        super().do_GET()

    def do_POST(self):
        if self.path == '/api/translate':
            self._handle_translate()
        elif self.path == '/api/encode':
            self._handle_encode()
        elif self.path == '/api/unpack':
            self._handle_unpack()
        elif self.path == '/api/pack':
            self._handle_pack()
        elif self.path == '/api/pdf/extract':
            self._handle_pdf_extract()
        elif self.path == '/api/pdf/export':
            self._handle_pdf_export()
        elif self.path == '/api/doc/export':
            self._handle_doc_export()
        elif self.path == '/api/pdf/ocr':
            self._handle_pdf_ocr()
        elif self.path == '/api/img/ocr':
            self._handle_img_ocr()
        elif self.path == '/api/open-url':
            self._handle_open_url()
        else:
            self.send_error(404, 'Not Found')

    def _handle_unpack(self):
        # 接收 xp3 文件字节 → 解包到临时目录 → 返回文件清单
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length <= 0:
                raise RuntimeError('未收到文件内容')
            if length > MAX_XP3_SIZE:
                raise RuntimeError('xp3 文件过大（>%dMB），暂不支持' % (MAX_XP3_SIZE // 1024 // 1024))
            data = self.rfile.read(length)
            temp_id = uuid.uuid4().hex[:8]
            out_dir = os.path.join(ensure_unpack_root(), temp_id)
            os.makedirs(out_dir)
            files = unpack_bytes(data, out_dir)
            self._json({'ok': True, 'tempId': temp_id, 'files': files})
        except Xp3Error as e:
            self._json({'ok': False, 'error': str(e)}, 502)
        except Exception as e:
            self._json({'ok': False, 'error': str(e)}, 502)

    def _handle_unpack_file(self):
        # 读取解包出的单个文件（二进制）
        try:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            temp_id = (q.get('tempId') or [''])[0]
            rel = (q.get('rel') or [''])[0]
            if not temp_id or not rel:
                self.send_error(400, 'Bad Request')
                return
            base = os.path.join(ensure_unpack_root(), temp_id)
            p = safe_join(base, rel)
            if not p:
                self.send_error(403, 'Forbidden')
                return
            if not os.path.isfile(p):
                self.send_error(404, 'Not Found')
                return
            with open(p, 'rb') as f:
                body = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self._json({'ok': False, 'error': str(e)}, 502)

    def _handle_pack(self):
        # 接收修改后的文件字节 → 合并解包内容 → 重新封包 → 返回新 xp3 二进制
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8'))
            temp_id = body.get('tempId') or ''
            modified = body.get('files') or {}  # {rel: base64}
            base = os.path.join(ensure_unpack_root(), temp_id)
            if not temp_id or not os.path.isdir(base):
                raise RuntimeError('解包会话不存在或已过期，请重新解包')
            all_files = {}
            for root, _dirs, fnames in os.walk(base):
                for fn in fnames:
                    fp = os.path.join(root, fn)
                    rel = os.path.relpath(fp, base).replace(os.sep, '/')
                    with open(fp, 'rb') as f:
                        all_files[rel] = f.read()
            for rel, b64 in modified.items():
                if not safe_join(base, rel):
                    raise RuntimeError('非法路径: ' + rel)
                all_files[rel] = base64.b64decode(b64)
            blob = pack_bytes(all_files)
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Content-Disposition', 'attachment; filename="translated.xp3"')
            self.send_header('Content-Length', str(len(blob)))
            self.end_headers()
            self.wfile.write(blob)
        except Exception as e:
            self._json({'ok': False, 'error': str(e)}, 502)

    def _handle_pdf_extract(self):
        # 接收 PDF 字节 → 解析 → 存临时 → 返回文本型判定 + 段落
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length <= 0:
                raise RuntimeError('未收到文件内容')
            data = self.rfile.read(length)
            result = extract_pdf(data)
            temp_id = uuid.uuid4().hex[:8]
            pdf_dir = os.path.join(ensure_pdf_root(), temp_id)
            os.makedirs(pdf_dir, exist_ok=True)
            with open(os.path.join(pdf_dir, 'source.pdf'), 'wb') as f:
                f.write(data)
            with open(os.path.join(pdf_dir, 'paras.json'), 'w', encoding='utf-8') as f:
                json.dump(result['paragraphs'], f, ensure_ascii=False)
            self._json({'ok': True, 'tempId': temp_id, **result})
        except PdfError as e:
            self._json({'ok': False, 'error': str(e)}, 502)
        except Exception as e:
            self._json({'ok': False, 'error': str(e)}, 502)

    def _handle_pdf_ocr(self):
        # 接收 {tempId} → 启动后台 OCR 线程（图片型 PDF），立即返回
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8')) if length else {}
            temp_id = body.get('tempId') or ''
            pdf_dir = os.path.join(ensure_pdf_root(), temp_id)
            src = os.path.join(pdf_dir, 'source.pdf')
            if not temp_id or not os.path.isfile(src):
                raise RuntimeError('PDF 会话不存在或已过期，请重新提取')
            start_ocr(src, os.path.join(pdf_dir, 'ocr.json'))
            self._json({'ok': True})
        except Exception as e:
            self._json({'ok': False, 'error': str(e)}, 502)

    def _handle_pdf_ocr_status(self):
        # GET /api/pdf/ocr/status?tempId=xxx → 返回 OCR 进度/结果
        try:
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            temp_id = (qs.get('tempId') or [''])[0]
            pdf_dir = os.path.join(ensure_pdf_root(), temp_id)
            if not temp_id or not os.path.isdir(pdf_dir):
                raise RuntimeError('PDF 会话不存在或已过期，请重新提取')
            st = ocr_status(os.path.join(pdf_dir, 'ocr.json'))
            self._json({'ok': True, **st})
        except Exception as e:
            self._json({'ok': False, 'error': str(e)}, 502)

    def _handle_img_ocr(self):
        # 接收图片字节 → OCR 识别文字框 → 返回坐标与文本
        # 诊断日志：前端报 Failed to fetch 时，看这里就能判断请求到底有没有到
        t0 = time.time()
        _ocr_log('recv file=%s len=%s ua_ok' % (
            self.headers.get('X-Filename'), self.headers.get('Content-Length')))
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length <= 0:
                raise RuntimeError('未收到文件内容')
            data = self.rfile.read(length)
            filename = self.headers.get('X-Filename') or 'image.png'
            result = ocr_image(data, filename)
            _ocr_log('ok len=%s bytes=%s boxes=%s %.1fs' % (
                length, len(data), len(result['boxes']), time.time() - t0))
            self._json({'ok': True, 'count': len(result['boxes']), **result})
        except ImgError as e:
            _ocr_log('ImgError %s' % e)
            self._json({'ok': False, 'error': str(e)}, 502)
        except Exception as e:
            _ocr_log('Exception %s: %s' % (type(e).__name__, e))
            self._json({'ok': False, 'error': str(e)}, 502)

    def _handle_doc_export(self):
        # 通用文档导出：任意来源 → 目标格式（docx / pdf / md / txt）
        # 两种入参：
        #   1) html：前端已把 Markdown / Word 结构转成 HTML，后端用 Story 渲染，
        #      标题层级、列表、表格、代码块都能保留
        #   2) units：纯文本单元数组，PDF 走重排、docx 走 python-docx 段落生成
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8')) if length else {}
            fmt = body.get('fmt') or 'docx'
            html = body.get('html') or ''
            if html:
                if fmt != 'pdf':
                    raise RuntimeError('HTML 渲染只支持导出 PDF')
                blob, fname, mime = export_html_pdf(html, bool(body.get('pageNumbers')))
            else:
                units = body.get('units') or []
                if not units:
                    raise RuntimeError('没有可导出的内容')
                if fmt not in ('docx', 'pdf', 'md', 'txt'):
                    raise RuntimeError('不支持的目标格式: ' + str(fmt))
                original_paras = [{'seq': i, 'original': u.get('original', '')}
                                  for i, u in enumerate(units)]
                translated = [{'idx': i, 'translated': u.get('translated', '')}
                              for i, u in enumerate(units)]
                blob, fname, mime = export_translated(original_paras, translated, fmt)
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Content-Disposition', 'attachment; filename="' + fname + '"')
            self.send_header('Content-Length', str(len(blob)))
            self.end_headers()
            self.wfile.write(blob)
        except Exception as e:
            self._json({'ok': False, 'error': str(e)}, 502)

    def _handle_pdf_export(self):
        # 接收 {tempId, translated, fmt} → 读回 PDF+段落 → 生成译文文档返回
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8'))
            temp_id = body.get('tempId') or ''
            translated = body.get('translated') or []
            fmt = body.get('fmt') or 'docx'
            pdf_dir = os.path.join(ensure_pdf_root(), temp_id)
            src = os.path.join(pdf_dir, 'source.pdf')
            paras_path = os.path.join(pdf_dir, 'paras.json')
            if not temp_id or not os.path.isfile(src) or not os.path.isfile(paras_path):
                raise RuntimeError('PDF 会话不存在或已过期，请重新提取')
            # 原文段落：OCR 完成优先用 OCR 段落（含 boxes），否则文字层段落（含 rects）
            original_paras = []
            ocr_path = os.path.join(pdf_dir, 'ocr.json')
            if os.path.isfile(ocr_path):
                try:
                    with open(ocr_path, encoding='utf-8') as f:
                        st = json.load(f)
                    if st.get('paragraphs'):
                        original_paras = st['paragraphs']
                except Exception:
                    pass
            if not original_paras:
                with open(paras_path, encoding='utf-8') as f:
                    original_paras = json.load(f)
            with open(src, 'rb') as f:
                src_bytes = f.read()
            blob, fname, mime = export_translated(original_paras, translated, fmt, src_bytes)
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Content-Disposition', 'attachment; filename="' + fname + '"')
            self.send_header('Content-Length', str(len(blob)))
            self.end_headers()
            self.wfile.write(blob)
        except Exception as e:
            self._json({'ok': False, 'error': str(e)}, 502)

    def _handle_translate(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8'))
            provider = body.get('provider')
            texts = body.get('texts') or []
            settings = body.get('settings') or {}
            if provider == 'baidu':
                results = baidu_translate(texts, settings)
            elif provider == 'deepl':
                results = deepl_translate(texts, settings)
            else:
                raise RuntimeError('未知引擎: ' + str(provider))
            self._json({'ok': True, 'results': results})
        except Exception as e:
            self._json({'ok': False, 'error': str(e)}, 502)

    def _handle_encode(self):
        # 浏览器端无法编码 Shift-JIS/GBK（TextEncoder 只支持 UTF-8），由本地服务代劳
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8'))
            enc = body.get('encoding')
            text = body.get('text') or ''
            py_enc = {'shift_jis': 'shift_jis', 'gbk': 'gbk'}.get(enc)
            if not py_enc:
                raise RuntimeError('不支持的编码: ' + str(enc))
            raw = text.encode(py_enc)
            self._json({'ok': True, 'bytes': list(raw)})
        except UnicodeEncodeError as e:
            self._json({'ok': False,
                        'error': '译文包含无法用 %s 表示的字符，请改用 UTF-8 导出（%s）' % (enc, e.reason)}, 502)
        except Exception as e:
            self._json({'ok': False, 'error': str(e)}, 502)

    def _handle_open_url(self):
        # 用系统浏览器打开外部链接。WebView2 内直接点 a[href] 会把应用页面顶掉或被静默拦截，
        # 所以统一走后端。只放行赞助页面，避免变成任意跳转。
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8')) if length else {}
            url = (body.get('url') or '').strip()
            allowed = ('https://afdian.com/', 'https://afdian.net/')
            if not url.startswith(allowed):
                self._json({'ok': False, 'error': '不允许的地址'}, 400)
                return
            webbrowser.open(url)
            self._json({'ok': True})
        except Exception as e:
            self._json({'ok': False, 'error': str(e)}, 502)

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stdout.write('[%s] %s\n' % (time.strftime('%H:%M:%S'), fmt % args))


def main():
    _ocr_log('=== 应用启动 pid=%s ===' % os.getpid())
    port = find_free_port()
    handler = functools.partial(Handler, directory=get_web_root())
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = 'http://127.0.0.1:%d' % port

    used_webview = False
    try:
        import webview  # pip install pywebview
        webview.create_window(APP_NAME, url, width=1280, height=860, min_size=(900, 620))
        webview.start()
        used_webview = True
    except Exception:
        webbrowser.open(url)
        print('Opened in browser: %s' % url)
        print('Close this window to stop the server.')
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
    finally:
        httpd.shutdown()
        httpd.server_close()
        clean_unpack_root()


if __name__ == '__main__':
    main()
