// Terrain fragment shader: height + slope coloring, Lambert lighting, fog.
// BANDS is set from JavaScript through material.defines.

uniform float uHeightScale;       // world height of a heightmap value of 1
uniform vec3  uBandColors[BANDS]; // linear RGB, from palette.js
uniform float uBandStops[BANDS];  // normalized heights where each band starts
uniform float uBlend;             // half width of the soft edge between bands
uniform vec3  uCliffColor;
uniform float uRockSlope;         // slope (1 - normal.y) where cliffs start

uniform vec3  uSunDirection;      // unit vector pointing TO the sun
uniform vec3  uSunColor;
uniform vec3  uSkyAmbient;
uniform vec3  uGroundAmbient;

uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uContours;          // number of contour lines, 0 = off
uniform float uGrid;              // UV grid lines per side, 0 = off
uniform int   uView;              // 0 shaded, 1 normals, 2 height, 3 lighting, 4 UV, 5 slope

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying float vHeight;

// Walk up the bands. Each band fades in over [stop - blend, stop + blend],
// so the color at h is the highest band whose stop is below h, with soft
// transitions instead of hard stripes.
vec3 heightColor(float h) {
  vec3 c = uBandColors[0];
  for (int i = 1; i < BANDS; i++) {
    c = mix(c, uBandColors[i], smoothstep(uBandStops[i] - uBlend, uBandStops[i] + uBlend, h));
  }
  return c;
}

vec3 terrainAlbedo(float h, vec3 n) {
  vec3 c = heightColor(h);
  // Steep faces show bare cliff whatever their height: grass does not stick
  // to walls. Beaches and the sea floor are left alone.
  float slope = 1.0 - n.y;
  float land = smoothstep(uBandStops[2], uBandStops[3], h);
  c = mix(c, uCliffColor, smoothstep(uRockSlope, uRockSlope + 0.12, slope) * land);
  // Snow holds on steeper ground than grass, so above the snow line it
  // covers slopes up to a steeper limit. Only near vertical walls stay bare.
  float snowLine = uBandStops[BANDS - 1];
  float snow = smoothstep(snowLine - uBlend, snowLine + uBlend, h)
             * (1.0 - smoothstep(uRockSlope + 0.2, uRockSlope + 0.32, slope));
  return mix(c, uBandColors[BANDS - 1], snow);
}

// Anti-aliased line: 1 on the line, 0 elsewhere. fwidth keeps the line
// about one pixel wide at any zoom level.
float gridLine(float coord) {
  float d = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
  return 1.0 - clamp(d, 0.0, 1.0);
}

void main() {
  // Interpolated normals are shorter than 1 between vertices, so
  // renormalize per pixel before any lighting math.
  vec3 n = normalize(vNormal);
  float h = uHeightScale > 0.0 ? clamp(vHeight / uHeightScale, 0.0, 1.0) : 0.0;

  // Lambert: diffuse light = max(N . L, 0). A face turned toward the sun
  // gets full light, a face at 90 degrees or more gets none.
  float diffuse = max(dot(n, normalize(uSunDirection)), 0.0);
  // Hemisphere ambient: faces pointing up see the sky, faces pointing
  // down see the ground. Keeps shadowed slopes readable instead of black.
  vec3 ambient = mix(uGroundAmbient, uSkyAmbient, n.y * 0.5 + 0.5);
  vec3 light = ambient + uSunColor * diffuse;

  vec3 color;
  if (uView == 1) {
    color = n * 0.5 + 0.5;                       // normal xyz as rgb
  } else if (uView == 2) {
    color = vec3(h);                             // raw height
  } else if (uView == 3) {
    color = vec3(0.8) * light;                   // lighting on a grey surface
  } else if (uView == 4) {
    vec2 checker = floor(vUv * 16.0);
    float cell = mod(checker.x + checker.y, 2.0);
    color = vec3(vUv, 0.0) * (0.75 + 0.25 * cell); // uv as red/green
  } else if (uView == 5) {
    color = mix(vec3(0.1, 0.5, 0.2), vec3(0.9, 0.2, 0.1), clamp((1.0 - n.y) * 2.0, 0.0, 1.0));
  } else {
    color = terrainAlbedo(h, n) * light;
  }

  if (uContours > 0.0) {
    color = mix(color, color * 0.35, gridLine(h * uContours) * 0.8);
  }
  if (uGrid > 0.0) {
    float g = max(gridLine(vUv.x * uGrid), gridLine(vUv.y * uGrid));
    color = mix(color, vec3(1.0), g * 0.6);
  }

  // Lit views (shaded, lighting only) are linear light: they get fog and
  // are converted to the screen's color space. The data views (normals,
  // height, UV, slope) are written as raw values so they can be read as is.
  bool lit = uView == 0 || uView == 3;
  if (lit) {
    // Exponential squared fog, so distant terrain fades into the sky.
    float dist = length(vWorldPos - cameraPosition);
    float fog = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
    color = mix(color, uFogColor, fog);
  }

  gl_FragColor = vec4(color, 1.0);
  if (lit) gl_FragColor = linearToOutputTexel(gl_FragColor);
}
