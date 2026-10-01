// Terrain vertex shader.
// three.js injects: position, normal, uv (attributes) and
// modelMatrix, viewMatrix, projectionMatrix, cameraPosition (uniforms).

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying float vHeight;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;

  // World space normal. mat3(modelMatrix) is enough for rotation and uniform
  // scale. A non-uniform scale would need the inverse transpose instead.
  vNormal = normalize(mat3(modelMatrix) * normal);

  vUv = uv;
  vHeight = position.y;
  gl_Position = projectionMatrix * viewMatrix * world;
}
