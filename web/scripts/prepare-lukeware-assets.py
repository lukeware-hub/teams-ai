from pathlib import Path

import numpy as np
from PIL import Image

ASSETS = Path(r"C:\Users\Administrator\.cursor\projects\c-Users-Administrator-workspace-luke-lab-teams-ai\assets")
OUT = Path(__file__).resolve().parents[1] / "public"


def load(name_part: str) -> Image.Image:
    matches = [p for p in ASSETS.iterdir() if name_part in p.name]
    if not matches:
        raise FileNotFoundError(name_part)
    return Image.open(matches[0]).convert("RGBA")


def remove_near_white(im: Image.Image, thresh: int = 248) -> Image.Image:
    a = np.array(im)
    rgb = a[:, :, :3].astype(np.int16)
    m = rgb.min(axis=2)
    white = m >= thresh
    a[white, 3] = 0
    near = (m >= thresh - 25) & ~white
    alpha = np.maximum(1, 255 - m[near]).astype(np.float32)
    unmatte = (rgb[near] - (255 - alpha[:, None])).clip(0, 255) * (255 / alpha[:, None])
    a[near, :3] = unmatte.clip(0, 255).astype(np.uint8)
    a[near, 3] = np.minimum(a[near, 3], alpha.astype(np.uint8))
    a[a[:, :, 3] == 0, :3] = 0
    return Image.fromarray(a)


def remove_near_black(im: Image.Image, thresh: int = 22) -> Image.Image:
    a = np.array(im)
    rgb = a[:, :, :3].astype(np.int16)
    mx = rgb.max(axis=2)
    sat = (rgb.max(axis=2) - rgb.min(axis=2)).astype(np.int16)
    black = (mx <= thresh) & (a[:, :, 3] > 0)
    a[black, 3] = 0
    fringe = (a[:, :, 3] > 0) & (a[:, :, 3] < 200) & (mx < 40) & (sat < 20)
    a[fringe, 3] = 0
    a[a[:, :, 3] == 0, :3] = 0
    return Image.fromarray(a)


def crop_opaque(im: Image.Image, pad: int = 6) -> Image.Image:
    a = np.array(im)
    ys, xs = np.where(a[:, :, 3] > 8)
    if len(xs) == 0:
        return im
    y0, y1 = max(0, ys.min() - pad), min(a.shape[0], ys.max() + 1 + pad)
    x0, x1 = max(0, xs.min() - pad), min(a.shape[1], xs.max() + 1 + pad)
    return im.crop((x0, y0, x1, y1))


def export_png(im: Image.Image, path: Path) -> None:
    im.save(path, "PNG", optimize=True)
    print("wrote", path.name, im.size)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    light = load("Logo_corporativo_Lukeware_em_azul-b51cc37a")
    light = remove_near_white(light, 248)
    light = crop_opaque(light, pad=12)
    target_h = 160
    light = light.resize((int(light.width * target_h / light.height), target_h), Image.Resampling.LANCZOS)
    export_png(light, OUT / "lukeware-lockup-light.png")
    export_png(light, OUT / "lukeware-lockup.png")

    # Dark lockup from the sharp light master: charcoal wordmarks become white; blues stay.
    dark_arr = np.array(light)
    rgb = dark_arr[:, :, :3].astype(np.float32)
    alpha = dark_arr[:, :, 3]
    lum = 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]
    blue_chroma = rgb[:, :, 2] - (rgb[:, :, 0] + rgb[:, :, 1]) / 2
    dark_text = (lum < 90) & (blue_chroma < 45) & (alpha > 128)
    dark_arr[dark_text, 0:3] = 255
    dark = Image.fromarray(dark_arr)
    export_png(dark, OUT / "lukeware-lockup-dark.png")

    mark = load("android-chrome-512x512")
    mark = remove_near_black(mark, 22)
    mark = remove_near_white(mark, 248)
    mark = crop_opaque(mark, pad=8)
    side = max(mark.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(mark, ((side - mark.width) // 2, (side - mark.height) // 2), mark)
    mark512 = canvas.resize((512, 512), Image.Resampling.LANCZOS)
    export_png(mark512, OUT / "lukeware-mark.png")
    export_png(mark512.resize((32, 32), Image.Resampling.LANCZOS), OUT / "favicon-32.png")
    export_png(mark512.resize((180, 180), Image.Resampling.LANCZOS), OUT / "apple-touch-icon.png")
    mark512.resize((16, 16), Image.Resampling.LANCZOS).save(
        OUT / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
    )
    print("wrote favicon.ico")


if __name__ == "__main__":
    main()
