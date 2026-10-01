"""Generate public/heightmaps/sample.png, a non-square test heightmap.

A volcanic island: a cone with a crater, radial ridges and some value noise.
Deliberately made with different code than the in-app noise so the image
path is tested on data the app did not produce itself.
"""

import numpy as np
from PIL import Image

W, H = 512, 384
rng = np.random.default_rng(7)
y, x = np.mgrid[0:H, 0:W].astype(np.float64)
cx, cy = W * 0.46, H * 0.52
dx, dy = (x - cx) / (W * 0.5), (y - cy) / (H * 0.5)
r = np.hypot(dx, dy)
theta = np.arctan2(dy, dx)

cone = np.clip(1.0 - r / 0.8, 0, 1) ** 1.8
crater = 0.62 * np.exp(-((r / 0.1) ** 2))
ridges = 0.035 * np.cos(theta * 9 + r * 2.5) * np.clip(1 - r, 0, 1) * np.clip((r - 0.12) / 0.2, 0, 1)
# a smaller satellite peak to the south east
r2 = np.hypot((x - W * 0.74) / (W * 0.2), (y - H * 0.7) / (H * 0.24))
satellite = 0.38 * np.clip(1 - r2, 0, 1) ** 2


def value_noise(scale):
    gh, gw = int(H / scale) + 2, int(W / scale) + 2
    grid = rng.random((gh, gw))
    gy, gx = y / scale, x / scale
    y0, x0 = gy.astype(int), gx.astype(int)
    ty, tx = gy - y0, gx - x0
    ty, tx = ty * ty * (3 - 2 * ty), tx * tx * (3 - 2 * tx)
    a, b = grid[y0, x0], grid[y0, x0 + 1]
    c, d = grid[y0 + 1, x0], grid[y0 + 1, x0 + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


detail = sum(value_noise(s) * w for s, w in [(64, 0.5), (24, 0.25), (9, 0.12), (4, 0.06)])
h = cone - crater + ridges + satellite + 0.32 * (detail - 0.5) * (0.35 + cone + satellite)
h = (h - h.min()) / (h.max() - h.min())
Image.fromarray((h * 255).round().astype(np.uint8), mode="L").save("public/heightmaps/sample.png")
print("wrote public/heightmaps/sample.png", W, H)
