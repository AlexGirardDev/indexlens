#!/usr/bin/env python3
from __future__ import annotations

import math
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PUBLIC_DIR = ROOT / "public"


def _blend(src: tuple[int, int, int, int], dst: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    sr, sg, sb, sa = src
    dr, dg, db, da = dst
    a = sa / 255.0
    ia = 1.0 - a
    r = int(sr * a + dr * ia)
    g = int(sg * a + dg * ia)
    b = int(sb * a + db * ia)
    out_a = int(sa + da * ia)
    return r, g, b, out_a


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + chunk_type
        + data
        + struct.pack(">I", zlib.crc32(chunk_type + data) & 0xFFFFFFFF)
    )


def _save_png(path: pathlib.Path, width: int, height: int, pixels: list[tuple[int, int, int, int]]) -> None:
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        row_start = y * width
        for x in range(width):
            r, g, b, a = pixels[row_start + x]
            raw.extend((r, g, b, a))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)

    png = bytearray(b"\x89PNG\r\n\x1a\n")
    png.extend(_png_chunk(b"IHDR", ihdr))
    png.extend(_png_chunk(b"IDAT", idat))
    png.extend(_png_chunk(b"IEND", b""))

    path.write_bytes(png)


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _gradient(c0: tuple[int, int, int], c1: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return (
        int(_lerp(c0[0], c1[0], t)),
        int(_lerp(c0[1], c1[1], t)),
        int(_lerp(c0[2], c1[2], t)),
    )


def _rounded_rect_mask(x: float, y: float, s: float, r: float) -> bool:
    if x < 0 or y < 0 or x > s or y > s:
        return False
    if r <= x <= s - r or r <= y <= s - r:
        return True
    corners = ((r, r), (s - r, r), (r, s - r), (s - r, s - r))
    for cx, cy in corners:
        if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
            return True
    return False


def _angle_in_range(angle: float, start: float, width: float) -> bool:
    """Check if *angle* (0-360) lies within an arc starting at *start* with given *width* degrees."""
    end = start + width
    if end > 360:
        return angle >= start or angle <= end - 360
    return start <= angle <= end


def _draw_icon(size: int) -> list[tuple[int, int, int, int]]:
    px = [(0, 0, 0, 0)] * (size * size)

    def set_pixel(x: int, y: int, color: tuple[int, int, int, int]) -> None:
        if 0 <= x < size and 0 <= y < size:
            i = y * size + x
            px[i] = _blend(color, px[i])

    # Background rounded square with diagonal gradient.
    radius = size * 0.19
    bg0 = (231, 244, 255)
    bg1 = (184, 219, 255)
    for y in range(size):
        for x in range(size):
            if _rounded_rect_mask(x, y, size - 1, radius):
                t = (x + y) / (2 * (size - 1))
                r, g, b = _gradient(bg0, bg1, t)
                set_pixel(x, y, (r, g, b, 255))

    # Shutter aperture parameters.
    cx = size * 0.5
    cy = size * 0.5
    r_outer = size * 0.39       # blade outer radius
    r_inner = size * 0.11       # blade inner radius (center opening)
    blade_w_deg = 75.0          # angular width of each blade (degrees)
    twist_deg = 15.0            # angular offset from outer to inner edge
    blade_color = (79, 121, 166)  # #4F79A6
    rim_color = (17, 58, 95)      # #113A5F

    # Draw 6 shutter blades.
    for y in range(size):
        for x in range(size):
            dx = x - cx
            dy = y - cy
            d = math.hypot(dx, dy)
            if d < r_inner or d > r_outer:
                continue
            angle = math.degrees(math.atan2(dy, dx)) % 360
            # Interpolate twist: full twist at inner edge, zero at outer edge.
            t = (d - r_inner) / max(0.001, r_outer - r_inner)
            for i in range(6):
                start = (i * 60.0 + twist_deg * (1.0 - t)) % 360
                if _angle_in_range(angle, start, blade_w_deg):
                    alpha = 255 if i % 2 == 0 else 217
                    set_pixel(x, y, (blade_color[0], blade_color[1], blade_color[2], alpha))
                    break

    # Outer rim circle.
    rim_r = size * 0.40
    rim_w = max(1.0, size * 0.03)
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - cx, y - cy)
            if abs(d - rim_r) <= rim_w * 0.5:
                set_pixel(x, y, (rim_color[0], rim_color[1], rim_color[2], 255))

    # Center opening outline.
    center_w = max(1.0, size * 0.012)
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - cx, y - cy)
            if abs(d - r_inner) <= center_w * 0.5:
                set_pixel(x, y, (rim_color[0], rim_color[1], rim_color[2], 255))

    return px


def main() -> None:
    sizes = (16, 32, 48, 128)
    for size in sizes:
        out = PUBLIC_DIR / f"indexlens-icon-{size}.png"
        _save_png(out, size, size, _draw_icon(size))
        print(f"wrote {out.relative_to(ROOT)}")

    favicon = PUBLIC_DIR / "indexlens-favicon.svg"
    favicon.write_text((ROOT / "docs/assets/indexlens-icon-source.svg").read_text(encoding="utf-8"), encoding="utf-8")
    print(f"wrote {favicon.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
