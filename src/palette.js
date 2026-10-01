// Height bands shared by the GLSL shader, the CPU vertex-color path and the
// on-screen legend, so all three always agree.

import { Color } from 'three'

// sRGB hex values. THREE.Color converts them to linear space, which is what
// both lighting paths expect.
export const COLORS = {
  deepWater: '#0b2f4a',
  shallowWater: '#2b7a90',
  sand: '#d6c38d',
  grass: '#6b9b3e',
  forest: '#2e5a2b',
  bare: '#7b6b58',
  snow: '#f2f5f8',
  cliff: '#5c5550',
}

/**
 * Band start heights (normalized 0 to 1) derived from the two lines a user
 * cares about: the water level and the snow line. Everything else is placed
 * relative to them, so moving a slider moves the whole palette sensibly.
 *
 * @returns {{name: string, color: string, stop: number}[]}
 */
export function computeBands({ waterLevel, snowLine }) {
  const snow = Math.max(snowLine, waterLevel + 0.1)
  const bands = [
    { name: 'deep water', color: COLORS.deepWater, stop: 0 },
    { name: 'shallows', color: COLORS.shallowWater, stop: waterLevel - 0.08 },
    { name: 'beach', color: COLORS.sand, stop: waterLevel },
    { name: 'grass', color: COLORS.grass, stop: waterLevel + 0.03 },
    { name: 'forest', color: COLORS.forest, stop: waterLevel + (snow - waterLevel) * 0.4 },
    { name: 'bare rock', color: COLORS.bare, stop: snow - 0.1 },
    { name: 'snow', color: COLORS.snow, stop: snow },
  ]
  // Keep stops strictly increasing even for extreme slider values.
  for (let i = 1; i < bands.length; i++) {
    bands[i].stop = Math.max(bands[i].stop, bands[i - 1].stop + 0.001)
  }
  return bands
}

export const BAND_COUNT = 7

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * CPU version of terrainAlbedo() in terrain.frag.glsl, for the vertex color
 * mode. Colors are converted to linear RGB once, then the returned function
 * writes one vertex color into `out` at `offset`.
 *
 * @param {ReturnType<typeof computeBands>} bands
 * @returns {(h: number, normalY: number, out: Float32Array, offset: number) => void}
 */
export function makeTerrainColorizer(bands, { blend = 0.02, rockSlope = 0.35 } = {}) {
  const colors = bands.map((b) => new Color(b.color))
  const cliff = new Color(COLORS.cliff)
  const stops = bands.map((b) => b.stop)
  const last = bands.length - 1
  return (h, normalY, out, offset) => {
    let r = colors[0].r
    let g = colors[0].g
    let b = colors[0].b
    for (let i = 1; i < colors.length; i++) {
      const t = smoothstep(stops[i] - blend, stops[i] + blend, h)
      r += (colors[i].r - r) * t
      g += (colors[i].g - g) * t
      b += (colors[i].b - b) * t
    }
    const slope = 1 - normalY
    const land = smoothstep(stops[2], stops[3], h)
    const cliffAmount = smoothstep(rockSlope, rockSlope + 0.12, slope) * land
    r += (cliff.r - r) * cliffAmount
    g += (cliff.g - g) * cliffAmount
    b += (cliff.b - b) * cliffAmount
    const snowLine = stops[last]
    const snow =
      smoothstep(snowLine - blend, snowLine + blend, h) *
      (1 - smoothstep(rockSlope + 0.2, rockSlope + 0.32, slope))
    out[offset] = r + (colors[last].r - r) * snow
    out[offset + 1] = g + (colors[last].g - g) * snow
    out[offset + 2] = b + (colors[last].b - b) * snow
  }
}
