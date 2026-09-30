#!/usr/bin/env python
"""生成 Electron 应用图标 assets/icon.ico 与托盘图标 assets/tray.png。

配色跟 DSH 主题走：近黑的品牌色圆角方块 + 白色进度环。
用 4 倍超采样再缩回来，避免圆角锯齿。

    python make-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
ASSETS = HERE / "assets"

BG = (15, 17, 21, 255)  # --dsw-alias-brand-primary（浅色主题 #0f1115）
TRACK = (255, 255, 255, 72)  # 白色 28%
ARC = (255, 255, 255, 255)


def render(size: int) -> Image.Image:
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.28), fill=BG)

    pad = s * 0.21
    box = [pad, pad, s - pad - 1, s - pad - 1]
    width = max(2, int(s * 0.085))
    draw.ellipse(box, outline=TRACK, width=width)
    # Pillow 的角度：0° 在 3 点钟方向，顺时针为正；-90° 即 12 点。
    draw.arc(box, start=-90, end=25, fill=ARC, width=width)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    render(256).save(ASSETS / "icon.ico", sizes=[(s, s) for s in sizes])
    render(32).save(ASSETS / "tray.png")
    render(256).save(ASSETS / "icon.png")
    print(f"图标已生成 -> {ASSETS}")


if __name__ == "__main__":
    main()
