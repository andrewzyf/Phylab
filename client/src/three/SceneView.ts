import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import {
  accelerationAtIndex,
  bodyStateAt,
  boundingRadius,
  quat,
  rampGeometry,
  sampleIndexAt,
  vec,
  type Recording,
  type ResolvedLink,
  type ResolvedObject,
  type ResolvedScenario,
  type Vec3,
} from "@physicslab/shared";
import type { ViewOptions } from "../store";

export interface SceneTheme {
  background: string;
  ground: string;
  grid: string;
  gridMajor: string;
  text: string;
}

export interface SceneCallbacks {
  onSelect?: (id: string | null) => void;
  onMoved?: (id: string, position: Vec3) => void;
  onCameraChange?: () => void;
}

interface BodyVisual {
  obj: ResolvedObject;
  group: THREE.Group;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  trail?: THREE.Line;
  vel?: THREE.ArrowHelper;
  acc?: THREE.ArrowHelper;
  applied?: THREE.ArrowHelper;
  label?: CSS2DObject;
}

interface LinkVisual {
  link: ResolvedLink;
  object: THREE.Object3D;
  update: (a: THREE.Vector3, b: THREE.Vector3) => void;
  anchor?: THREE.Mesh;
}

const METALS = new Set(["steel", "iron", "aluminum", "gold", "lead"]);
const textureCache = new Map<string, THREE.Texture>();

/** Beach-ball style stripes so rotation (rolling vs sliding) is visible. */
function stripeTexture(color: string): THREE.Texture {
  const key = color;
  const cached = textureCache.get(key);
  if (cached) return cached;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d")!;
  const base = new THREE.Color(color);
  const light = base.clone().lerp(new THREE.Color("#ffffff"), 0.55);
  for (let i = 0; i < 8; i++) {
    g.fillStyle = `#${(i % 2 ? light : base).getHexString()}`;
    g.fillRect((i * c.width) / 8, 0, c.width / 8 + 1, c.height);
  }
  g.fillStyle = `#${base.clone().multiplyScalar(0.55).getHexString()}`;
  g.fillRect(0, c.height / 2 - 3, c.width, 6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  textureCache.set(key, tex);
  return tex;
}

function rampBufferGeometry(o: ResolvedObject): THREE.BufferGeometry {
  const g = rampGeometry(o.dims);
  const pos: number[] = [];
  for (const f of g.faces) {
    for (let i = 1; i < f.length - 1; i++) {
      for (const idx of [f[0], f[i], f[i + 1]]) pos.push(...g.vertices[idx]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

function geometryFor(o: ResolvedObject): THREE.BufferGeometry {
  const d = o.dims;
  switch (o.type) {
    case "sphere":
      return new THREE.SphereGeometry(d.radius, 48, 24);
    case "cylinder":
      return new THREE.CylinderGeometry(d.radius, d.radius, d.height, 48, 1, o.hollow && d.height > d.radius * 0.1);
    case "box":
    case "plate":
      return new THREE.BoxGeometry(d.width, d.height, d.depth);
    case "ramp":
      return rampBufferGeometry(o);
  }
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private transform: TransformControls;
  private labels: CSS2DRenderer;
  private bodies = new Map<string, BodyVisual>();
  private linkVisuals: LinkVisual[] = [];
  private world = new THREE.Group();
  private ground: THREE.Mesh;
  private grid = new THREE.Group();
  private axes: THREE.AxesHelper;
  private sun: THREE.DirectionalLight;
  private rs: ResolvedScenario | null = null;
  private recording: Recording | null = null;
  private structureKey = "";
  private view: ViewOptions = { grid: true, trails: true, vectors: false, labels: true, axes: false, follow: false };
  private selected: string | null = null;
  private editMode = false;
  private raf = 0;
  private resizeObserver: ResizeObserver;
  private sceneScale = 5;
  private vScale = 0.2;
  private aScale = 0.05;
  private down: { x: number; y: number } | null = null;
  private suppressCameraEvent = false;
  private lastTime = -1;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly timeSource: () => number,
    private readonly callbacks: SceneCallbacks = {},
    theme?: SceneTheme,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = "scene-canvas";
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "scene-labels";
    container.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
    this.camera.position.set(6, 4, 8);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener("change", () => {
      if (!this.suppressCameraEvent) this.callbacks.onCameraChange?.();
    });

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setSize(0.8);
    this.transform.addEventListener("dragging-changed", (e) => {
      this.controls.enabled = !(e as unknown as { value: boolean }).value;
      if (!(e as unknown as { value: boolean }).value) {
        const obj = this.transform.object;
        const id = obj?.userData.id as string | undefined;
        if (obj && id) this.callbacks.onMoved?.(id, [round(obj.position.x), round(obj.position.y), round(obj.position.z)]);
      }
    });
    this.scene.add(this.transform.getHelper());

    // Lights
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2f38, 1.1));
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.position.set(6, 12, 8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);
    const fill = new THREE.DirectionalLight(0x9ab8ff, 0.5);
    fill.position.set(-8, 5, -6);
    this.scene.add(fill);

    // Ground + grid
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x20242c, roughness: 0.95, metalness: 0 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground, this.grid, this.world);
    this.axes = new THREE.AxesHelper(1);
    this.axes.visible = false;
    this.scene.add(this.axes);

    if (theme) this.setTheme(theme);

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY }));
    el.addEventListener("pointerup", (e) => {
      if (!this.down) return;
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      this.down = null;
      if (moved < 5 && !this.transform.dragging) this.pick(e);
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  setTheme(t: SceneTheme) {
    this.scene.background = new THREE.Color(t.background);
    (this.ground.material as THREE.MeshStandardMaterial).color.set(t.ground);
    this.scene.fog = new THREE.Fog(t.background, this.sceneScale * 6, this.sceneScale * 18);
    this.gridColors = [t.grid, t.gridMajor];
    this.rebuildGrid();
  }
  private gridColors: [string, string] = ["#2b313b", "#3a424f"];

  private pick(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const meshes = [...this.bodies.values()].map((b) => b.mesh);
    const hit = ray.intersectObjects(meshes, false)[0];
    this.callbacks.onSelect?.(hit ? (hit.object.userData.id as string) : null);
  }

  /** Replace the scenario (rebuilds meshes only when the set of shapes changed). */
  setScenario(rs: ResolvedScenario, recording: Recording | null) {
    const key = JSON.stringify(rs.objects.map((o) => [o.id, o.type, o.dims, o.hollow, o.color, o.dynamic, o.label])) + JSON.stringify(rs.links.map((l) => [l.id, l.type, l.b]));
    this.rs = rs;
    if (key !== this.structureKey) {
      this.structureKey = key;
      this.rebuild();
    }
    for (const b of this.bodies.values()) b.obj = rs.objects.find((o) => o.id === b.obj.id) ?? b.obj;
    this.linkVisuals.forEach((lv) => (lv.link = rs.links.find((l) => l.id === lv.link.id) ?? lv.link));
    this.setRecording(recording);
  }

  setRecording(recording: Recording | null) {
    this.recording = recording;
    for (const b of this.bodies.values()) {
      if (!b.trail) continue;
      const tr = recording?.bodies[b.obj.id];
      const geo = b.trail.geometry as THREE.BufferGeometry;
      if (tr && tr.dynamic) {
        const n = recording!.sampleCount;
        const arr = new Float32Array(n * 3);
        for (let i = 0; i < n * 3; i++) arr[i] = tr.pos[i];
        geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
        geo.setDrawRange(0, 0);
      } else {
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
        geo.setDrawRange(0, 0);
      }
      geo.computeBoundingSphere();
    }
    // Arrow scales from the recording's extremes so arrows stay readable.
    let vmax = 0;
    let amax = 0;
    if (recording) {
      for (const id of recording.bodyOrder) {
        const tr = recording.bodies[id];
        if (!tr.dynamic) continue;
        for (let i = 0; i < recording.sampleCount; i += 2) {
          vmax = Math.max(vmax, Math.hypot(tr.vel[i * 3], tr.vel[i * 3 + 1], tr.vel[i * 3 + 2]));
          const a = accelerationAtIndex(recording, id, i);
          const am = Math.hypot(...a);
          if (am < 1e3) amax = Math.max(amax, am);
        }
      }
    }
    this.vScale = vmax > 0 ? (this.sceneScale * 0.25) / vmax : 0.2;
    this.aScale = amax > 0 ? (this.sceneScale * 0.2) / amax : 0.05;
    this.lastTime = -1;
  }

  setView(v: ViewOptions) {
    this.view = v;
    this.grid.visible = v.grid;
    this.axes.visible = v.axes;
    for (const b of this.bodies.values()) {
      if (b.trail) b.trail.visible = v.trails;
      if (b.label) b.label.visible = v.labels;
    }
    this.lastTime = -1;
  }

  setSelected(id: string | null) {
    this.selected = id;
    for (const b of this.bodies.values()) {
      const on = b.obj.id === id;
      b.material.emissive.set(on ? "#3d5a8a" : "#000000");
      b.material.emissiveIntensity = on ? 0.6 : 0;
      b.label?.element.classList.toggle("selected", on);
    }
    this.updateTransformAttachment();
  }

  setEditMode(on: boolean) {
    this.editMode = on;
    this.updateTransformAttachment();
  }

  private updateTransformAttachment() {
    const b = this.selected ? this.bodies.get(this.selected) : undefined;
    if (this.editMode && b) this.transform.attach(b.group);
    else this.transform.detach();
  }

  private clearWorld() {
    this.transform.detach();
    for (const b of this.bodies.values()) {
      b.mesh.geometry.dispose();
      b.material.dispose();
      b.trail?.geometry.dispose();
      if (b.label) b.label.element.remove();
    }
    this.world.traverse((o) => {
      if (o instanceof CSS2DObject) o.element.remove();
    });
    this.world.clear();
    this.bodies.clear();
    this.linkVisuals = [];
  }

  private rebuild() {
    this.clearWorld();
    const rs = this.rs;
    if (!rs) return;
    for (const o of rs.objects) {
      const geo = geometryFor(o);
      const round = o.type === "sphere" || o.type === "cylinder";
      const material = new THREE.MeshStandardMaterial({
        color: round ? 0xffffff : o.color,
        map: round ? stripeTexture(o.color) : null,
        roughness: METALS.has(o.materialName) ? 0.35 : o.dynamic ? 0.5 : 0.85,
        metalness: METALS.has(o.materialName) ? 0.45 : 0.02,
        side: o.hollow ? THREE.DoubleSide : THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.id = o.id;
      const group = new THREE.Group();
      group.userData.id = o.id;
      group.add(mesh);
      if (o.type === "box" || o.type === "plate" || o.type === "ramp") {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color: new THREE.Color(o.color).multiplyScalar(0.55), transparent: true, opacity: 0.8 }));
        group.add(edges);
      }
      this.world.add(group);
      const visual: BodyVisual = { obj: o, group, mesh, material };
      if (o.dynamic) {
        const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: o.color, transparent: true, opacity: 0.7 }));
        trail.frustumCulled = false;
        trail.visible = this.view.trails;
        this.world.add(trail);
        visual.trail = trail;
        visual.vel = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0x3fd07f);
        visual.acc = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xff9f43);
        visual.applied = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xe34948);
        for (const a of [visual.vel, visual.acc, visual.applied]) {
          a.visible = false;
          this.world.add(a);
        }
      }
      const div = document.createElement("div");
      div.className = "obj-label";
      div.textContent = o.label;
      const label = new CSS2DObject(div);
      label.visible = this.view.labels;
      label.center.set(0.5, 1.4);
      this.world.add(label);
      visual.label = label;
      this.bodies.set(o.id, visual);
    }
    for (const l of rs.links) this.linkVisuals.push(this.makeLink(l));
    this.setSelected(this.selected);
  }

  private makeLink(link: ResolvedLink): LinkVisual {
    const color = link.type === "rod" ? 0xb8c0cc : 0xcfd6e0;
    let anchor: THREE.Mesh | undefined;
    if (!link.b) {
      anchor = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.16), new THREE.MeshStandardMaterial({ color: 0x5b6472, roughness: 0.6 }));
      anchor.castShadow = true;
      this.world.add(anchor);
    }
    if (link.type === "rod") {
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 12), new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.6 }));
      rod.castShadow = true;
      this.world.add(rod);
      return {
        link,
        object: rod,
        anchor,
        update: (a, b) => {
          const len = a.distanceTo(b);
          rod.position.copy(a).add(b).multiplyScalar(0.5);
          rod.scale.set(1, Math.max(len, 1e-4), 1);
          rod.quaternion.setFromUnitVectors(UP, tmpV.copy(b).sub(a).normalize());
        },
      };
    }
    const coils = 14;
    const segs = coils * 16;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((segs + 1) * 3), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
    line.frustumCulled = false;
    this.world.add(line);
    return {
      link,
      object: line,
      anchor,
      update: (a, b) => {
        const axis = tmpV.copy(b).sub(a);
        const len = axis.length();
        const dir = axis.clone().normalize();
        const u = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0)).normalize();
        const w = new THREE.Vector3().crossVectors(dir, u);
        const r = Math.min(0.08, Math.max(0.03, this.sceneScale * 0.01));
        const arr = (geo.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
        for (let i = 0; i <= segs; i++) {
          const f = i / segs;
          const ang = f * coils * Math.PI * 2;
          const taper = f < 0.05 || f > 0.95 ? 0 : 1;
          const p = tmpV2.copy(a).addScaledVector(dir, f * len).addScaledVector(u, Math.cos(ang) * r * taper).addScaledVector(w, Math.sin(ang) * r * taper);
          arr[i * 3] = p.x;
          arr[i * 3 + 1] = p.y;
          arr[i * 3 + 2] = p.z;
        }
        (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      },
    };
  }

  /** Fit the camera around everything that happens in the recording. */
  frame() {
    const rs = this.rs;
    if (!rs) return;
    const box = new THREE.Box3();
    for (const o of rs.objects) {
      const r = boundingRadius(o.type, o.dims);
      const c = new THREE.Vector3(...o.position);
      if (o.type === "ramp") {
        const g = rampGeometry(o.dims);
        for (const v of g.vertices) box.expandByPoint(new THREE.Vector3(...vec.add(o.position, quat.rotate(o.quaternion, v))));
      } else box.expandByPoint(c.clone().addScalar(r)).expandByPoint(c.clone().subScalar(r));
      const tr = this.recording?.bodies[o.id];
      if (tr?.dynamic) {
        const n = this.recording!.sampleCount;
        const step = Math.max(1, Math.floor(n / 200));
        for (let i = 0; i < n; i += step) box.expandByPoint(new THREE.Vector3(tr.pos[i * 3], tr.pos[i * 3 + 1], tr.pos[i * 3 + 2]));
      }
    }
    for (const l of rs.links) if (!l.b) box.expandByPoint(new THREE.Vector3(...l.anchor));
    if (box.isEmpty()) box.set(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 2, 2));
    // Don't let a single escaping object zoom the camera out to infinity.
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.min(Math.max(size.x, size.y, size.z, 1.5), 400);
    const center = box.getCenter(new THREE.Vector3());
    this.sceneScale = maxDim;
    const fov = (this.camera.fov * Math.PI) / 180;
    const aspect = Math.max(this.camera.aspect, 0.5);
    const dist = (maxDim / (2 * Math.tan(fov / 2))) * (aspect < 1 ? 1.1 / aspect : 1.0) + maxDim * 0.18;
    const dir = new THREE.Vector3(0.55, 0.42, 1).normalize();
    this.suppressCameraEvent = true;
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.005, dist / 2000);
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.suppressCameraEvent = false;

    // Ground, grid, shadows scale with the scene.
    const groundY = rs.environment.ground ? 0 : box.min.y - maxDim * 0.1;
    const extent = Math.max(maxDim * 6, 20);
    this.ground.visible = rs.environment.ground;
    this.ground.scale.set(extent, extent, 1);
    this.ground.position.set(center.x, 0, center.z);
    this.gridY = groundY;
    this.gridCenter = center.clone();
    this.gridExtent = extent;
    this.rebuildGrid();
    const s = maxDim * 1.2 + 2;
    const cam = this.sun.shadow.camera;
    cam.left = -s;
    cam.right = s;
    cam.top = s;
    cam.bottom = -s;
    cam.near = 0.1;
    cam.far = s * 8;
    cam.updateProjectionMatrix();
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).add(new THREE.Vector3(0.45, 1, 0.6).normalize().multiplyScalar(s * 3));
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = dist * 1.6;
      this.scene.fog.far = dist * 5;
    }
    this.axes.scale.setScalar(Math.max(0.5, maxDim * 0.15));
    this.setRecording(this.recording);
  }
  private gridY = 0;
  private gridCenter = new THREE.Vector3();
  private gridExtent = 40;

  private rebuildGrid() {
    this.grid.clear();
    const extent = this.gridExtent;
    const cell = niceStep(this.sceneScale / 8);
    const divisions = Math.min(400, Math.round(extent / cell));
    const size = divisions * cell;
    const minor = new THREE.GridHelper(size, divisions, this.gridColors[0], this.gridColors[0]);
    const major = new THREE.GridHelper(size, Math.max(1, Math.round(divisions / 5)), this.gridColors[1], this.gridColors[1]);
    for (const g of [minor, major]) {
      (g.material as THREE.Material).transparent = true;
      (g.material as THREE.Material).opacity = g === minor ? 0.55 : 0.8;
      (g.material as THREE.Material).depthWrite = false;
      g.position.set(Math.round(this.gridCenter.x / (cell * 5)) * cell * 5, this.gridY + 0.001, Math.round(this.gridCenter.z / (cell * 5)) * cell * 5);
      this.grid.add(g);
    }
  }

  private updateFrame(t: number) {
    const rs = this.rs;
    if (!rs) return;
    const rec = this.recording;
    const idx = rec ? sampleIndexAt(rec, t) : null;
    const positions = new Map<string, THREE.Vector3>();
    for (const b of this.bodies.values()) {
      const o = b.obj;
      let p: Vec3 = o.position;
      let q = o.quaternion;
      let v: Vec3 = [0, 0, 0];
      let a: Vec3 = [0, 0, 0];
      if (rec && rec.bodies[o.id]) {
        const s = bodyStateAt(rec, o.id, t)!;
        p = s.position;
        q = s.quaternion;
        v = s.velocity;
        if (o.dynamic && idx) {
          const a0 = accelerationAtIndex(rec, o.id, idx.i0);
          const a1 = accelerationAtIndex(rec, o.id, idx.i1);
          a = vec.lerp(a0, a1, idx.f);
        }
      }
      b.group.position.set(p[0], p[1], p[2]);
      b.group.quaternion.set(q[0], q[1], q[2], q[3]);
      positions.set(o.id, b.group.position);
      if (b.label) b.label.position.set(p[0], p[1] + boundingRadius(o.type, o.dims) + this.sceneScale * 0.01, p[2]);
      if (b.trail && rec && idx) (b.trail.geometry as THREE.BufferGeometry).setDrawRange(0, idx.i1 + 1);
      const showVec = this.view.vectors && o.dynamic;
      if (b.vel) {
        const vl = Math.hypot(...v);
        b.vel.visible = showVec && vl * this.vScale > 0.02;
        if (b.vel.visible) {
          b.vel.position.set(...p);
          b.vel.setDirection(tmpV.set(...v).normalize());
          const L = vl * this.vScale;
          b.vel.setLength(L, Math.min(L * 0.3, this.sceneScale * 0.04), Math.min(L * 0.15, this.sceneScale * 0.02));
        }
      }
      if (b.acc) {
        const al = Math.hypot(...a);
        b.acc.visible = showVec && al * this.aScale > 0.02 && al < 1e3;
        if (b.acc.visible) {
          b.acc.position.set(...p);
          b.acc.setDirection(tmpV.set(...a).normalize());
          const L = Math.min(al * this.aScale, this.sceneScale * 0.4);
          b.acc.setLength(L, Math.min(L * 0.3, this.sceneScale * 0.04), Math.min(L * 0.15, this.sceneScale * 0.02));
        }
      }
      if (b.applied) {
        const f = rs.forces.find((x) => x.type === "applied_force" && x.appliesTo.includes(o.id) && t >= x.start && t <= x.end);
        b.applied.visible = showVec && !!f;
        if (f) {
          const L = this.sceneScale * 0.2;
          b.applied.position.set(...vec.sub(p, vec.scale(f.direction, L + boundingRadius(o.type, o.dims))));
          b.applied.setDirection(tmpV.set(...f.direction));
          b.applied.setLength(L, L * 0.3, L * 0.15);
        }
      }
    }
    for (const lv of this.linkVisuals) {
      const a = positions.get(lv.link.a);
      if (!a) continue;
      const b = lv.link.b ? positions.get(lv.link.b) : new THREE.Vector3(...lv.link.anchor);
      if (!b) continue;
      lv.update(b, a);
      if (lv.anchor) lv.anchor.position.set(...lv.link.anchor);
    }
    if (this.view.follow) {
      const id = this.selected ?? [...this.bodies.values()].find((x) => x.obj.dynamic)?.obj.id;
      const target = id ? positions.get(id) : undefined;
      if (target) {
        const delta = tmpV.copy(target).sub(this.controls.target).multiplyScalar(0.15);
        this.controls.target.add(delta);
        this.camera.position.add(delta);
      }
    }
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const t = this.timeSource();
    if (t !== this.lastTime || this.view.follow) {
      this.updateFrame(t);
      this.lastTime = t;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };

  /** Copy another view's camera (used to keep side-by-side views in sync). */
  copyCamera(from: SceneView) {
    this.suppressCameraEvent = true;
    this.camera.position.copy(from.camera.position);
    this.camera.near = from.camera.near;
    this.camera.far = from.camera.far;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(from.controls.target);
    this.controls.update();
    this.suppressCameraEvent = false;
  }

  zoom(factor: number) {
    const offset = this.camera.position.clone().sub(this.controls.target).multiplyScalar(factor);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.clearWorld();
    this.transform.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}

function niceStep(x: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(x, 1e-6)));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
