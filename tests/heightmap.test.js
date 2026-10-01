import { describe, expect, it } from 'vitest'
import { Heightmap, noiseHeightmap } from '../src/heightmap.js'
import { createPerlin2D, fbm, mulberry32 } from '../src/noise.js'
import { computeBands, makeTerrainColorizer } from '../src/palette.js'

describe('noise', () => {
  it('is deterministic per seed', () => {
    const a = createPerlin2D(42)
    const b = createPerlin2D(42)
    const c = createPerlin2D(43)
    expect(a(1.3, 7.7)).toBe(b(1.3, 7.7))
    expect(a(1.3, 7.7)).not.toBe(c(1.3, 7.7))
    expect(mulberry32(1)()).toBe(mulberry32(1)())
  })

  it('is zero on integer lattice points (Perlin property)', () => {
    const n = createPerlin2D(5)
    for (let i = -3; i < 4; i++) expect(n(i, 2 * i + 1)).toBe(0)
  })

  it('is continuous (no jumps between neighbouring samples)', () => {
    const n = createPerlin2D(8)
    for (let x = 0; x < 10; x += 0.01) {
      expect(Math.abs(n(x + 0.001, 0.37) - n(x, 0.37))).toBeLessThan(0.01)
    }
  })

  it('stays within [-1, 1] and fbm within [0, 1]', () => {
    const n = createPerlin2D(11)
    for (let i = 0; i < 5000; i++) {
      const x = i * 0.137
      const y = i * 0.071
      expect(Math.abs(n(x, y))).toBeLessThanOrEqual(1)
      const f = fbm(n, x, y, { ridge: (i % 3) / 2 })
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThanOrEqual(1)
    }
  })
})

describe('heightmap', () => {
  it('generates normalized heights spanning exactly [0, 1]', () => {
    const hm = noiseHeightmap({ width: 64, depth: 48, seed: 2, island: 0.5, exponent: 2 })
    expect(hm.data.length).toBe(64 * 48)
    expect(Math.min(...hm.data)).toBe(0)
    expect(Math.max(...hm.data)).toBe(1)
  })

  it('keeps the same shape at a different resolution', () => {
    // Sampling in normalized coordinates: the centre sample of a 33 x 33
    // and a 65 x 65 map is the same point of the same landscape.
    const lo = noiseHeightmap({ width: 33, depth: 33, seed: 4 })
    const hi = noiseHeightmap({ width: 65, depth: 65, seed: 4 })
    expect(lo.get(16, 16)).toBeCloseTo(hi.get(32, 32), 1)
  })

  it('sinks the edges when island falloff is on', () => {
    const hm = noiseHeightmap({ width: 64, depth: 64, seed: 6, island: 1 })
    let edge = 0
    for (let i = 0; i < 64; i++) edge = Math.max(edge, hm.get(i, 0), hm.get(0, i))
    expect(edge).toBeLessThan(0.05)
  })

  it('reads image pixels as luma', () => {
    // white, black, mid grey, pure green
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255, 0, 255, 0, 255])
    const hm = Heightmap.fromRGBA(rgba, 2, 2)
    expect(hm.data[0]).toBeCloseTo(1, 5)
    expect(hm.data[1]).toBe(0)
    expect(hm.data[2]).toBeCloseTo(128 / 255, 5)
    expect(hm.data[3]).toBeCloseTo(0.7152, 4)
  })

  it('round trips through PNG pixels within 8-bit precision', () => {
    const hm = noiseHeightmap({ width: 16, depth: 16, seed: 1 })
    const back = Heightmap.fromRGBA(hm.toRGBA(), 16, 16)
    for (let i = 0; i < hm.data.length; i++) expect(Math.abs(back.data[i] - hm.data[i])).toBeLessThan(0.5 / 255 + 1e-6)
  })

  it('blur keeps flat maps flat and smooths steps', () => {
    const flat = new Heightmap(8, 8, new Float32Array(64).fill(0.4)).blurred(2)
    for (const v of flat.data) expect(v).toBeCloseTo(0.4, 6)

    const step = new Float32Array(64)
    for (let z = 0; z < 8; z++) for (let x = 4; x < 8; x++) step[z * 8 + x] = 1
    const soft = new Heightmap(8, 8, step).blurred(1)
    expect(soft.get(3, 4)).toBeCloseTo(1 / 3, 5)
    expect(soft.get(4, 4)).toBeCloseTo(2 / 3, 5)
  })

  it('rejects inconsistent sizes', () => {
    expect(() => new Heightmap(1, 5, new Float32Array(5))).toThrow()
    expect(() => new Heightmap(3, 3, new Float32Array(8))).toThrow()
  })
})

describe('palette', () => {
  const bands = computeBands({ waterLevel: 0.25, snowLine: 0.75 })

  it('keeps band stops increasing for any slider values', () => {
    for (const [waterLevel, snowLine] of [
      [0.25, 0.75],
      [0, 0.3],
      [0.6, 0.3],
    ]) {
      const b = computeBands({ waterLevel, snowLine })
      for (let i = 1; i < b.length; i++) expect(b[i].stop).toBeGreaterThan(b[i - 1].stop)
    }
  })

  it('colors valleys green and peaks white', () => {
    const color = makeTerrainColorizer(bands)
    const out = new Float32Array(3)
    color(0.4, 1, out, 0) // lowland, flat
    expect(out[1]).toBeGreaterThan(out[0])
    expect(out[1]).toBeGreaterThan(out[2])
    color(0.95, 1, out, 0) // peak, flat
    expect(Math.min(...out)).toBeGreaterThan(0.8)
  })

  it('keeps snow on moderately steep ground above the snow line only', () => {
    const color = makeTerrainColorizer(bands)
    const high = new Float32Array(3)
    const mid = new Float32Array(3)
    color(0.95, 0.55, high, 0) // above the snow line, slope 0.45
    color(0.5, 0.55, mid, 0) // same slope, below it
    expect(Math.min(...high)).toBeGreaterThan(0.8)
    expect(mid[0]).toBeLessThan(0.3)
  })

  it('turns near vertical faces into cliff whatever the height', () => {
    const color = makeTerrainColorizer(bands)
    const flat = new Float32Array(3)
    const steep = new Float32Array(3)
    color(0.95, 1, flat, 0)
    color(0.95, 0.3, steep, 0)
    expect(steep[0]).toBeLessThan(flat[0] * 0.5)
  })
})
