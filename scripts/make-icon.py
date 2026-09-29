#!/usr/bin/env python3
"""生成应用图标：白底、黑色加粗 "Pi"。

    python3 scripts/make-icon.py              # 输出 desktop/icon.png（1024×1024）

图标本体是 desktop/icon.png，再由 scripts/package-desktop.mjs 调用
`cargo tauri icon` 生成 desktop/src-tauri/icons/ 下的 icns / 各尺寸 png。
改图标就改这里的 FONT / TEXT_FILL，或直接换掉 desktop/icon.png。
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SIZE = 1024        # 最终边长
SS = 3             # 超采样倍数：画大再缩小，边缘才干净
MARGIN = 100       # 留白（macOS 图标内容约占 824/1024）
RADIUS = 185       # 圆角半径（macOS 规格）
BG = (255, 255, 255)
FG = (0, 0, 0)
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
TEXT = "Pi"
TEXT_FILL = 0.46   # 文字宽度占卡片宽度的比例
OUT = Path(__file__).resolve().parent.parent / "desktop" / "icon.png"


def render(font_path: str = FONT, out: Path = OUT, text_fill: float = TEXT_FILL) -> None:
    n, m, r = SIZE * SS, MARGIN * SS, RADIUS * SS

    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([m, m, n - m, n - m], radius=r, fill=BG)

    # 二分字号，使文字宽度恰好等于目标宽度
    target_w = (n - 2 * m) * text_fill
    lo, hi = 10, n
    while lo < hi:
        mid = (lo + hi + 1) // 2
        box = draw.textbbox((0, 0), TEXT, font=ImageFont.truetype(font_path, mid))
        if (box[2] - box[0]) <= target_w:
            lo = mid
        else:
            hi = mid - 1

    font = ImageFont.truetype(font_path, lo)
    # anchor="mm" 按实际墨迹居中（"Pi" 没有下伸部件，墨迹中心即视觉中心）
    draw.text((n / 2, n / 2), TEXT, font=font, fill=FG, anchor="mm")

    out.parent.mkdir(parents=True, exist_ok=True)
    img.resize((SIZE, SIZE), Image.Resampling.LANCZOS).save(out)
    print(f"{out}  ({SIZE}×{SIZE}, 字号 {lo // SS}px @1x)")


if __name__ == "__main__":
    render()
