// Materials for the terrain: the custom GLSL one (default) and a vertex
// color one that goes through three.js's built-in Lambert lighting.

import { BufferAttribute, Color, MeshLambertMaterial, ShaderMaterial, Vector3 } from 'three'
import { BAND_COUNT, COLORS, makeTerrainColorizer } from './palette.js'
import fragmentShader from './shaders/terrain.frag.glsl?raw'
import vertexShader from './shaders/terrain.vert.glsl?raw'

export const VIEWS = {
  Shaded: 0,
  'Normals (xyz as rgb)': 1,
  Height: 2,
  'Lighting only': 3,
  'UV coordinates': 4,
  Slope: 5,
}

export function createTerrainShaderMaterial() {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    defines: { BANDS: BAND_COUNT },
    uniforms: {
      uHeightScale: { value: 20 },
      uBandColors: { value: Array.from({ length: BAND_COUNT }, () => new Color()) },
      uBandStops: { value: new Array(BAND_COUNT).fill(0) },
      uBlend: { value: 0.02 },
      uCliffColor: { value: new Color(COLORS.cliff) },
      uRockSlope: { value: 0.35 },
      uSunDirection: { value: new Vector3(0, 1, 0) },
      uSunColor: { value: new Color(1, 1, 1) },
      uSkyAmbient: { value: new Color(0.3, 0.35, 0.45) },
      uGroundAmbient: { value: new Color(0.12, 0.1, 0.08) },
      uFogColor: { value: new Color(0.7, 0.8, 0.9) },
      uFogDensity: { value: 0.004 },
      uContours: { value: 0 },
      uGrid: { value: 0 },
      uView: { value: 0 },
    },
  })
}

/** Push band colors and stops into the shader. Instant, no mesh rebuild. */
export function applyBands(material, bands) {
  bands.forEach((band, i) => {
    material.uniforms.uBandColors.value[i].set(band.color)
    material.uniforms.uBandStops.value[i] = band.stop
  })
}

export function createVertexColorMaterial() {
  return new MeshLambertMaterial({ vertexColors: true })
}

/**
 * Fill the geometry's color attribute on the CPU, using the same band and
 * slope rules as the shader. Used by the "Vertex colors + Lambert" mode.
 */
export function writeVertexColors(geometry, mesh, bands, heightScale, options) {
  // Reuse the attribute and flag it for upload. Creating a new one on every
  // slider move would leak a GPU buffer each time.
  let attribute = geometry.getAttribute('color')
  if (!attribute || attribute.count !== mesh.vertexCount) {
    attribute = new BufferAttribute(new Float32Array(mesh.vertexCount * 3), 3)
    geometry.setAttribute('color', attribute)
  }
  const colors = attribute.array
  const colorize = makeTerrainColorizer(bands, options)
  const inverseScale = heightScale > 0 ? 1 / heightScale : 0
  for (let i = 0; i < mesh.vertexCount; i++) {
    colorize(mesh.positions[i * 3 + 1] * inverseScale, mesh.normals[i * 3 + 1], colors, i * 3)
  }
  attribute.needsUpdate = true
}
