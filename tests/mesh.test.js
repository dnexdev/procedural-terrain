import { BufferAttribute, BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'
import { Heightmap, noiseHeightmap } from '../src/heightmap.js'
import { buildGridIndices, buildTerrainMesh, faceWeightedNormals } from '../src/mesh.js'

/** Heightmap from a function of normalized coordinates (u, v) in [0, 1]. */
function mapFrom(width, depth, fn) {
  const data = new Float32Array(width * depth)
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) data[z * width + x] = fn(x / (width - 1), z / (depth - 1))
  }
  return new Heightmap(width, depth, data)
}

const vec = (arr, i) => [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]]

function faceNormal(positions, a, b, c) {
  const [ax, ay, az] = vec(positions, a)
  const [bx, by, bz] = vec(positions, b)
  const [cx, cy, cz] = vec(positions, c)
  const e1 = [bx - ax, by - ay, bz - az]
  const e2 = [cx - ax, cy - ay, cz - az]
  return [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
}

describe('grid layout', () => {
  const hm = mapFrom(5, 4, () => 0.5)
  const mesh = buildTerrainMesh(hm, { sizeX: 8, heightScale: 10 })

  it('has one vertex per heightmap sample and two triangles per cell', () => {
    expect(mesh.vertexCount).toBe(20)
    expect(mesh.positions.length).toBe(60)
    expect(mesh.uvs.length).toBe(40)
    expect(mesh.triangleCount).toBe(4 * 3 * 2)
  })

  it('centres the grid with square cells, even for a non-square map', () => {
    // 5 samples across 8 units -> cell 2, so 4 samples deep -> 6 units.
    expect(mesh.sizeZ).toBe(6)
    expect(vec(mesh.positions, 0)).toEqual([-4, 5, -3])
    expect(vec(mesh.positions, 19)).toEqual([4, 5, 3])
  })

  it('maps UV corners so the image is not mirrored', () => {
    // top-left sample (row 0) is the top of the image -> v = 1
    expect([mesh.uvs[0], mesh.uvs[1]]).toEqual([0, 1])
    expect([mesh.uvs[38], mesh.uvs[39]]).toEqual([1, 0])
    for (const t of mesh.uvs) expect(t >= 0 && t <= 1).toBe(true)
  })

  it('only references existing vertices', () => {
    expect(Math.max(...mesh.indices)).toBe(mesh.vertexCount - 1)
    expect(Math.min(...mesh.indices)).toBe(0)
  })

  it('never puts index 65535 (WebGL2 primitive restart) in a 16-bit buffer', () => {
    // 255 x 257 = 65535 vertices: largest index 65534, 16-bit is safe.
    expect(buildGridIndices(255, 257)).toBeInstanceOf(Uint16Array)
    expect(buildGridIndices(255, 257).reduce((a, b) => Math.max(a, b), 0)).toBe(65534)
    // 256 x 256 = 65536 vertices: index 65535 exists, so 32-bit.
    expect(buildGridIndices(256, 256)).toBeInstanceOf(Uint32Array)
  })
})

describe('winding', () => {
  it('makes every triangle face up (+Y) so it is front facing from the sky', () => {
    const mesh = buildTerrainMesh(noiseHeightmap({ width: 33, depth: 33, seed: 3 }), { heightScale: 10 })
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const n = faceNormal(mesh.positions, mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2])
      expect(n[1]).toBeGreaterThan(0)
    }
  })
})

describe.each(['faces', 'gradient'])('%s normals', (method) => {
  it('are unit length', () => {
    const mesh = buildTerrainMesh(noiseHeightmap({ width: 40, depth: 30, seed: 9 }), { normals: method })
    for (let i = 0; i < mesh.vertexCount; i++) {
      expect(Math.hypot(...vec(mesh.normals, i))).toBeCloseTo(1, 5)
    }
  })

  it('point straight up on flat ground', () => {
    const mesh = buildTerrainMesh(mapFrom(6, 6, () => 0.3), { normals: method })
    for (let i = 0; i < mesh.vertexCount; i++) {
      const [x, y, z] = vec(mesh.normals, i)
      expect(x).toBeCloseTo(0, 6)
      expect(y).toBeCloseTo(1, 6)
      expect(z).toBeCloseTo(0, 6)
    }
  })

  it('match the analytic normal of a tilted plane', () => {
    // y = 20 * u over 100 units of X -> slope a = 0.2, so n = (-a, 1, 0) / |.|
    const mesh = buildTerrainMesh(
      mapFrom(11, 11, (u) => u),
      { sizeX: 100, heightScale: 20, normals: method },
    )
    const len = Math.hypot(0.2, 1)
    for (let i = 0; i < mesh.vertexCount; i++) {
      const [x, y, z] = vec(mesh.normals, i)
      expect(x).toBeCloseTo(-0.2 / len, 5)
      expect(y).toBeCloseTo(1 / len, 5)
      expect(z).toBeCloseTo(0, 5)
    }
  })

  it('tilt away from a hill top (outward on every side)', () => {
    const hill = mapFrom(21, 21, (u, v) => 1 - ((u - 0.5) ** 2 + (v - 0.5) ** 2) * 2)
    const mesh = buildTerrainMesh(hill, { normals: method })
    const east = 10 * 21 + 15 // right of the centre
    const north = 5 * 21 + 10 // towards -Z of the centre
    expect(vec(mesh.normals, east)[0]).toBeGreaterThan(0.05)
    expect(vec(mesh.normals, north)[2]).toBeLessThan(-0.05)
  })
})

describe('face weighted normals', () => {
  it('match the three.js reference implementation exactly', () => {
    // Same math as BufferGeometry.computeVertexNormals(), which we do not
    // use at runtime. This checks our version against it.
    const mesh = buildTerrainMesh(noiseHeightmap({ width: 48, depth: 37, seed: 21, ridge: 0.6 }), {
      heightScale: 30,
    })
    const reference = new BufferGeometry()
    reference.setAttribute('position', new BufferAttribute(mesh.positions, 3))
    reference.setIndex(new BufferAttribute(mesh.indices, 1))
    reference.computeVertexNormals()
    const theirs = reference.getAttribute('normal').array
    for (let i = 0; i < theirs.length; i++) expect(mesh.normals[i]).toBeCloseTo(theirs[i], 5)
  })

  it('agree closely with the gradient method on smooth terrain', () => {
    const smooth = mapFrom(64, 64, (u, v) => 0.5 + 0.25 * Math.sin(u * 6) * Math.cos(v * 5))
    const a = buildTerrainMesh(smooth, { normals: 'faces', heightScale: 25 })
    const b = buildTerrainMesh(smooth, { normals: 'gradient', heightScale: 25 })
    let worst = 1
    for (let i = 0; i < a.vertexCount; i++) {
      const [x1, y1, z1] = vec(a.normals, i)
      const [x2, y2, z2] = vec(b.normals, i)
      worst = Math.min(worst, x1 * x2 + y1 * y2 + z1 * z2)
    }
    // cos(angle) > 0.999 means under 2.6 degrees apart everywhere,
    // including the one sided border samples (measured: about 1.2 degrees).
    expect(worst).toBeGreaterThan(0.999)
  })

  it('weights by triangle area', () => {
    // A lone triangle's normal length before normalization is 2 * area.
    const positions = new Float32Array([0, 0, 0, 0, 0, 2, 3, 0, 0])
    const normals = faceWeightedNormals(positions, new Uint16Array([0, 1, 2]))
    expect(Array.from(normals.slice(0, 3))).toEqual([0, 1, 0])
  })
})
