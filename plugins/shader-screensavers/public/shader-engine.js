'use strict';

/* cspell:ignore highp Truchet truchet webglcontextlost webglcontextrestored */

(() => {
  const vertexSource = `
    attribute vec2 aPosition;
    void main() {
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;

  const fragmentSource = `
    precision highp float;

    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uSpeed;
    uniform float uScale;
    uniform float uBrightness;
    uniform float uPatternOpacity;
    uniform float uBackgroundOpacity;
    uniform float uScene;
    uniform float uPreviousScene;
    uniform float uTransition;
    uniform vec3 uColorA;
    uniform vec3 uColorB;
    uniform vec3 uBackground;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    float noise21(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
        mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), f.x), f.y);
    }

    float fbm(vec2 p) {
      float value = 0.0;
      float amplitude = 0.5;
      mat2 rotation = mat2(0.80, -0.60, 0.60, 0.80);
      for (int i = 0; i < 5; i++) {
        value += amplitude * noise21(p);
        p = rotation * p * 2.03 + 17.1;
        amplitude *= 0.5;
      }
      return value;
    }

    vec4 truchet(vec2 uv, float time) {
      float zoom = mix(2.4, 10.5, uScale);
      vec2 p = uv * zoom + vec2(time * 0.12, time * 0.035);
      vec2 cell = floor(p);
      vec2 tile = fract(p);
      if (hash21(cell) > 0.5) tile.x = 1.0 - tile.x;
      float d = min(abs(length(tile) - 0.5), abs(length(tile - 1.0) - 0.5));
      float line = 1.0 - smoothstep(0.025, 0.09, d);
      float halo = exp(-d * 16.0) * 0.72;
      float pulse = 0.5 + 0.5 * sin(time * 1.4 + hash21(cell) * 6.283);
      vec3 ink = mix(uColorA, uColorB, pulse);
      vec3 color = uBackground + ink * (line * 0.86 + halo * 0.58);
      return vec4(color, max(line, halo * 0.72));
    }

    vec4 aurora(vec2 uv, float time) {
      float zoom = mix(0.75, 2.3, uScale);
      vec2 p = uv * zoom;
      float drift = time * 0.15;
      float warp = fbm(vec2(p.x * 0.65 + drift, p.y * 0.38)) - 0.5;
      float veilA = exp(-abs(p.y + 0.28 + warp * 0.92 + sin(p.x * 1.3 + drift) * 0.1) * 3.8);
      float veilB = exp(-abs(p.y - 0.18 + fbm(p * 0.72 - drift * 0.7) * 0.8 - 0.38) * 5.2);
      float shimmer = 0.72 + 0.28 * noise21(vec2(p.x * 3.0 - drift, p.y * 1.4));
      float light = clamp((veilA * 0.8 + veilB * 0.62) * shimmer, 0.0, 1.0);
      vec3 ink = mix(uColorB, uColorA, clamp(veilA, 0.0, 1.0));
      vec3 color = uBackground + ink * light * 1.15;
      return vec4(color, light);
    }

    vec4 plasma(vec2 uv, float time) {
      float zoom = mix(1.25, 4.6, uScale);
      vec2 p = uv * zoom;
      p += vec2(sin(p.y * 0.9 + time * 0.32), cos(p.x * 0.8 - time * 0.24)) * 0.32;
      float field = sin(p.x * 1.3 + time * 0.55);
      field += sin(p.y * 1.7 - time * 0.41);
      field += sin(length(p + vec2(sin(time * 0.2), cos(time * 0.17))) * 2.15 - time * 0.5);
      field = 0.5 + 0.5 * sin(field * 1.7);
      float ridge = pow(1.0 - abs(field * 2.0 - 1.0), 2.2);
      vec3 ink = mix(uColorA, uColorB, smoothstep(0.08, 0.92, field));
      vec3 color = mix(uBackground, ink, field * 0.72) + ink * ridge * 0.38;
      return vec4(color, clamp(field * 0.78 + ridge * 0.5, 0.0, 1.0));
    }

    vec4 topography(vec2 uv, float time) {
      float zoom = mix(1.4, 5.8, uScale);
      vec2 p = uv * zoom + vec2(time * 0.035, -time * 0.025);
      float height = fbm(p * 0.72 + fbm(p * 0.31 + time * 0.04));
      float bands = abs(fract(height * 11.0 - time * 0.06) - 0.5);
      float contour = 1.0 - smoothstep(0.035, 0.12, bands);
      float terrain = smoothstep(0.18, 0.88, height);
      vec3 ink = mix(uColorB, uColorA, terrain);
      vec3 color = uBackground + ink * (contour * 0.86 + terrain * 0.1);
      return vec4(color, clamp(contour + terrain * 0.16, 0.0, 1.0));
    }

    vec4 scene(float id, vec2 uv, float time) {
      if (id < 0.5) return truchet(uv, time);
      if (id < 1.5) return aurora(uv, time);
      if (id < 2.5) return plasma(uv, time);
      return topography(uv, time);
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution.xy) / min(uResolution.x, uResolution.y);
      float time = uTime * mix(0.0, 1.45, uSpeed);
      vec4 layer;
      if (uTransition >= 0.999) {
        layer = scene(uScene, uv, time);
      } else {
        vec4 previous = scene(uPreviousScene, uv, time);
        vec4 current = scene(uScene, uv, time);
        layer = mix(previous, current, smoothstep(0.0, 1.0, uTransition));
      }
      vec3 color = mix(uBackground, max(layer.rgb, 0.0), uPatternOpacity) * uBrightness;
      float alpha = mix(uBackgroundOpacity, 1.0, clamp(layer.a * uPatternOpacity, 0.0, 1.0));
      gl_FragColor = vec4(color * alpha, alpha);
    }
  `;

  const sceneIds = { truchet: 0, aurora: 1, plasma: 2, topography: 3 };

  const compile = (gl, type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message || 'Не удалось собрать WebGL shader');
    }
    return shader;
  };

  const hex = value => {
    const match = /^#([0-9a-f]{6})$/i.exec(value || '');
    if (!match) return [0, 0, 0];
    const number = Number.parseInt(match[1], 16);
    return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255];
  };

  class ShaderField {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        depth: false,
        powerPreference: 'high-performance',
        premultipliedAlpha: true,
      });
      if (!this.gl) throw new Error('WebGL недоступен на этом устройстве');

      const gl = this.gl;
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || 'Не удалось связать WebGL-программу');
      }
      this.program = program;
      this.uniforms = {};
      [
        'uResolution',
        'uTime',
        'uSpeed',
        'uScale',
        'uBrightness',
        'uPatternOpacity',
        'uBackgroundOpacity',
        'uScene',
        'uPreviousScene',
        'uTransition',
        'uColorA',
        'uColorB',
        'uBackground',
      ].forEach(name => {
        this.uniforms[name] = gl.getUniformLocation(program, name);
      });

      const position = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, position);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.useProgram(program);
      const location = gl.getAttribLocation(program, 'aPosition');
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

      this.state = null;
      this.scene = 0;
      this.previousScene = 0;
      this.transitionStarted = performance.now() - 800;
      this.started = performance.now();
      this.frozenAt = 0;
      this.visible = true;
      this.framePending = false;
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
      this.resize();

      document.addEventListener('visibilitychange', () => {
        this.visible = !document.hidden;
        if (this.visible) this.requestDraw();
      });
      canvas.addEventListener('webglcontextlost', event => event.preventDefault());
      canvas.addEventListener('webglcontextrestored', () => location.reload());
      this.requestDraw();
    }

    apply(state) {
      if (!state) return;
      const nextScene = sceneIds[state.scene] ?? 0;
      if (this.state && nextScene !== this.scene) {
        this.previousScene = this.scene;
        this.scene = nextScene;
        this.transitionStarted = performance.now();
      } else if (!this.state) {
        this.scene = nextScene;
        this.previousScene = nextScene;
      }
      if (this.state?.animate && !state.animate) {
        this.frozenAt = (performance.now() - this.started) / 1000;
      } else if (this.state && !this.state.animate && state.animate) {
        this.started = performance.now() - this.frozenAt * 1000;
      }
      this.state = state;
      this.requestDraw();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * pixelRatio));
      const height = Math.max(1, Math.round(rect.height * pixelRatio));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.requestDraw();
      }
    }

    requestDraw() {
      if (!this.visible || this.framePending) return;
      this.framePending = true;
      requestAnimationFrame(now => {
        this.framePending = false;
        this.draw(now);
      });
    }

    draw(now) {
      if (!this.visible) return;
      const state = this.state;
      if (state) {
        const gl = this.gl;
        const time = state.animate ? (now - this.started) / 1000 : this.frozenAt;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.program);
        gl.uniform2f(this.uniforms.uResolution, this.canvas.width, this.canvas.height);
        gl.uniform1f(this.uniforms.uTime, time);
        gl.uniform1f(this.uniforms.uSpeed, state.speed / 100);
        gl.uniform1f(this.uniforms.uScale, state.scale / 100);
        gl.uniform1f(this.uniforms.uBrightness, state.brightness / 100);
        gl.uniform1f(this.uniforms.uPatternOpacity, state.patternOpacity / 100);
        gl.uniform1f(this.uniforms.uBackgroundOpacity, state.backgroundOpacity / 100);
        gl.uniform1f(this.uniforms.uScene, this.scene);
        gl.uniform1f(this.uniforms.uPreviousScene, this.previousScene);
        gl.uniform1f(this.uniforms.uTransition, Math.min(1, (now - this.transitionStarted) / 720));
        gl.uniform3fv(this.uniforms.uColorA, hex(state.colorA));
        gl.uniform3fv(this.uniforms.uColorB, hex(state.colorB));
        gl.uniform3fv(this.uniforms.uBackground, hex(state.background));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (state.animate || now - this.transitionStarted < 720) this.requestDraw();
      }
    }
  }

  window.ShaderField = ShaderField;
})();
