# -*- coding: utf-8 -*-
"""Vision smoke test: send a real screenshot to the multimodal backend."""
import base64
import json
import urllib.request

IMG = r"E:\用户\Desktop\ScreenShot_2026-10-05_172305_421.png"
with open(IMG, "rb") as f:
    b64 = base64.b64encode(f.read()).decode()

body = json.dumps({
    "model": "qwen3.8-9b",
    "messages": [{
        "role": "user",
        "content": [
            {"type": "text", "text": "这张截图里有什么内容？请用中文简短回答。"},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
        ],
    }],
    "max_tokens": 256,
    "temperature": 0.2,
}).encode("utf-8")

req = urllib.request.Request("http://127.0.0.1:8080/v1/chat/completions", data=body,
                             headers={"Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.load(r)
    print("finish:", d["choices"][0]["finish_reason"])
    print("reply:", d["choices"][0]["message"]["content"])
    print("prompt_tokens:", d["usage"]["prompt_tokens"])
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode("utf-8", "replace")[:800])
