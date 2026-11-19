#!/usr/bin/env python3
"""Rotate and optionally deskew a page image. Used by the House OCR job."""
from __future__ import annotations

import argparse
import sys

def deskew_angle(im, limit=4.0, step=0.5):
    from PIL import Image, ImageOps, ImageStat
    gray = ImageOps.grayscale(im)
    # Downsample so the projection search stays cheap on 200–300 DPI pages.
    scale = 150 / max(gray.size)
    if scale < 1:
        gray = gray.resize((max(1, int(gray.width * scale)), max(1, int(gray.height * scale))))
    bw = gray.point(lambda p: 255 if p > 180 else 0)
    best = (0.0, -1.0)
    angle = -limit
    while angle <= limit + 1e-9:
        rotated = bw.rotate(angle, expand=False, fillcolor=255)
        # Variance of horizontal ink density: a straight page has sharper rows.
        hist = [0] * rotated.height
        pix = rotated.load()
        for y in range(rotated.height):
            hist[y] = sum(1 for x in range(rotated.width) if pix[x, y] < 128)
        if hist:
            mean = sum(hist) / len(hist)
            var = sum((v - mean) ** 2 for v in hist) / len(hist)
            if var > best[1]:
                best = (angle, var)
        angle += step
    return best[0] if best[1] >= 0 else 0.0

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('src')
    parser.add_argument('dest')
    parser.add_argument('--rotate', type=int, default=0, help='Clockwise degrees to correct')
    parser.add_argument('--deskew', action='store_true')
    args = parser.parse_args()
    try:
        from PIL import Image, ImageOps
    except ImportError:
        print('PIL is not installed', file=sys.stderr)
        return 2
    im = Image.open(args.src)
    rot = args.rotate % 360
    if rot:
        # PIL rotate is counter-clockwise; tesseract OSD Rotate is clockwise.
        im = im.rotate(-rot, expand=True, fillcolor='white')
    if args.deskew:
        try:
            skew = deskew_angle(im)
            if abs(skew) >= 0.4:
                im = im.rotate(skew, expand=True, fillcolor='white')
        except Exception as exc:  # noqa: BLE001
            print(f'deskew skipped: {exc}', file=sys.stderr)
    im.save(args.dest)
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
