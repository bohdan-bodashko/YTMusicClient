"""Generate crisp PNG, ICO, and NSIS/Portable BMP assets for YTMusicClient."""
import math
import os
import struct
import zlib

try:
    from PIL import Image, ImageDraw, ImageFont
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


def write_png(path: str, width: int, height: int, pixels: bytearray, dpi: int = 96) -> None:
    """Write RGBA pixel buffer to a PNG file with DPI metadata."""
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
    ppm = int(round(dpi / 0.0254))
    phys = struct.pack(">IIB", ppm, ppm, 1)
    idat = zlib.compress(bytes(raw), level=9)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"pHYs", phys)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def png_bytes(width: int, height: int, pixels: bytearray, dpi: int = 96) -> bytes:
    """Serialize an RGBA pixel buffer to in-memory PNG bytes."""
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        start = y * stride
        raw.extend(pixels[start : start + stride])

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    ppm = int(round(dpi / 0.0254))
    phys = struct.pack(">IIB", ppm, ppm, 1)
    idat = zlib.compress(bytes(raw), level=9)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"pHYs", phys)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )


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


def write_bmp_24(path: str, width: int, height: int, rgb_pixels: bytearray) -> None:
    """Write a standard 24-bit BI_RGB Windows BMP (bottom-up scanlines) for NSIS."""
    row_raw = width * 3
    row_padded = (row_raw + 3) & ~3
    pad_bytes = b"\x00" * (row_padded - row_raw)
    image_size = row_padded * height
    file_size = 54 + image_size

    file_header = struct.pack("<2sIHHI", b"BM", file_size, 0, 0, 54)
    dib_header = struct.pack(
        "<IiiHHIIIIII",
        40,
        width,
        height,
        1,
        24,
        0,
        image_size,
        3780,
        3780,
        0,
        0,
    )

    body = bytearray()
    for y in range(height - 1, -1, -1):
        base = y * row_raw
        for x in range(width):
            idx = base + x * 3
            body.append(rgb_pixels[idx + 2])  # B
            body.append(rgb_pixels[idx + 1])  # G
            body.append(rgb_pixels[idx])      # R
        if pad_bytes:
            body.extend(pad_bytes)

    with open(path, "wb") as f:
        f.write(file_header + dib_header + body)


def blend_pixel(buf: bytearray, width: int, x: int, y: int, r: int, g: int, b: int, a: float) -> None:
    """Source-over alpha blend onto an RGBA buffer."""
    if a <= 0.0:
        return
    idx = (y * width + x) * 4
    a = min(1.0, max(0.0, a))
    inv = 1.0 - a
    old_a = buf[idx + 3] / 255.0
    out_a = a + old_a * inv
    if out_a <= 0.0:
        return
    buf[idx] = int(round((r * a + buf[idx] * old_a * inv) / out_a))
    buf[idx + 1] = int(round((g * a + buf[idx + 1] * old_a * inv) / out_a))
    buf[idx + 2] = int(round((b * a + buf[idx + 2] * old_a * inv) / out_a))
    buf[idx + 3] = int(round(out_a * 255))


def point_in_triangle_raw(px: float, py: float, x1: float, y1: float, x2: float, y2: float, x3: float, y3: float) -> bool:
    """Fast point-in-triangle check using barycentric sign test."""
    d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2)
    d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3)
    d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1)
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)


def supersample_triangle(
    buf: bytearray,
    size: int,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    x3: float,
    y3: float,
    r: int,
    g: int,
    b: int,
    alpha_scale: float = 1.0,
    samples: int = 6,
) -> None:
    """Render an anti-aliased triangle via subpixel supersampling."""
    min_x = max(0, int(math.floor(min(x1, x2, x3))) - 1)
    max_x = min(size - 1, int(math.ceil(max(x1, x2, x3))) + 1)
    min_y = max(0, int(math.floor(min(y1, y2, y3))) - 1)
    max_y = min(size - 1, int(math.ceil(max(y1, y2, y3))) + 1)
    inv_s = 1.0 / samples
    total = float(samples * samples)

    for y in range(min_y, max_y + 1):
        for x in range(min_x, max_x + 1):
            hits = 0
            for sy in range(samples):
                py = y + (sy + 0.5) * inv_s - 0.5
                for sx in range(samples):
                    px = x + (sx + 0.5) * inv_s - 0.5
                    if point_in_triangle_raw(px, py, x1, y1, x2, y2, x3, y3):
                        hits += 1
            if hits > 0:
                blend_pixel(buf, size, x, y, r, g, b, (hits / total) * alpha_scale)


def render_app_icon(size: int) -> bytearray:
    """Render YouTube Music disc with crisp pure-white ring & play glyph."""
    buf = bytearray(size * size * 4)
    cx = cy = (size - 1) / 2.0

    # Optically tune small icons (<= 32px) so ring and triangle stay legible
    if size <= 24:
        outer_r = size * 0.475
        ring_outer = size * 0.345
        ring_inner = size * 0.255
        tri_w_l = size * 0.085
        tri_w_r = size * 0.165
        tri_h = size * 0.155
    elif size <= 32:
        outer_r = size * 0.47
        ring_outer = size * 0.325
        ring_inner = size * 0.25
        tri_w_l = size * 0.085
        tri_w_r = size * 0.16
        tri_h = size * 0.15
    else:
        outer_r = size * 0.46
        ring_outer = size * 0.295
        ring_inner = size * 0.242
        tri_w_l = size * 0.082
        tri_w_r = size * 0.156
        tri_h = size * 0.145

    samples = 8 if size <= 32 else 4
    inv_s = 1.0 / samples
    inv_total = 1.0 / (samples * samples)

    for y in range(size):
        for x in range(size):
            dx = x - cx
            dy = y - cy
            dist = math.hypot(dx, dy)

            # Subtle dark outer edge for separation on bright backgrounds (48px+)
            if size >= 48 and outer_r - 0.5 <= dist <= outer_r + 1.4:
                halo_a = max(0.0, min(1.0, outer_r + 1.2 - dist)) * 0.24
                blend_pixel(buf, size, x, y, 24, 4, 8, halo_a)

            # Crimson YouTube Music disc with directional highlight -> rich deep red
            if dist <= outer_r + 1.0:
                if dist <= outer_r - 1.0:
                    disc_a = 1.0
                else:
                    hits = 0
                    for sy in range(samples):
                        py = dy + (sy + 0.5) * inv_s - 0.5
                        for sx in range(samples):
                            px = dx + (sx + 0.5) * inv_s - 0.5
                            if math.hypot(px, py) <= outer_r:
                                hits += 1
                    disc_a = hits * inv_total

                if disc_a > 0.0:
                    nx = dx / (outer_r or 1.0)
                    ny = dy / (outer_r or 1.0)
                    t = max(0.0, min(1.0, 0.48 + 0.28 * nx + 0.44 * ny))
                    radial = max(0.0, 1.0 - (dist / outer_r) ** 2)
                    r = int(round(255 - 56 * t + 10 * radial))
                    g = int(round(36 * (1.0 - t) + 8 * radial))
                    b = int(round(56 * (1.0 - t) + 18 * t))
                    r = max(0, min(255, r))
                    g = max(0, min(255, g))
                    b = max(0, min(255, b))
                    blend_pixel(buf, size, x, y, r, g, b, disc_a)

                    # Subtle top-edge specular rim for crisp depth
                    if size >= 48 and dist >= outer_r - max(1.5, size * 0.022):
                        top_rim = max(0.0, -ny) * 0.22 * disc_a
                        if top_rim > 0.0:
                            blend_pixel(buf, size, x, y, 255, 160, 175, top_rim)

            # Pure crisp #FFFFFF inner ring (zero red bleed-through)
            if ring_inner - 1.2 <= dist <= ring_outer + 1.2:
                if ring_inner + 0.8 <= dist <= ring_outer - 0.8:
                    ring_a = 1.0
                else:
                    hits = 0
                    for sy in range(samples):
                        py = dy + (sy + 0.5) * inv_s - 0.5
                        for sx in range(samples):
                            px = dx + (sx + 0.5) * inv_s - 0.5
                            sd = math.hypot(px, py)
                            if ring_inner <= sd <= ring_outer:
                                hits += 1
                    ring_a = hits * inv_total
                if ring_a > 0.0:
                    blend_pixel(buf, size, x, y, 255, 255, 255, ring_a)

    # Pure crisp #FFFFFF play triangle
    tx1, ty1 = cx - tri_w_l, cy - tri_h
    tx2, ty2 = cx - tri_w_l, cy + tri_h
    tx3, ty3 = cx + tri_w_r, cy
    supersample_triangle(buf, size, tx1, ty1, tx2, ty2, tx3, ty3, 255, 255, 255, 1.0, samples=samples)
    return buf


def render_thumb_icon(kind: str, size: int = 32) -> bytearray:
    """Render high-contrast Windows Thumbar glyph inside a sleek dark pill badge."""
    buf = bytearray(size * size * 4)
    cx = cy = (size - 1) / 2.0
    outer_r = 14.4
    fill_r = 13.7
    rim_in = 12.6
    samples = 8
    inv_s = 1.0 / samples
    inv_total = 1.0 / (samples * samples)

    for y in range(size):
        t = y / float(size - 1)
        fill_r_col = 28.0 - 10.0 * t
        fill_g_col = 28.0 - 10.0 * t
        fill_b_col = 34.0 - 12.0 * t
        for x in range(size):
            dx = x - cx
            dy = y - cy
            # Fast bounding reject
            if math.hypot(dx, dy) > outer_r + 1.5:
                continue

            pr = pg = pb = pa = 0.0
            for sy in range(samples):
                py = dy + (sy + 0.5) * inv_s - 0.5
                for sx in range(samples):
                    px = dx + (sx + 0.5) * inv_s - 0.5
                    sd = math.hypot(px, py)
                    if sd <= fill_r:
                        sr, sg, sb, sa = fill_r_col, fill_g_col, fill_b_col, 0.94
                        if sd >= rim_in:
                            # Subtle 1px inner edge highlight for dark-taskbar definition
                            rim_w = 0.16
                            sr = sr * (1.0 - rim_w) + 255.0 * rim_w
                            sg = sg * (1.0 - rim_w) + 255.0 * rim_w
                            sb = sb * (1.0 - rim_w) + 255.0 * rim_w
                    elif sd <= outer_r:
                        sr, sg, sb, sa = 8.0, 8.0, 12.0, 0.52
                    else:
                        continue
                    pr += sr * sa
                    pg += sg * sa
                    pb += sb * sa
                    pa += sa

            out_a = pa * inv_total
            if out_a > 0.0:
                idx = (y * size + x) * 4
                buf[idx] = int(round(pr / pa))
                buf[idx + 1] = int(round(pg / pa))
                buf[idx + 2] = int(round(pb / pa))
                buf[idx + 3] = int(round(out_a * 255.0))

    def fill_crisp_rect(x0: int, y0: int, x1: int, y1: int) -> None:
        for py in range(max(0, y0), min(size, y1)):
            for px in range(max(0, x0), min(size, x1)):
                blend_pixel(buf, size, px, py, 255, 255, 255, 1.0)

    if kind == "play":
        supersample_triangle(buf, size, 11.5, 9.0, 11.5, 23.0, 23.0, 16.0, 255, 255, 255, 1.0, samples=8)
    elif kind == "pause":
        fill_crisp_rect(10, 9, 14, 23)
        fill_crisp_rect(18, 9, 22, 23)
    elif kind == "next":
        supersample_triangle(buf, size, 9.0, 10.0, 9.0, 22.0, 18.0, 16.0, 255, 255, 255, 1.0, samples=8)
        fill_crisp_rect(19, 10, 22, 22)
    elif kind == "prev":
        fill_crisp_rect(10, 10, 13, 22)
        supersample_triangle(buf, size, 23.0, 10.0, 23.0, 22.0, 14.0, 16.0, 255, 255, 255, 1.0, samples=8)

    return buf


def composite_rgba_onto_rgb(rgb: bytearray, rw: int, rh: int, rgba: bytearray, sw: int, sh: int, ox: int, oy: int) -> None:
    """Alpha-composite an RGBA icon onto an RGB canvas at (ox, oy)."""
    for y in range(sh):
        dy = oy + y
        if dy < 0 or dy >= rh:
            continue
        for x in range(sw):
            dx = ox + x
            if dx < 0 or dx >= rw:
                continue
            s_idx = (y * sw + x) * 4
            sa = rgba[s_idx + 3] / 255.0
            if sa <= 0.0:
                continue
            d_idx = (dy * rw + dx) * 3
            inv = 1.0 - sa
            rgb[d_idx] = int(round(rgba[s_idx] * sa + rgb[d_idx] * inv))
            rgb[d_idx + 1] = int(round(rgba[s_idx + 1] * sa + rgb[d_idx + 1] * inv))
            rgb[d_idx + 2] = int(round(rgba[s_idx + 2] * sa + rgb[d_idx + 2] * inv))


def _load_font(size: int, bold: bool = False):
    if not HAS_PIL:
        return None
    fonts_dir = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    candidates = ["segoeuib.ttf", "arialbd.ttf"] if bold else ["segoeui.ttf", "arial.ttf"]
    for name in candidates:
        p = os.path.join(fonts_dir, name)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                pass
    return ImageFont.load_default()


def _draw_centered_text(rgb: bytearray, w: int, h: int, text: str, y: int, size: int, color: tuple[int, int, int], bold: bool = False) -> None:
    if not HAS_PIL:
        return
    img = Image.frombytes("RGB", (w, h), bytes(rgb))
    draw = ImageDraw.Draw(img)
    font = _load_font(size, bold=bold)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    tx = (w - tw) / 2.0 - bbox[0]
    draw.text((tx, y), text, font=font, fill=color)
    rgb[:] = img.tobytes()


def render_installer_header_bmp(path: str) -> None:
    """Render 150x57 24-bit BMP for NSIS MUI_HEADERIMAGE_BITMAP (right side of white header)."""
    w, h = 150, 57
    rgb = bytearray([255] * (w * h * 3))
    for y in range(h):
        for x in range(w):
            if y >= h - 2:
                t = max(0.0, min(1.0, (x - 16) / float(w - 16)))
                idx = (y * w + x) * 3
                rgb[idx] = int(255 - 35 * t)
                rgb[idx + 1] = int(255 - 220 * t)
                rgb[idx + 2] = int(255 - 195 * t)
    icon_36 = render_app_icon(36)
    composite_rgba_onto_rgb(rgb, w, h, icon_36, 36, 36, w - 36 - 8, (h - 36) // 2)
    if HAS_PIL:
        img = Image.frombytes("RGB", (w, h), bytes(rgb))
        draw = ImageDraw.Draw(img)
        font_title = _load_font(11, bold=True)
        font_sub = _load_font(10, bold=False)
        draw.text((8, 14), "YouTube Music", font=font_title, fill=(24, 24, 28))
        draw.text((8, 29), "Desktop Client", font=font_sub, fill=(113, 113, 122))
        rgb[:] = img.tobytes()
    write_bmp_24(path, w, h, rgb)


def _read_package_version(root: str) -> str:
    import json
    pkg_path = os.path.join(root, "package.json")
    try:
        with open(pkg_path, "r", encoding="utf-8") as f:
            return str(json.load(f).get("version") or "1.2.0")
    except Exception:
        return "1.2.0"


def render_installer_sidebar_bmp(path: str, version: str = "1.2.0") -> None:
    """Render 164x314 24-bit BMP for NSIS MUI_WELCOMEFINISHPAGE_BITMAP."""
    w, h = 164, 314
    rgb = bytearray(w * h * 3)
    glow_cx, glow_cy = w * 0.5, 92.0
    for y in range(h):
        ty = y / float(h - 1)
        for x in range(w):
            dist = math.hypot(x - glow_cx, y - glow_cy)
            glow = math.exp(-((dist / 78.0) ** 2))
            r = int(min(255, 11 + 6 * ty + 52 * glow))
            g = int(min(255, 11 + 2 * ty + 6 * glow))
            b = int(min(255, 16 + 5 * ty + 14 * glow))
            idx = (y * w + x) * 3
            rgb[idx] = r
            rgb[idx + 1] = g
            rgb[idx + 2] = b
            # Subtle 1px right divider line
            if x == w - 1:
                rgb[idx] = 39
                rgb[idx + 1] = 39
                rgb[idx + 2] = 46

    # Decorative subtle audio spectrum bars near bottom
    bar_heights = [14, 26, 38, 22, 44, 30, 18, 34, 24, 14]
    bar_w = 6
    gap = 5
    start_x = (w - (len(bar_heights) * bar_w + (len(bar_heights) - 1) * gap)) // 2
    base_y = h - 42
    for i, bh in enumerate(bar_heights):
        bx = start_x + i * (bar_w + gap)
        for py in range(base_y - bh, base_y):
            fade = (py - (base_y - bh)) / float(bh)
            for px in range(bx, bx + bar_w):
                idx = (py * w + px) * 3
                rgb[idx] = int(rgb[idx] * 0.6 + (235 - 60 * fade) * 0.4)
                rgb[idx + 1] = int(rgb[idx + 1] * 0.6 + (30 * (1 - fade)) * 0.4)
                rgb[idx + 2] = int(rgb[idx + 2] * 0.6 + (56 * (1 - fade)) * 0.4)

    icon_76 = render_app_icon(76)
    composite_rgba_onto_rgb(rgb, w, h, icon_76, 76, 76, (w - 76) // 2, 54)
    _draw_centered_text(rgb, w, h, "YouTube Music", 148, 16, (250, 250, 250), bold=True)
    _draw_centered_text(rgb, w, h, "Desktop Client", 171, 12, (161, 161, 170), bold=False)
    _draw_centered_text(rgb, w, h, "Ad-free • Lyrics • Tray", 196, 10, (113, 113, 122), bold=False)
    _draw_centered_text(rgb, w, h, f"v{version}", h - 26, 11, (161, 161, 170), bold=False)
    write_bmp_24(path, w, h, rgb)


def render_portable_splash_bmp(path: str) -> None:
    """Render 460x240 24-bit BMP splash image for portable launcher extraction."""
    w, h = 460, 240
    rgb = bytearray(w * h * 3)
    glow_cx, glow_cy = w * 0.5, 86.0
    for y in range(h):
        ty = y / float(h - 1)
        for x in range(w):
            dist = math.hypot((x - glow_cx) * 0.75, y - glow_cy)
            glow = math.exp(-((dist / 105.0) ** 2))
            r = int(min(255, 10 + 4 * ty + 48 * glow))
            g = int(min(255, 10 + 2 * ty + 6 * glow))
            b = int(min(255, 14 + 4 * ty + 14 * glow))
            idx = (y * w + x) * 3
            rgb[idx] = r
            rgb[idx + 1] = g
            rgb[idx + 2] = b
            # Crisp 1px outer frame + top crimson accent bar
            if y < 3:
                rgb[idx] = 235
                rgb[idx + 1] = 24
                rgb[idx + 2] = 52
            elif x == 0 or x == w - 1 or y == h - 1:
                rgb[idx] = 44
                rgb[idx + 1] = 44
                rgb[idx + 2] = 52

    icon_84 = render_app_icon(84)
    composite_rgba_onto_rgb(rgb, w, h, icon_84, 84, 84, (w - 84) // 2, 40)
    _draw_centered_text(rgb, w, h, "YouTube Music Client", 142, 20, (250, 250, 250), bold=True)
    _draw_centered_text(rgb, w, h, "Launching portable player…", 174, 13, (161, 161, 170), bold=False)
    write_bmp_24(path, w, h, rgb)


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    assets = os.path.join(root, "assets")
    build_dir = os.path.join(root, "build")
    os.makedirs(assets, exist_ok=True)
    os.makedirs(build_dir, exist_ok=True)

    # Main 256x256 PNG + multi-size ICO
    icon_256 = render_app_icon(256)
    write_png(os.path.join(assets, "icon.png"), 256, 256, icon_256)

    ico_entries: list[tuple[int, bytes]] = []
    for sz in (16, 24, 32, 48, 64, 128, 256):
        pixels = icon_256 if sz == 256 else render_app_icon(sz)
        ico_entries.append((sz, png_bytes(sz, sz, pixels)))
    write_ico(os.path.join(assets, "icon.ico"), ico_entries)

    # Tray PNGs (1x 32x32 + 2x 64x64 for high-DPI Windows scaling)
    write_png(os.path.join(assets, "tray-icon.png"), 32, 32, render_app_icon(32))
    write_png(os.path.join(assets, "tray-icon@2x.png"), 64, 64, render_app_icon(64))

    # Windows Taskbar Thumbnail icons (32x32 high-contrast dark badge)
    for kind in ("play", "pause", "next", "prev"):
        write_png(os.path.join(assets, f"thumb-{kind}.png"), 32, 32, render_thumb_icon(kind, 32))

    # Branded NSIS & Portable 24-bit BMPs (kept in build/ outside app.asar)
    version = _read_package_version(root)
    render_installer_header_bmp(os.path.join(build_dir, "installerHeader.bmp"))
    render_installer_sidebar_bmp(os.path.join(build_dir, "installerSidebar.bmp"), version=version)
    render_portable_splash_bmp(os.path.join(build_dir, "portableSplash.bmp"))


if __name__ == "__main__":
    main()
