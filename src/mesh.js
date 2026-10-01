// Heightmap -> triangle mesh. Every array the GPU draws is built here by
// hand: positions, UVs, triangle indices and normals. No PlaneGeometry, no
// computeVertexNormals, no terrain helpers.

/**
 * @typedef {object} MeshData
 * @property {Float32Array} positions  xyz per vertex
 * @property {Float32Array} normals    unit xyz per vertex
 * @property {Float32Array} uvs        uv per vertex, in [0, 1]
 * @property {Uint16Array|Uint32Array} indices  3 per triangle
 * @property {number} vertexCount
 * @property {number} triangleCount
 * @property {number} sizeX
 * @property {number} sizeZ
 */

/**
 * Build the mesh arrays for a heightmap.
 *
 * Layout: the grid is centred on the origin in the XZ plane with +Y up.
 * Vertex (x, z) sits at index i = z * width + x.
 *
 *     X = x * dx - sizeX / 2
 *     Y = height(x, z) * heightScale
 *     Z = z * dz - sizeZ / 2
 *
 * dx and dz are equal, so the cells are square and a non-square heightmap
 * gives a non-square terrain instead of a stretched one.
 *
 * @param {import('./heightmap.js').Heightmap} heightmap
 * @param {object} options
 * @param {number} [options.sizeX=100]      world size along X
 * @param {number} [options.heightScale=20] world height of a heightmap value of 1
 * @param {'faces'|'gradient'} [options.normals='faces']
 * @returns {MeshData}
 */
export function buildTerrainMesh(heightmap, { sizeX = 100, heightScale = 20, normals = 'faces' } = {}) {
  const { width: W, depth: D, data } = heightmap
  const cell = sizeX / (W - 1)
  const sizeZ = cell * (D - 1)
  const vertexCount = W * D

  const positions = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)

  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x
      positions[i * 3] = x * cell - sizeX / 2
      positions[i * 3 + 1] = data[i] * heightScale
      positions[i * 3 + 2] = z * cell - sizeZ / 2
      // u runs with X. v is flipped because three.js textures have v = 0 at
      // the bottom of the image, while heightmap row 0 is the top row.
      uvs[i * 2] = x / (W - 1)
      uvs[i * 2 + 1] = 1 - z / (D - 1)
    }
  }

  const indices = buildGridIndices(W, D)
  const normalArray =
    normals === 'gradient'
      ? gradientNormals(heightmap, cell, heightScale)
      : faceWeightedNormals(positions, indices)

  return {
    positions,
    normals: normalArray,
    uvs,
    indices,
    vertexCount,
    triangleCount: indices.length / 3,
    sizeX,
    sizeZ,
  }
}

/**
 * Two triangles per grid cell.
 *
 *     a ---- b        a = (x, z)      b = (x + 1, z)
 *     |    / |        c = (x, z + 1)  d = (x + 1, z + 1)
 *     |  /   |
 *     c ---- d        triangles (a, c, b) and (b, c, d)
 *
 * The order matters: three.js treats counter-clockwise triangles as front
 * facing, and (c - a) x (b - a) = (0, 0, dz) x (dx, 0, 0) = (0, dz*dx, 0)
 * points up (+Y). So these triangles face the sky, and the same cross
 * product gives upward normals below.
 *
 * 16-bit indices halve the index buffer, but only up to index 65534:
 * WebGL2 always treats 65535 in a 16-bit index buffer as a "primitive
 * restart" marker, so a triangle using it would silently not be drawn.
 * So 16-bit is used up to 65535 vertices and 32-bit from 65536 on (which
 * includes the default 256 x 256 grid). three.js uses the same cut-off.
 */
export function buildGridIndices(W, D) {
  const cells = (W - 1) * (D - 1)
  const IndexArray = W * D - 1 >= 0xffff ? Uint32Array : Uint16Array
  const indices = new IndexArray(cells * 6)
  let k = 0
  for (let z = 0; z < D - 1; z++) {
    for (let x = 0; x < W - 1; x++) {
      const a = z * W + x
      const b = a + 1
      const c = a + W
      const d = c + 1
      indices[k++] = a
      indices[k++] = c
      indices[k++] = b
      indices[k++] = b
      indices[k++] = c
      indices[k++] = d
    }
  }
  return indices
}

/**
 * Smooth vertex normals from the triangles (the general mesh method).
 *
 * For a triangle stored as (v0, v1, v2), n = (v1 - v0) x (v2 - v0) is
 * perpendicular to it, points out of its front (counter-clockwise) side,
 * and its length is twice the triangle's area. Adding the un-normalized n
 * to all 3 corners and normalizing at the end gives each vertex the
 * area-weighted average of the faces around it, so large faces count more
 * than slivers.
 */
export function faceWeightedNormals(positions, indices) {
  const normals = new Float32Array(positions.length)
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t] * 3
    const ib = indices[t + 1] * 3
    const ic = indices[t + 2] * 3

    // Edges from v0 to v1 and from v0 to v2.
    const e1x = positions[ib] - positions[ia]
    const e1y = positions[ib + 1] - positions[ia + 1]
    const e1z = positions[ib + 2] - positions[ia + 2]
    const e2x = positions[ic] - positions[ia]
    const e2y = positions[ic + 1] - positions[ia + 1]
    const e2z = positions[ic + 2] - positions[ia + 2]

    // n = e1 x e2 (right hand rule)
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x

    normals[ia] += nx
    normals[ia + 1] += ny
    normals[ia + 2] += nz
    normals[ib] += nx
    normals[ib + 1] += ny
    normals[ib + 2] += nz
    normals[ic] += nx
    normals[ic + 1] += ny
    normals[ic + 2] += nz
  }
  return normalizeAll(normals)
}

/**
 * Normals straight from the height field (the heightmap specific method).
 *
 * The surface is y = h(x, z), which is the level set F = y - h(x, z) = 0.
 * Its gradient (-dh/dx, 1, -dh/dz) is perpendicular to the surface.
 * The slopes come from central differences on the grid:
 *
 *     dh/dx ~ (h[x+1] - h[x-1]) / (2 * cell)
 *
 * with one sided differences on the border. Heights are in world units
 * (value * heightScale), otherwise the slope would ignore the vertical scale.
 */
export function gradientNormals(heightmap, cell, heightScale) {
  const { width: W, depth: D, data } = heightmap
  const normals = new Float32Array(W * D * 3)
  for (let z = 0; z < D; z++) {
    const z0 = Math.max(0, z - 1)
    const z1 = Math.min(D - 1, z + 1)
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - 1)
      const x1 = Math.min(W - 1, x + 1)
      const dhdx = ((data[z * W + x1] - data[z * W + x0]) * heightScale) / ((x1 - x0) * cell)
      const dhdz = ((data[z1 * W + x] - data[z0 * W + x]) * heightScale) / ((z1 - z0) * cell)
      const i = (z * W + x) * 3
      normals[i] = -dhdx
      normals[i + 1] = 1
      normals[i + 2] = -dhdz
    }
  }
  return normalizeAll(normals)
}

function normalizeAll(normals) {
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1
    normals[i] /= len
    normals[i + 1] /= len
    normals[i + 2] /= len
  }
  return normals
}

/**
 * Line segments from each vertex along its normal, to check the normals by
 * eye. Only every `step`-th vertex is used so dense meshes stay readable.
 */
export function normalLinePositions(mesh, width, depth, { length = 1.5, step = 1 } = {}) {
  const segments = []
  for (let z = 0; z < depth; z += step) {
    for (let x = 0; x < width; x += step) {
      const i = (z * width + x) * 3
      const px = mesh.positions[i]
      const py = mesh.positions[i + 1]
      const pz = mesh.positions[i + 2]
      segments.push(px, py, pz, px + mesh.normals[i] * length, py + mesh.normals[i + 1] * length, pz + mesh.normals[i + 2] * length)
    }
  }
  return new Float32Array(segments)
}
