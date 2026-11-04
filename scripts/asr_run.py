"""scripts/asr_run.py —— 给 lib/asr.mjs 用：抽音轨 → 切语音岛 → 逐岛识别 → 输出 JSON

用法：
  python asr_run.py <video> <thresholdDb> <minGapSec> <minIslandSec> <model> [outJson]

第 6 个参数给了路径就写文件，否则写 stdout 的 UTF-8 字节
（2026-11-04 实测：Windows 控制台是 GBK，print 中文会被 PowerShell 吃掉变成 U+FFFD）。
"""
import sys, os, json, wave, subprocess, tempfile

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')   # 国内拉模型

import numpy as np
from faster_whisper import WhisperModel

video = sys.argv[1]
thr = float(sys.argv[2])
gap = float(sys.argv[3])
minlen = float(sys.argv[4])
model_size = sys.argv[5]
out_path = sys.argv[6] if len(sys.argv) > 6 else None

wav = os.path.join(tempfile.gettempdir(), 'asr_work.wav')
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000', wav], check=True)

w = wave.open(wav, 'rb')
sr = w.getframerate()
x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
win = int(sr * 0.1)
rms = np.array([
    20 * np.log10(np.sqrt(np.mean(x[i:i + win] ** 2)) + 1e-9)
    for i in range(0, max(1, len(x) - win), win)
])

islands, i = [], 0
while i < len(rms):
    if rms[i] > thr:
        j = i
        while j < len(rms) and rms[j] > thr:
            j += 1
        islands.append([i * 0.1, j * 0.1])
        i = j
    else:
        i += 1

merged = []
for s, e in islands:
    if merged and s - merged[-1][1] < gap:
        merged[-1][1] = e
    else:
        merged.append([s, e])
merged = [m for m in merged if m[1] - m[0] >= minlen]

m = WhisperModel(
    model_size,
    device='cpu',
    compute_type='int8',
    download_root=os.path.join(os.path.expanduser('~'), '.dsh', 'cache', 'whisper'),
)

out = []
for s, e in merged:
    a, b = int(s * sr), int(e * sr)
    segs, _ = m.transcribe(x[a:b], language='zh', beam_size=5, vad_filter=False)
    segs = list(segs)
    txt = ''.join(t.text for t in segs).strip()
    lp = min([t.avg_logprob for t in segs] or [0])
    out.append({'start': round(s, 2), 'end': round(e, 2), 'text': txt, 'lp': round(float(lp), 2)})

payload = json.dumps(out, ensure_ascii=False)
if out_path:
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(payload)
else:
    sys.stdout.buffer.write(payload.encode('utf-8'))
