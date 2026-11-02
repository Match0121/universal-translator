# -*- coding: utf-8 -*-
"""图片翻译后端：OCR 识别图片中的文字框（RapidOCR）
能力：
  - ocr_image：接收图片字节 → 输出 {width, height, boxes:[{box, text, score}]}
    box 为原图像素坐标 [x1, y1, x2, y2]（左上/右下）

依赖：rapidocr_onnxruntime（引擎复用 pdf.py 的加载逻辑）、opencv-python（解码与尺寸）
精简版（不含 OCR）缺少依赖时优雅报错提示。
"""
import os
import tempfile

from pdf import _ocr_engine


def _cv2():
    try:
        import cv2
        return cv2
    except Exception:
        raise ImgError('图片组件未安装（精简版不含 OCR，无法识别图片文字）')


class ImgError(Exception):
    pass


# 超大图先等比缩小再识别：既避免 OCR 引擎吃爆内存（前端只会看到 Failed to fetch），
# 也把耗时压下来。阈值设得宽松，常规截图和 4K 图都不会触发。
MAX_OCR_SIDE = 8192
MAX_OCR_PIXELS = 25_000_000


def ocr_image(data, filename='image.png'):
    """识别图片中的文字。返回 {width, height, boxes}
    boxes: [{box: [x1,y1,x2,y2], text, score}]，坐标按输入图原始像素。
    格式由内容自动识别（opencv 解码），临时文件统一用 .png 后缀即可。
    """
    cv2 = _cv2()
    fd, tmp = tempfile.mkstemp(suffix='.png')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        img = cv2.imread(tmp)
        if img is None:
            raise ImgError('无法解码图片，请确认文件有效（支持 png / jpg / webp / bmp）')
        height, width = img.shape[:2]
        # 等比缩小（必要时），box 最后按 scale 乘回去，前端坐标不变
        scale = 1.0
        if max(width, height) > MAX_OCR_SIDE or width * height > MAX_OCR_PIXELS:
            try:
                scale = min(MAX_OCR_SIDE / float(max(width, height)),
                            (MAX_OCR_PIXELS / float(width * height)) ** 0.5)
                nw = max(1, int(round(width * scale)))
                nh = max(1, int(round(height * scale)))
                cv2.imwrite(tmp, cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA))
            except Exception:
                scale = 1.0
        engine = _ocr_engine()
        result, _ = engine(tmp)
        boxes = []
        inv = (1.0 / scale) if scale else 1.0
        if result:
            for box, text, score in result:
                t = str(text).strip()
                if not t:
                    continue
                xs = [p[0] * inv for p in box]
                ys = [p[1] * inv for p in box]
                boxes.append({
                    'box': [round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys))],
                    'text': t,
                    'score': round(float(score), 3),
                })
        return {'width': width, 'height': height, 'boxes': boxes,
                'scale': round(scale, 4)}
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass