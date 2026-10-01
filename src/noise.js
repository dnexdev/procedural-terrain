// Seeded 2D gradient noise (Perlin, 2002 "improved" version) and fractal sums.
//
// Written from scratch instead of pulling in a noise package, so the whole
// path from a seed to a vertex height is visible in this repo.

/**
 * Small, fast, seedable PRNG (mulberry32). Same seed gives the same terrain.
 * @param {number} seed
 * @returns {() => number} uniform floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 8 gradient directions: 4 axis aligned and 4 diagonal.
const GX = new Int8Array([1, -1, 1, -1, 1, -1, 0, 0])
const GY = new Int8Array([1, 1, -1, -1, 0, 0, 1, -1])

// Quintic fade 6t^5 - 15t^4 + 10t^3. Its first and second derivatives are 0
// at t = 0 and t = 1, so the noise has no visible creases at cell borders,
// which matters here because creases would show up as lighting seams.
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10)
const lerp = (a, b, t) => a + (b - a) * t

/**
 * Build a 2D Perlin noise function for a seed.
 *
 * For a point (x, y): find its grid cell, give each of the 4 corners a
 * pseudo-random gradient (from a seeded permutation table), take the dot
 * product of each gradient with the vector from that corner to the point,
 * then blend the 4 values with the fade curve. Output is 0 at every integer
 * lattice point and roughly within [-1, 1].
 *
 * @param {number} seed
 * @returns {(x: number, y: number) => number}
 */
export function createPerlin2D(seed) {
  const rand = mulberry32(seed)
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  for (let i = 255; i > 0; i--) {
    // Fisher-Yates shuffle
    const j = Math.floor(rand() * (i + 1))
    const tmp = p[i]
    p[i] = p[j]
    p[j] = tmp
  }
  // Doubled so perm[perm[X] + Y + 1] never needs a wrap.
  const perm = new Uint8Array(512)
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]

  const grad = (hash, dx, dy) => {
    const g = hash & 7
    return GX[g] * dx + GY[g] * dy
  }

  return function perlin(x, y) {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const X = xi & 255
    const Y = yi & 255

    const aa = perm[perm[X] + Y]
    const ab = perm[perm[X] + Y + 1]
    const ba = perm[perm[X + 1] + Y]
    const bb = perm[perm[X + 1] + Y + 1]

    const u = fade(xf)
    const v = fade(yf)
    const bottom = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u)
    const top = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u)
    return lerp(bottom, top, v)
  }
}

/**
 * Fractal Brownian motion: add octaves of noise, each at `lacunarity` times
 * the frequency and `persistence` times the amplitude of the previous one.
 * Low octaves shape mountains, high octaves add surface detail.
 *
 * `ridge` blends each octave from smooth hills (0) to sharp ridged
 * mountains (1). Ridges come from (1 - |n|)^2, which peaks where the noise
 * crosses zero and so forms long thin crests.
 *
 * Each octave is offset by a different amount because Perlin noise is 0 at
 * the origin for every frequency, which would otherwise pin a flat spot there.
 *
 * @returns {number} roughly in [0, 1]
 */
export function fbm(noise, x, y, { octaves = 6, lacunarity = 2, persistence = 0.5, ridge = 0 } = {}) {
  let sum = 0
  let amplitude = 1
  let frequency = 1
  let total = 0
  for (let o = 0; o < octaves; o++) {
    const n = noise(x * frequency + o * 17.13, y * frequency + o * 31.71)
    const smooth = 0.5 + 0.5 * n
    const ridged = (1 - Math.abs(n)) ** 2
    sum += (smooth * (1 - ridge) + ridged * ridge) * amplitude
    total += amplitude
    amplitude *= persistence
    frequency *= lacunarity
  }
  return sum / total
}
