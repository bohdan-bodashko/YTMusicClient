"""Generate crisp PNG and ICO assets for YTMusicClient using pure Python."""
import math
import os
import struct
import zlib


def write_png(path: str, width: int, height: int, pixels: bytearray) -> None:
    """Write RGBA pixel buffer to a PNG file."""
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # Filter type 0 (None)
        start = y * stride
        raw.extend(pixels[start : start + stride])

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), level=9)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def write_ico(path: str, png_entries: list[tuple[int, bytes]]) -> None:
    """Write a multi-size Windows ICO file embedding PNG images."""
    count = len(png_entries)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + count * 16
    directory = bytearray()
    blobs = bytearray()
    for size, data in png_entries:
        dim = 0 if size >= 256 else size
        directory.extend(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset))
        blobs.extend(data)
        offset += len(data)
    with open(path, "wb") as f:
        f.write(header + directory + blobs)


def blend_pixel(buf: bytearray, width: int, x: int, y: int, r: int, g: int, b: int, a: float) -> None:
    if a <= 0:
        return
    idx = (y * width + x) * 4
    a = min(1.0, max(0.0, a))
    inv = 1.0 - a
    old_a = buf[idx + 3] / 255.0
    out_a = a + old_a * inv
    if out_a <= 0:
        return
    buf[idx] = int((r * a + buf[idx] * old_a * inv) / out_a)
    buf[idx + 1] = int((g * a + buf[idx + 1] * old_a * inv) / out_a)
    buf[idx + 2] = int((b * a + buf[idx + 2] * old_a * inv) / out_a)
    buf[idx + 3] = int(out_a * 255)


def point_in_triangle(px: float, py: float, ax: float, ay: float, bx: float, by: float, cx: float, cy: float) -> float:
    """Signed distance approximation inside triangle (>0 inside)."""
    def edge(x1: float, y1: float, x2: float, y2: float) -> float:
        dx, dy = x2 - x1, y2 - y1
        length = math.hypot(dx, dy)
        return ((px - x1) * dy - (py - y1) * dx) / (length or 1.0)

    # Check winding and return minimum inward signed distance
    d1 = edge(ax, ay, bx, by)
    d2 = edge(bx, by, cx, cy)
    d3 = edge(cx, cy, ax, ay)
    return min(d1, d2, d3) if (d1 >= -1.5 and d2 >= -1.5 and d3 >= -1.5) else min(-d1, -d2, -d3)


def render_app_icon(size: int) -> bytearray:
    """Render a sleek YouTube Music-style red circle with inner white ring & play triangle."""
    buf = bytearray(size * size * 4)
    cx = cy = (size - 1) / 2.0
    outer_r = size * 0.46
    ring_outer = size * 0.29
    ring_inner = size * 0.245

    # Triangle vertices (pointing right, optically centered)
    tx1 = cx - size * 0.085
    ty1 = cy - size * 0.145
    tx2 = cx - size * 0.085
    ty2 = cy + size * 0.145
    tx3 = cx + size * 0.155
    ty3 = cy

    for y in range(size):
        for x in range(size):
            dist = math.hypot(x - cx, y - cy)
            # Outer red circle with gradient highlight
            if dist <= outer_r + 1.0:
                alpha = max(0.0, min(1.0, outer_r + 0.5 - dist))
                t = y / size
                r = int(255 - 28 * t)
                g = int(18 - 18 * t)
                b = int(32 - 12 * t)
                blend_pixel(buf, size, x, y, r, g, b, alpha)

            # Subtle inner white ring
            if ring_inner - 1.0 <= dist <= ring_outer + 1.0:
                a_out = max(0.0, min(1.0, ring_outer + 0.5 - dist))
                a_in = max(0.0, min(1.0, dist - (ring_inner - 0.5)))
                ring_a = min(a_out, a_in) * 0.94
                blend_pixel(buf, size, x, y, 255, 255, 255, ring_a)

            # Play triangle
            # Compute exact signed distance to triangle edges (clockwise orientation)
            def ed(x1: float, y1: float, x2: float, y2: float) -> float:
                dx, dy = x2 - x1, y2 - y1
                ln = math.hypot(dx, dy)
                return ((x - x1) * (-dy) + (y - y1) * dx) / ln

            # Clockwise: (tx1, ty1) -> (tx3, ty3) -> (tx2, ty2)
            # Wait: check sign at centroid (cx, cy)
            s1 = ed(tx1, ty1, tx3, ty3)
            s2 = ed(tx3, ty3, tx2, ty2)
            s3 = ed(tx2, ty2, tx1, ty1)
            sd = min(s1, s2, s3)
            if sd > -1.0:
                tri_a = max(0.0, min(1.0, sd + 0.5))
                blend_pixel(buf, size, x, y, 255, 255, 255, tri_a)

    return buf


def render_thumb_icon(kind: str, size: int = 32) -> bytearray:
    """Render white media control glyph on transparent background for Windows Thumbar."""
    buf = bytearray(size * size * 4)
    c = (size - 1) / 2.0

    def fill_rect(x0: float, y0: float, x1: float, y1: float) -> None:
        for y in range(size):
            for x in range(size):
                dx = min(x - x0, x1 - x)
                dy = min(y - y0, y1 - y)
                d = min(dx, dy)
                if d > -1.0:
                    blend_pixel(buf, size, x, y, 245, 245, 245, max(0.0, min(1.0, d + 0.5)))

    def fill_tri(x1: float, y1: float, x2: float, y2: float, x3: float, y3: float) -> None:
        # Ensure centroid has positive inside distance
        gx = (x1 + x2 + x3) / 3.0
        gy = (y1 + y2 + y3) / 3.0

        def ed(ax: float, ay: float, bx: float, by: float, px: float, py: float) -> float:
            dx, dy = bx - ax, by - ay
            ln = math.hypot(dx, dy) or 1.0
            return ((px - ax) * (-dy) + (py - ay) * dx) / ln

        sign1 = 1.0 if ed(x1, y1, x2, y2, gx, gy) >= 0 else -1.0
        sign2 = 1.0 if ed(x2, y2, x3, y3, gx, gy) >= 0 else -1.0
        sign3 = 1.0 if ed(x3, y3, x1, y1, gx, gy) >= 0 else -1.0

        for y in range(size):
            for x in range(size):
                d = min(
                    sign1 * ed(x1, y1, x2, y2, x, y),
                    sign2 * ed(x2, y2, x3, y3, x, y),
                    sign3 * ed(x3, y3, x1, y1, x, y),
                )
                if d > -1.0:
                    blend_pixel(buf, size, x, y, 245, 245, 245, max(0.0, min(1.0, d + 0.5)))

    if kind == "play":
        fill_tri(c - 6, c - 9, c - 6, c + 9, c + 9, c)
    elif kind == "pause":
        fill_rect(c - 7, c - 8, c - 2, c + 8)
        fill_rect(c + 2, c - 8, c + 7, c + 8)
    elif kind == "next":
        fill_tri(c - 9, c - 8, c - 9, c + 8, c + 3, c)
        fill_rect(c + 4, c - 8, c + 8, c + 8)
    elif kind == "prev":
        fill_rect(c - 8, c - 8, c - 4, c + 8)
        fill_tri(c + 9, c - 8, c + 9, c + 8, c - 3, c)

    return buf


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    assets = os.path.join(root, "assets")
    os.makedirs(assets, exist_ok=True)

    # Main 256x256 PNG + multi-size ICO
    icon_256 = render_app_icon(256)
    write_png(os.path.join(assets, "icon.png"), 256, 256, icon_256)

    ico_entries: list[tuple[int, bytes]] = []
    for sz in (16, 24, 32, 48, 64, 128, 256):
        tmp_path = os.path.join(assets, f"_tmp_{sz}.png")
        write_png(tmp_path, sz, sz, render_app_icon(sz))
        with open(tmp_path, "rb") as f:
            ico_entries.append((sz, f.read()))
        os.remove(tmp_path)
    write_ico(os.path.join(assets, "icon.ico"), ico_entries)

    # Tray small PNG (32x32)
    write_png(os.path.join(assets, "tray-icon.png"), 32, 32, render_app_icon(32))

    # Windows Taskbar Thumbnail icons
    for kind in ("play", "pause", "next", "prev"):
        write_png(os.path.join(assets, f"thumb-{kind}.png"), 32, 32, render_thumb_icon(kind, 32))


if __name__ == "__main__":
    main()
