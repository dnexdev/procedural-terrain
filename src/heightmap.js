// A heightmap is a grid of heights in [0, 1], stored row by row:
// index = z * width + x. Row 0 is the top row of an image and the far (-Z)
// edge of the terrain.

import { createPerlin2D, fbm } from './noise.js'

export class Heightmap {
  /**
   * @param {number} width  samples along X
   * @param {number} depth  samples along Z
   * @param {Float32Array} data  width * depth heights
   */
  constructor(width, depth, data) {
    if (width < 2 || depth < 2) throw new Error('heightmap needs at least 2 x 2 samples')
    if (data.length !== width * depth) throw new Error('data length does not match width * depth')
    this.width = width
    this.depth = depth
    this.data = data
  }

  /** Height at grid coordinates, clamped to the edges. */
  get(x, z) {
    const cx = Math.min(this.width - 1, Math.max(0, x))
    const cz = Math.min(this.depth - 1, Math.max(0, z))
    return this.data[cz * this.width + cx]
  }

  /** Stretch values so the lowest is 0 and the highest is 1. */
  normalized() {
    let min = Infinity
    let max = -Infinity
    for (const v of this.data) {
      if (v < min) min = v
      if (v > max) max = v
    }
    const range = max - min || 1
    const out = new Float32Array(this.data.length)
    for (let i = 0; i < out.length; i++) out[i] = (this.data[i] - min) / range
    return new Heightmap(this.width, this.depth, out)
  }

  /**
   * Separable box blur, run in X then in Z (O(n) per pass, independent of
   * the radius size thanks to a running sum). 8-bit images only have 256
   * height levels, which shows up as terraces with hard lighting steps. A
   * small blur turns those steps back into slopes.
   */
  blurred(radius) {
    if (radius < 1) return this
    const { width: w, depth: d } = this
    const tmp = new Float32Array(this.data.length)
    const out = new Float32Array(this.data.length)
    const pass = (src, dst, len, lines, stride, lineStride) => {
      for (let line = 0; line < lines; line++) {
        const base = line * lineStride
        let sum = 0
        // Window starts centred on sample 0 with edges clamped.
        for (let k = -radius; k <= radius; k++) sum += src[base + Math.min(len - 1, Math.max(0, k)) * stride]
        for (let i = 0; i < len; i++) {
          dst[base + i * stride] = sum / (2 * radius + 1)
          const add = Math.min(len - 1, i + radius + 1)
          const remove = Math.max(0, i - radius)
          sum += src[base + add * stride] - src[base + remove * stride]
        }
      }
    }
    pass(this.data, tmp, w, d, 1, w) // along X
    pass(tmp, out, d, w, w, 1) // along Z
    return new Heightmap(w, d, out)
  }

  /**
   * Build from RGBA pixels (e.g. canvas ImageData). Uses Rec. 709 luma, so
   * a grayscale image maps straight to height and a color image still works.
   */
  static fromRGBA(rgba, width, depth) {
    const data = new Float32Array(width * depth)
    for (let i = 0; i < data.length; i++) {
      const r = rgba[i * 4]
      const g = rgba[i * 4 + 1]
      const b = rgba[i * 4 + 2]
      data[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    }
    return new Heightmap(width, depth, data)
  }

  /** Grayscale RGBA pixels, for exporting the heightmap as a PNG. */
  toRGBA() {
    const rgba = new Uint8ClampedArray(this.data.length * 4)
    for (let i = 0; i < this.data.length; i++) {
      const v = Math.round(this.data[i] * 255)
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v
      rgba[i * 4 + 3] = 255
    }
    return rgba
  }
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Generate a heightmap from fractal noise.
 *
 * Samples are taken in normalized coordinates (0 to 1 across the map), so
 * the resolution only changes the level of detail, not the shape. A 64 x 64
 * and a 512 x 512 map of the same seed describe the same landscape.
 *
 * @param {object} o
 * @param {number} o.width
 * @param {number} o.depth
 * @param {number} o.seed
 * @param {number} o.frequency   features across the map
 * @param {number} o.octaves
 * @param {number} o.persistence amplitude falloff per octave
 * @param {number} o.lacunarity  frequency growth per octave
 * @param {number} o.ridge       0 smooth hills, 1 ridged mountains
 * @param {number} o.exponent    >1 flattens valleys and sharpens peaks
 * @param {number} o.island      0 to 1, sinks the edges into the sea
 */
export function noiseHeightmap({
  width,
  depth,
  seed = 1,
  frequency = 3,
  octaves = 6,
  persistence = 0.5,
  lacunarity = 2,
  ridge = 0,
  exponent = 1,
  island = 0,
}) {
  const noise = createPerlin2D(seed)
  const aspect = (depth - 1) / (width - 1)
  const raw = new Float32Array(width * depth)
  for (let z = 0; z < depth; z++) {
    const v = z / (depth - 1)
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1)
      raw[z * width + x] = fbm(noise, u * frequency, v * frequency * aspect, {
        octaves,
        persistence,
        lacunarity,
        ridge,
      })
    }
  }

  const base = new Heightmap(width, depth, raw).normalized()
  const out = base.data
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) {
      const i = z * width + x
      let h = out[i]
      if (island > 0) {
        // Distance from the centre, 0 in the middle and 1 at the edge midpoints.
        const dx = (x / (width - 1)) * 2 - 1
        const dz = (z / (depth - 1)) * 2 - 1
        const d = Math.min(1, Math.hypot(dx, dz))
        h *= 1 - island * smoothstep(0.35, 1.0, d)
      }
      // Redistribution: h^e keeps 0 and 1 in place but pushes mid heights
      // down, which gives wide valleys and steeper peaks.
      out[i] = h ** exponent
    }
  }
  return base.normalized()
}
