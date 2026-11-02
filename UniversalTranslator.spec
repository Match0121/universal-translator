# -*- mode: python ; coding: utf-8 -*-

import os
from PyInstaller.utils.hooks import collect_dynamic_libs

# OCR（rapidocr_onnxruntime）：把包内配置与模型收进 exe（运行时解包到 _MEIPASS，
# 包内部按 __file__ 相对路径找 config.yaml / models，目录结构必须保持 rapidocr_onnxruntime/...）
_ocr_datas = []
try:
    import rapidocr_onnxruntime as _roc
    _roc_root = os.path.dirname(_roc.__file__)
    for _name in sorted(os.listdir(_roc_root)):
        _p = os.path.join(_roc_root, _name)
        if os.path.isfile(_p):
            _ocr_datas.append((_p, 'rapidocr_onnxruntime'))
    _models = os.path.join(_roc_root, 'models')
    if os.path.isdir(_models):
        for _f in sorted(os.listdir(_models)):
            _ocr_datas.append((os.path.join(_models, _f), os.path.join('rapidocr_onnxruntime', 'models')))
except Exception as e:
    print('WARN: OCR data collect failed:', e)

# onnxruntime 动态库（推理引擎）
_onnx_dlls = collect_dynamic_libs('onnxruntime')


a = Analysis(
    ['desktop.py'],
    pathex=[],
    binaries=_onnx_dlls,
    datas=[('web', 'web')] + _ocr_datas,
    hiddenimports=['onnxruntime'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='UniversalTranslator',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=['onnxruntime.dll'],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='assets/icon.ico',
)