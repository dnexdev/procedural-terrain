// App wiring: scene, lights, GUI, and the rebuild pipeline
//   heightmap -> mesh arrays -> BufferGeometry -> shader uniforms
//
// The math lives in noise.js, heightmap.js, mesh.js and the GLSL files.
// This file only decides what to rebuild when a control changes.

// Fonts are bundled (latin subset only), so there is no third party request
// and the page also works offline.
import '@fontsource/instrument-serif/latin-400.css'
import '@fontsource/instrument-serif/latin-400-italic.css'
import '@fontsource/martian-mono/latin-400.css'
import '@fontsource/martian-mono/latin-500.css'
import './style.css'
import GUI from 'lil-gui'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Heightmap, noiseHeightmap } from './heightmap.js'
import {
  VIEWS,
  applyBands,
  createTerrainShaderMaterial,
  createVertexColorMaterial,
  writeVertexColors,
} from './material.js'
import { buildTerrainMesh, normalLinePositions } from './mesh.js'
import { computeBands } from './palette.js'

// ------------------------------------------------------------------ state

const params = {
  source: 'noise',
  seed: 1337,
  frequency: 2.4,
  octaves: 7,
  persistence: 0.48,
  lacunarity: 2.1,
  ridge: 0.45,
  exponent: 1.7,
  island: 0.7,
  smoothing: 2,

  resolution: 256,
  size: 100,
  heightScale: 26,
  normals: 'faces',
  wireframe: false,
  showNormals: false,

  shading: 'shader',
  view: VIEWS.Shaded,
  waterLevel: 0.24,
  snowLine: 0.74,
  rockSlope: 0.38,
  blend: 0.02,
  contours: 0,
  grid: 0,
  fog: 2.5, // density x 1000, so the slider reads nicely

  sunAzimuth: 225,
  sunElevation: 32,
  animateSun: false,
  autoRotate: false,
}

// Slider ranges [min, max, step] and dropdown options. Used by the GUI and
// to validate values coming from the URL.
const LIMITS = {
  seed: [1, 9999, 1],
  frequency: [0.5, 8, 0.1],
  octaves: [1, 10, 1],
  persistence: [0.2, 0.8, 0.01],
  lacunarity: [1.5, 3, 0.05],
  ridge: [0, 1, 0.01],
  exponent: [0.5, 3, 0.05],
  island: [0, 1, 0.01],
  smoothing: [0, 6, 1],
  size: [40, 200, 1],
  heightScale: [1, 60, 0.5],
  waterLevel: [0, 0.6, 0.005],
  snowLine: [0.3, 1, 0.005],
  rockSlope: [0.05, 0.9, 0.01],
  blend: [0.001, 0.08, 0.001],
  contours: [0, 40, 1],
  grid: [0, 32, 1],
  fog: [0, 12, 0.1],
  sunAzimuth: [0, 360, 1],
  sunElevation: [-5, 90, 0.5],
}
const CHOICES = {
  source: { 'Fractal noise': 'noise', Image: 'image' },
  resolution: [32, 64, 128, 256, 512, 1024],
  normals: { 'Face weighted (cross products)': 'faces', 'Central differences (gradient)': 'gradient' },
  shading: { 'Custom GLSL shader': 'shader', 'Vertex colors + Lambert': 'lambert' },
  view: VIEWS,
}
const SNOW_ABOVE_WATER = 0.1

// Any param can be set from the URL, e.g. ?seed=42&view=1&resolution=512.
// Values are clamped to the slider ranges and checked against the options.
for (const [key, raw] of new URLSearchParams(location.search)) {
  if (!(key in params)) continue
  if (typeof params[key] === 'boolean') {
    params[key] = raw === 'true'
    continue
  }
  const value = typeof params[key] === 'number' ? Number(raw) : raw
  if (key in CHOICES) {
    if (Object.values(CHOICES[key]).includes(value)) params[key] = value
  } else if (key in LIMITS && Number.isFinite(value)) {
    const [min, max] = LIMITS[key]
    params[key] = Math.min(max, Math.max(min, value))
  }
}
params.snowLine = Math.max(params.snowLine, params.waterLevel + SNOW_ABOVE_WATER)

let heightmap = null
let mesh = null
let sourceImage = null
const timings = { heightmap: 0, mesh: 0 }
// What needs recomputing before the next frame. Slider drags fire many
// events per frame, this collapses them into one rebuild.
const dirty = { heightmap: true, mesh: true, colors: true }

function invalidate(level) {
  if (level === 'heightmap') dirty.heightmap = true
  if (level === 'heightmap' || level === 'mesh') dirty.mesh = true
  dirty.colors = true
}

// ------------------------------------------------------------------ scene

const canvas = document.getElementById('scene')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)

const scene = new THREE.Scene()
scene.fog = new THREE.FogExp2(0xffffff, params.fog / 1000)

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.5, 4000)
camera.position.set(-78, 62, 92)
// Portrait screens see less width, so start further back to fit the terrain.
camera.position.multiplyScalar(Math.max(1, 0.9 / camera.aspect))
const controls = new OrbitControls(camera, canvas)
controls.enableDamping = true
controls.target.set(0, 6, 0)
controls.maxPolarAngle = Math.PI * 0.48
controls.minDistance = 15
controls.maxDistance = 600

// These three.js lights light the water and the "vertex colors + Lambert"
// mode. The custom shader gets the exact same values as uniforms.
const sun = new THREE.DirectionalLight()
const hemi = new THREE.HemisphereLight()
scene.add(sun, sun.target, hemi)

const shaderMaterial = createTerrainShaderMaterial()
const lambertMaterial = createVertexColorMaterial()
const terrain = new THREE.Mesh(new THREE.BufferGeometry(), shaderMaterial)
scene.add(terrain)

const water = new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshPhongMaterial({
    color: 0x1b5a74,
    specular: 0x8fb3c4,
    shininess: 80,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
  }),
)
water.renderOrder = 1
scene.add(water)

const normalLines = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xff2f6d }),
)
scene.add(normalLines)

// ------------------------------------------------------------------ build

function imageHeightmap(image, resolution, smoothing) {
  // Resample the image to the grid with the browser's high quality filter,
  // keeping its aspect ratio.
  const width = resolution
  const depth = Math.max(2, Math.round(((resolution - 1) * image.height) / image.width) + 1)
  const c = document.createElement('canvas')
  c.width = width
  c.height = depth
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, width, depth)
  const { data } = ctx.getImageData(0, 0, width, depth)
  return Heightmap.fromRGBA(data, width, depth).blurred(smoothing).normalized()
}

function rebuildHeightmap() {
  const t0 = performance.now()
  heightmap =
    params.source === 'image' && sourceImage
      ? imageHeightmap(sourceImage, params.resolution, params.smoothing)
      : noiseHeightmap({
          width: params.resolution,
          depth: params.resolution,
          seed: params.seed,
          frequency: params.frequency,
          octaves: params.octaves,
          persistence: params.persistence,
          lacunarity: params.lacunarity,
          ridge: params.ridge,
          exponent: params.exponent,
          island: params.island,
        })
  timings.heightmap = performance.now() - t0
}

function toGeometry(data) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2))
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1))
  // Bounds for frustum culling only. Normals are ours, see mesh.js.
  geometry.computeBoundingSphere()
  return geometry
}

function replaceGeometry(object, geometry) {
  // GPU buffers cannot be resized in place, so swap and free the old ones.
  object.geometry.dispose()
  object.geometry = geometry
}

function rebuildMesh() {
  const t0 = performance.now()
  mesh = buildTerrainMesh(heightmap, {
    sizeX: params.size,
    heightScale: params.heightScale,
    normals: params.normals,
  })
  timings.mesh = performance.now() - t0
  replaceGeometry(terrain, toGeometry(mesh))

  // The water is a flat 2 x 2 heightmap through the same builder.
  const flat = new Heightmap(2, 2, new Float32Array(4))
  replaceGeometry(water, toGeometry(buildTerrainMesh(flat, { sizeX: mesh.sizeX, heightScale: 0 })))
  water.scale.z = mesh.sizeZ / mesh.sizeX

  const step = Math.max(1, Math.round(heightmap.width / 56))
  const lines = new THREE.BufferGeometry()
  lines.setAttribute(
    'position',
    new THREE.BufferAttribute(
      normalLinePositions(mesh, heightmap.width, heightmap.depth, { length: params.size / 45, step }),
      3,
    ),
  )
  replaceGeometry(normalLines, lines)
  updateStats()
}

// ------------------------------------------------------------------ uniforms

function refreshShading() {
  const bands = computeBands(params)
  const u = shaderMaterial.uniforms
  applyBands(shaderMaterial, bands)
  u.uHeightScale.value = params.heightScale
  u.uBlend.value = params.blend
  u.uRockSlope.value = params.rockSlope
  u.uContours.value = params.contours
  u.uGrid.value = params.grid
  u.uView.value = Number(params.view)
  u.uFogDensity.value = params.fog / 1000
  scene.fog.density = params.fog / 1000

  for (const m of [shaderMaterial, lambertMaterial]) m.wireframe = params.wireframe
  terrain.material = params.shading === 'lambert' ? lambertMaterial : shaderMaterial
  if (params.shading === 'lambert' && mesh) {
    writeVertexColors(terrain.geometry, mesh, bands, params.heightScale, {
      blend: params.blend,
      rockSlope: params.rockSlope,
    })
  }

  water.position.y = params.waterLevel * params.heightScale
  // Hide the water when it would get in the way of inspecting the mesh.
  water.visible = !params.wireframe && (params.view === VIEWS.Shaded || params.shading === 'lambert')
  normalLines.visible = params.showNormals
  renderLegend(bands)
}

const DUSK = { sun: new THREE.Color(1.0, 0.5, 0.26), sky: new THREE.Color('#e3a27c') }
const NOON = { sun: new THREE.Color(1.0, 0.96, 0.9), sky: new THREE.Color('#a9c6d8') }
const GROUND = new THREE.Color('#4a3d2e')

function refreshSun() {
  const az = THREE.MathUtils.degToRad(params.sunAzimuth)
  const el = THREE.MathUtils.degToRad(params.sunElevation)
  // Spherical to Cartesian, +Y up. This vector points toward the sun.
  const dir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))

  // Low sun: warmer, dimmer light and an orange sky. Below the horizon the
  // direct light fades out completely.
  const day = THREE.MathUtils.smoothstep(dir.y, -0.02, 0.45)
  const sunColor = new THREE.Color()
    .lerpColors(DUSK.sun, NOON.sun, day)
    .multiplyScalar(THREE.MathUtils.smoothstep(dir.y, -0.08, 0.05) * (0.55 + 0.6 * day))
  const sky = new THREE.Color().lerpColors(DUSK.sky, NOON.sky, day)
  const skyAmbient = sky.clone().multiplyScalar(0.36)
  const groundAmbient = GROUND.clone().multiplyScalar(0.35)

  const u = shaderMaterial.uniforms
  u.uSunDirection.value.copy(dir)
  u.uSunColor.value.copy(sunColor)
  u.uSkyAmbient.value.copy(skyAmbient)
  u.uGroundAmbient.value.copy(groundAmbient)
  u.uFogColor.value.copy(sky)

  // three.js lights divide by pi in their Lambert BRDF, so scale by pi to
  // get the same brightness as the shader's plain N.L.
  sun.position.copy(dir).multiplyScalar(300)
  sun.color.copy(sunColor)
  sun.intensity = Math.PI
  hemi.color.copy(skyAmbient)
  hemi.groundColor.copy(groundAmbient)
  hemi.intensity = Math.PI

  scene.background = sky
  scene.fog.color.copy(sky)
}

// ------------------------------------------------------------------ HUD

const $ = (id) => document.getElementById(id)

function updateStats() {
  $('stat-grid').textContent = `${heightmap.width} × ${heightmap.depth}`
  $('stat-vertices').textContent = mesh.vertexCount.toLocaleString()
  $('stat-triangles').textContent = mesh.triangleCount.toLocaleString()
  $('stat-heightmap').textContent = `${timings.heightmap.toFixed(1)} ms`
  $('stat-mesh').textContent = `${timings.mesh.toFixed(1)} ms`
}

function renderLegend(bands) {
  const pct = (v) => `${(Math.min(1, Math.max(0, v)) * 100).toFixed(1)}%`
  const stops = [`${bands[0].color} 0%`]
  for (let i = 1; i < bands.length; i++) {
    stops.push(`${bands[i - 1].color} ${pct(bands[i].stop - params.blend)}`)
    stops.push(`${bands[i].color} ${pct(bands[i].stop + params.blend)}`)
  }
  $('legend-bar').style.background = `linear-gradient(to right, ${stops.join(', ')})`
  const marks = [
    ['sea level', bands[2].stop],
    ['tree line', bands[4].stop],
    ['snow line', bands[6].stop],
  ]
  // Put each label on the first row where it does not overlap the previous
  // one, so they stay readable when the lines are close together.
  const width = $('legend-bar').clientWidth || 300
  const rowEnds = []
  const html = marks.map(([label, at]) => {
    const x = Math.min(1, Math.max(0, at)) * width
    const half = label.length * 3.3
    let row = rowEnds.findIndex((end) => x - half > end + 6)
    if (row === -1) row = rowEnds.push(0) - 1
    rowEnds[row] = x + half
    return `<span class="${row ? 'stacked' : ''}" style="left:${pct(at)};top:${5 + row * 12}px">${label}</span>`
  })
  $('legend-labels').innerHTML = html.join('')
  $('legend-labels').style.height = `${8 + rowEnds.length * 12}px`
  $('legend-mode').textContent = params.shading === 'lambert' ? '· vertex colors' : '· glsl shader'
}

// ------------------------------------------------------------------ images

function setSource(source) {
  params.source = source
  gui.controllersRecursive().forEach((c) => c.updateDisplay())
  syncControls()
  invalidate('heightmap')
}

async function useImage(blob) {
  try {
    // Read the raw pixel values: no color profile conversion, no alpha
    // premultiplication, since both would change the heights.
    sourceImage = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  } catch {
    notify('That file could not be read as an image.')
    if (!sourceImage) setSource('noise')
    return
  }
  setSource('image')
}

async function loadSample() {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}heightmaps/sample.png`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    await useImage(await response.blob())
  } catch {
    notify('The sample image could not be loaded.')
    setSource('noise')
  }
}

let toastTimer = 0
function notify(message) {
  const toast = $('toast')
  toast.textContent = message
  toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500)
}

function exportPng() {
  const c = document.createElement('canvas')
  c.width = heightmap.width
  c.height = heightmap.depth
  c.getContext('2d').putImageData(new ImageData(heightmap.toRGBA(), heightmap.width, heightmap.depth), 0, 0)
  c.toBlob((blob) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `heightmap-${params.source === 'noise' ? `seed-${params.seed}` : 'image'}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  })
}

const fileInput = $('file')
fileInput.addEventListener('change', () => fileInput.files[0] && useImage(fileInput.files[0]))

const dropZone = $('drop')
let dragDepth = 0
window.addEventListener('dragenter', (e) => {
  e.preventDefault()
  dragDepth++
  dropZone.classList.add('active')
})
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dropZone.classList.remove('active')
})
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  dropZone.classList.remove('active')
  const file = e.dataTransfer?.files?.[0]
  if (file && file.type.startsWith('image/')) useImage(file)
})

// ------------------------------------------------------------------ GUI

const actions = {
  randomSeed() {
    params.seed = Math.floor(Math.random() * 9999) + 1
    seedControl.updateDisplay()
    invalidate('heightmap')
  },
  loadImage: () => fileInput.click(),
  loadSample: () => loadSample(),
  exportPng,
}

const gui = new GUI({ title: 'Controls', width: 300 })
if (window.innerWidth < 720) gui.close()
const rebuild = (level) => () => invalidate(level)
// Numeric slider with the shared range, rebuilding `level` on change.
const slider = (folder, key, name, level) =>
  folder
    .add(params, key, ...LIMITS[key])
    .name(name)
    .onChange(rebuild(level))

const fHeight = gui.addFolder('Heightmap')
fHeight.add(params, 'source', CHOICES.source).onChange(() => {
  if (params.source === 'image' && !sourceImage) loadSample()
  else setSource(params.source)
})
const seedControl = slider(fHeight, 'seed', 'seed', 'heightmap')
const noiseControls = [
  seedControl,
  fHeight.add(actions, 'randomSeed').name('random seed'),
  slider(fHeight, 'frequency', 'frequency', 'heightmap'),
  slider(fHeight, 'octaves', 'octaves', 'heightmap'),
  slider(fHeight, 'persistence', 'persistence', 'heightmap'),
  slider(fHeight, 'lacunarity', 'lacunarity', 'heightmap'),
  slider(fHeight, 'ridge', 'ridged', 'heightmap'),
  slider(fHeight, 'exponent', 'redistribution', 'heightmap'),
  slider(fHeight, 'island', 'island falloff', 'heightmap'),
]
const imageControls = [slider(fHeight, 'smoothing', 'image smoothing', 'heightmap')]
fHeight.add(actions, 'loadImage').name('load image…')
fHeight.add(actions, 'loadSample').name('load sample image')
fHeight.add(actions, 'exportPng').name('export heightmap PNG')

function syncControls() {
  const noise = params.source === 'noise'
  noiseControls.forEach((c) => c.enable(noise))
  imageControls.forEach((c) => c.enable(!noise))
  viewControl.enable(params.shading === 'shader')
}

const fMesh = gui.addFolder('Mesh')
fMesh.add(params, 'resolution', CHOICES.resolution).name('grid size').onChange(rebuild('heightmap'))
slider(fMesh, 'size', 'world size', 'mesh')
slider(fMesh, 'heightScale', 'height scale', 'mesh')
fMesh.add(params, 'normals', CHOICES.normals).onChange(rebuild('mesh'))
fMesh.add(params, 'wireframe').onChange(rebuild('colors'))
fMesh.add(params, 'showNormals').name('show normals').onChange(rebuild('colors'))

const fShade = gui.addFolder('Shading')
fShade.add(params, 'shading', CHOICES.shading).onChange(() => {
  syncControls()
  invalidate('colors')
})
const viewControl = fShade.add(params, 'view', CHOICES.view).name('debug view').onChange(rebuild('colors'))
slider(fShade, 'waterLevel', 'water level', 'colors').onChange(() => {
  keepSnowAboveWater()
  invalidate('colors')
})
const snowControl = slider(fShade, 'snowLine', 'snow line', 'colors')
slider(fShade, 'rockSlope', 'cliff slope', 'colors')
slider(fShade, 'blend', 'band blend', 'colors')
slider(fShade, 'contours', 'contour lines', 'colors')
slider(fShade, 'grid', 'uv grid', 'colors')
slider(fShade, 'fog', 'fog', 'colors')

// The snow line slider cannot go below the water level, so what it shows
// is always what the shader uses.
function keepSnowAboveWater() {
  const min = Math.min(1, params.waterLevel + SNOW_ABOVE_WATER)
  snowControl.min(min)
  if (params.snowLine < min) params.snowLine = min
  snowControl.updateDisplay()
}

const fSun = gui.addFolder('Sun')
const azimuthControl = fSun
  .add(params, 'sunAzimuth', ...LIMITS.sunAzimuth)
  .name('azimuth')
  .onChange(refreshSun)
fSun
  .add(params, 'sunElevation', ...LIMITS.sunElevation)
  .name('elevation')
  .onChange(refreshSun)
fSun.add(params, 'animateSun').name('animate sun')
fSun.add(params, 'autoRotate').name('orbit camera')

syncControls()
keepSnowAboveWater()

// ------------------------------------------------------------------ loop

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

refreshSun()
if (params.source === 'image') loadSample()

const timer = new THREE.Timer()
renderer.setAnimationLoop((time) => {
  timer.update(time)
  const dt = timer.getDelta()
  // Flags are cleared first and errors caught, so one bad rebuild cannot
  // repeat every frame or stop the render loop.
  try {
    if (dirty.heightmap) {
      dirty.heightmap = false
      rebuildHeightmap()
    }
    if (dirty.mesh) {
      dirty.mesh = false
      rebuildMesh()
    }
    if (dirty.colors) {
      dirty.colors = false
      refreshShading()
    }
  } catch (error) {
    console.error(error)
    notify(`Rebuild failed: ${error.message}`)
  }
  if (params.animateSun) {
    params.sunAzimuth = (params.sunAzimuth + dt * 24) % 360
    azimuthControl.updateDisplay()
    refreshSun()
  }
  controls.autoRotate = params.autoRotate
  controls.update(dt)
  renderer.render(scene, camera)
})
