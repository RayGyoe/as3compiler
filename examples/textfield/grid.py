#!/usr/bin/env python3
"""grid.py — 把 adl / AOT 两端写的 textfield-grid.raw 拼成一张并排对照图。

    python3 examples/textfield/grid.py <adl.raw> <aot.raw> <out.png>

`raw` 是 examples/textfield/Main.as 的 UI 模式写的：一行 ASCII 头
`TFGRID 1 <W> <H>\\n`，随后 W*H 个像素，每像素 4 字节 A,R,G,B（straight，非预乘）。

**为什么是并排图、不是像素 diff**：两端跑的是同一段 AS3、同一份坐标，但光栅器不同——
AIR 用自带引擎（SWC 文本还用它内嵌的 SWF 字体），我们走 Skia + 系统字体。字形轮廓本来
就不该逐像素相同（那是 docs/zh-cn/flash-text.md §0 明列的非目标），所以像素差恒为「很大」、
没有信息量。这张图是给**眼睛**看的：颜色、粗斜下划线的形状、字形家族、对齐位置、
字段声明盒——报告里那些看不见的东西。

alpha 合成到白底：AIR 的 draw() 是「源盖到目标上」（透明处保留底色），我们目前是
「逐像素覆盖」（见本文件末尾的说明），所以两端的 alpha 分布不同，统一在白底上合成
之后视觉等价。
"""
import sys

from PIL import Image

BG = (255, 255, 255)
LABEL_H = 26


def read_raw(path):
    data = open(path, 'rb').read()
    nl = data.index(b'\n')
    head = data[:nl].decode('ascii').strip()
    parts = head.split()
    assert parts[0] == 'TFGRID' and parts[1] == '1', f'{path}: bad header {head!r}'
    w, h = int(parts[2]), int(parts[3])
    px = data[nl + 1:]
    want = w * h * 4
    assert len(px) == want, f'{path}: {len(px)} pixel bytes, expected {want}'
    # PIL 的 "RGBA" 是 R,G,B,A 字节序，而 raw 是 A,R,G,B —— 借 split/merge 换位，
    # 不逐像素循环。
    im = Image.frombytes('RGBA', (w, h), px)
    a, r, g, b = im.split()
    return w, h, Image.merge('RGBA', (r, g, b, a))


def over_white(im):
    """straight alpha 合成到白底，得到不透明 RGB。"""
    r, g, b, a = im.split()
    rgb = Image.merge('RGB', (r, g, b))
    return Image.composite(rgb, Image.new('RGB', im.size, BG), a)


def labelled(im, text):
    out = Image.new('RGB', (im.width, im.height + LABEL_H), BG)
    out.paste(im, (0, LABEL_H))
    from PIL import ImageDraw
    d = ImageDraw.Draw(out)
    d.text((6, 7), text, fill=(0, 0, 0))
    d.line([(0, LABEL_H - 1), (out.width, LABEL_H - 1)], fill=(160, 160, 160))
    return out


def main():
    if len(sys.argv) != 4:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    adl_raw, aot_raw, out = sys.argv[1:4]

    aw, ah, adl = read_raw(adl_raw)
    bw, bh, aot = read_raw(aot_raw)
    print(f'adl {aw}x{ah}   aot {bw}x{bh}')
    if (aw, ah) != (bw, bh):
        print('WARNING: 两端网格尺寸不同——说明排版本身已经分叉，先看这一步', file=sys.stderr)

    adl = labelled(over_white(adl), f'adl  (AIR 51.4.1)   {aw}x{ah}')
    aot = labelled(over_white(aot), f'AOT  (as3compiler)  {bw}x{bh}')

    gap = 10
    W = adl.width + gap + aot.width
    H = max(adl.height, aot.height)
    canvas = Image.new('RGB', (W, H), (210, 210, 210))
    canvas.paste(adl, (0, 0))
    canvas.paste(aot, (adl.width + gap, 0))
    canvas.save(out)
    print(f'-> {out}')

    for suffix, im in (('adl', adl), ('aot', aot)):
        solo = out.rsplit('.', 1)[0] + f'-{suffix}.png'
        im.save(solo)
    return 0


if __name__ == '__main__':
    sys.exit(main())
