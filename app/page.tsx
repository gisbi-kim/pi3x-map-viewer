"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type CloudData = {
  positions: Float32Array;
  colors: Uint8Array;
  loadedPoints: number;
  totalPoints: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
};

const DETAIL_OPTIONS = [
  { value: 300_000, label: "빠르게 · 30만 점" },
  { value: 700_000, label: "균형 · 70만 점" },
  { value: 1_000_000, label: "전체 · 100만 점" },
];

const formatNumber = (value: number) => new Intl.NumberFormat("ko-KR").format(value);

// Robust fit from 48,191 floor inliers after the default vertical flip:
// z = FLOOR_PLANE.a * x + FLOOR_PLANE.b * y + FLOOR_PLANE.c
const FLOOR_PLANE = { a: -0.296751781, b: -0.433357403, c: 2.544513335 };

export default function Home() {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const cloudRef = useRef<THREE.Points | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const boundsRef = useRef<{ min: THREE.Vector3; max: THREE.Vector3; diagonal: number } | null>(null);
  const fitViewRef = useRef<(() => void) | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const initialLoadStartedRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("뷰어 준비 중");
  const [stats, setStats] = useState<{ loaded: number; total: number } | null>(null);
  const [pointSize, setPointSize] = useState(1.15);
  const [brightness, setBrightness] = useState(1.15);
  const [detail, setDetail] = useState(1_000_000);
  const [gridVisible, setGridVisible] = useState(true);
  const [verticalFlipped, setVerticalFlipped] = useState(true);
  const [floorAligned, setFloorAligned] = useState(true);
  const [lightBackground, setLightBackground] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07090d);
    scene.fog = new THREE.FogExp2(0x07090d, 0.0008);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(48, 1, 0.01, 100000);
    camera.up.set(0, 0, 1);
    camera.position.set(12, -12, 10);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.setAttribute("aria-label", "Pi3X 3D point cloud viewport");
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.screenSpacePanning = true;
    controlsRef.current = controls;

    const resize = () => {
      const { clientWidth, clientHeight } = mount;
      camera.aspect = clientWidth / Math.max(clientHeight, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(clientWidth, clientHeight, false);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    let frame = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      workerRef.current?.terminate();
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const background = lightBackground ? 0xe8eaec : 0x07090d;
    scene.background = new THREE.Color(background);
    if (scene.fog instanceof THREE.FogExp2) scene.fog.color.setHex(background);
  }, [lightBackground]);

  useEffect(() => {
    if (gridRef.current) gridRef.current.visible = gridVisible;
  }, [gridVisible]);

  useEffect(() => {
    const material = cloudRef.current?.material as THREE.ShaderMaterial | undefined;
    if (material) material.uniforms.uSize.value = pointSize;
  }, [pointSize]);

  useEffect(() => {
    const material = cloudRef.current?.material as THREE.ShaderMaterial | undefined;
    if (material) material.uniforms.uBrightness.value = brightness;
  }, [brightness]);

  const applyCoordinateOrientation = useCallback((flipped: boolean, alignFloor: boolean) => {
    const points = cloudRef.current;
    const grid = gridRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const bounds = boundsRef.current;
    if (!points || !grid || !camera || !controls || !bounds) return;

    const direction = flipped ? -1 : 1;
    const plane = flipped
      ? FLOOR_PLANE
      : { a: -FLOOR_PLANE.a, b: -FLOOR_PLANE.b, c: -FLOOR_PLANE.c };
    const rotation = new THREE.Quaternion();
    let floorOffset = 0;

    if (alignFloor) {
      const floorNormal = new THREE.Vector3(-plane.a, -plane.b, 1).normalize();
      rotation.setFromUnitVectors(floorNormal, new THREE.Vector3(0, 0, 1));
      const pointOnFloor = new THREE.Vector3(0, 0, plane.c).applyQuaternion(rotation);
      floorOffset = -pointOnFloor.z;
    }

    points.scale.set(1, 1, direction);
    points.quaternion.copy(rotation);
    points.position.set(0, 0, floorOffset);

    const transformedBox = new THREE.Box3();
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          transformedBox.expandByPoint(
            new THREE.Vector3(x, y, z * direction)
              .applyQuaternion(rotation)
              .add(new THREE.Vector3(0, 0, floorOffset)),
          );
        }
      }
    }
    const center = transformedBox.getCenter(new THREE.Vector3());
    const floorZ = alignFloor ? 0 : transformedBox.min.z;
    grid.position.set(center.x, center.y, floorZ - bounds.diagonal * 0.004);

    const fitView = () => {
      if (flipped && alignFloor) {
        // Compose the scan along its horizontal principal axis, with a low
        // three-quarter view and extra room on the left for the control panel.
        const longAxis = new THREE.Vector3(0.5052, 0.8630, 0);
        const viewSide = new THREE.Vector3(-0.8630, 0.5052, 0);
        const focus = center
          .clone()
          .addScaledVector(longAxis, bounds.diagonal * 0.09);
        focus.z = transformedBox.min.z + (transformedBox.max.z - transformedBox.min.z) * 0.5;
        camera.position
          .copy(focus)
          .addScaledVector(viewSide, bounds.diagonal * 0.7)
          .add(new THREE.Vector3(0, 0, bounds.diagonal * 0.18));
        controls.target.copy(focus);
      } else {
        camera.position.set(
          center.x - bounds.diagonal * 0.58,
          center.y - bounds.diagonal * 0.58,
          center.z + bounds.diagonal * 0.42,
        );
        controls.target.copy(center);
      }
      controls.update();
    };
    fitViewRef.current = fitView;
    fitView();
  }, []);

  useEffect(() => {
    applyCoordinateOrientation(verticalFlipped, floorAligned);
  }, [applyCoordinateOrientation, floorAligned, verticalFlipped]);

  const showCloud = useCallback((data: CloudData) => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!scene || !camera || !controls) return;

    if (cloudRef.current) {
      scene.remove(cloudRef.current);
      cloudRef.current.geometry.dispose();
      (cloudRef.current.material as THREE.Material).dispose();
    }
    if (gridRef.current) {
      scene.remove(gridRef.current);
      gridRef.current.geometry.dispose();
      gridRef.current.material.dispose();
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(data.colors, 3, true));
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: pointSize },
        uBrightness: { value: brightness },
      },
      vertexColors: true,
      transparent: false,
      vertexShader: `
        uniform float uSize;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = clamp(uSize * (32.0 / max(1.0, -mvPosition.z)), 0.6, 8.0);
        }
      `,
      fragmentShader: `
        uniform float uBrightness;
        varying vec3 vColor;
        void main() {
          vec2 centered = gl_PointCoord - vec2(0.5);
          if (dot(centered, centered) > 0.25) discard;
          gl_FragColor = vec4(vColor * uBrightness, 1.0);
        }
      `,
    });
    const points = new THREE.Points(geometry, material);
    scene.add(points);
    cloudRef.current = points;

    const min = new THREE.Vector3(...data.bounds.min);
    const max = new THREE.Vector3(...data.bounds.max);
    const center = min.clone().add(max).multiplyScalar(0.5);
    const size = max.clone().sub(min);
    const diagonal = Math.max(size.length(), 1);
    boundsRef.current = { min, max, diagonal };

    const grid = new THREE.GridHelper(diagonal * 1.4, 24, 0x546274, 0x242b34);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(center.x, center.y, min.z - diagonal * 0.004);
    grid.visible = gridVisible;
    grid.material.transparent = true;
    grid.material.opacity = 0.32;
    scene.add(grid);
    gridRef.current = grid;

    scene.fog = new THREE.FogExp2(lightBackground ? 0xe8eaec : 0x07090d, 0.45 / diagonal);
    camera.near = diagonal / 10000;
    camera.far = diagonal * 30;
    camera.updateProjectionMatrix();

    applyCoordinateOrientation(verticalFlipped, floorAligned);
  }, [applyCoordinateOrientation, brightness, floorAligned, gridVisible, lightBackground, pointSize, verticalFlipped]);

  const loadCloud = useCallback((maxPoints: number) => {
    workerRef.current?.terminate();
    setIsLoading(true);
    setError(null);
    setProgress(0);
    setStatus("PLY 다운로드 중");

    const worker = new Worker("./ply-worker.js");
    workerRef.current = worker;
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "progress") {
        setProgress(message.value);
        setStatus(message.stage);
      } else if (message.type === "result") {
        showCloud(message.data as CloudData);
        setStats({ loaded: message.data.loadedPoints, total: message.data.totalPoints });
        setProgress(1);
        setStatus("준비 완료");
        setIsLoading(false);
        worker.terminate();
      } else if (message.type === "error") {
        setError(message.message);
        setStatus("불러오기 실패");
        setIsLoading(false);
        worker.terminate();
      }
    };
    worker.onerror = () => {
      setError("PLY 파일을 읽는 중 오류가 발생했습니다.");
      setIsLoading(false);
    };
    worker.postMessage({ manifestUrl: "./data/manifest.json", maxPoints });
  }, [showCloud]);

  useEffect(() => {
    if (initialLoadStartedRef.current) return;
    initialLoadStartedRef.current = true;
    loadCloud(1_000_000);
  }, [loadCloud]);

  const saveScreenshot = () => {
    const canvas = rendererRef.current?.domElement;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = "Pi3X-map-view.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  return (
    <main className="viewer-shell">
      <div className="viewport" ref={mountRef} />

      <header className="topbar">
        <div className="identity">
          <span className="mark" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <h1>Pi3X Map</h1>
            <p>Local point cloud viewer</p>
          </div>
        </div>
        <div className={`status-pill ${error ? "error" : ""}`}>
          <span className="status-dot" />
          {status}
        </div>
      </header>

      <aside className="control-panel" aria-label="Point cloud controls">
        <section className="summary">
          <span className="eyebrow">POINT CLOUD</span>
          <h2>공간을 탐색하세요</h2>
          <p>드래그로 회전, 우클릭으로 이동, 스크롤로 확대할 수 있습니다.</p>
        </section>

        {isLoading && (
          <section className="loading-card" aria-live="polite">
            <div className="loading-row"><span>{status}</span><strong>{Math.round(progress * 100)}%</strong></div>
            <div className="progress-track"><span style={{ width: `${progress * 100}%` }} /></div>
            <small>큰 파일입니다. 탭을 그대로 두면 자동으로 열립니다.</small>
          </section>
        )}

        {error && <div className="error-card">{error}</div>}

        <section className="stats-grid">
          <div><span>표시</span><strong>{stats ? `${(stats.loaded / 1_000_000).toFixed(1)}M` : "—"}</strong></div>
          <div><span>원본</span><strong>{stats ? `${(stats.total / 1_000_000).toFixed(1)}M` : "1.0M"}</strong></div>
          <div><span>포맷</span><strong>PLY</strong></div>
        </section>

        <section className="controls">
          <label>
            <span>점 크기 <output>{pointSize.toFixed(2)}</output></span>
            <input type="range" min="0.35" max="3" step="0.05" value={pointSize} onChange={(e) => setPointSize(Number(e.target.value))} />
          </label>
          <label>
            <span>색상 밝기 <output>{brightness.toFixed(2)}</output></span>
            <input type="range" min="0.5" max="2" step="0.05" value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} />
          </label>
          <label className="select-label">
            <span>표시 품질</span>
            <select value={detail} onChange={(e) => setDetail(Number(e.target.value))} disabled={isLoading}>
              {DETAIL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <button className="reload-button" onClick={() => loadCloud(detail)} disabled={isLoading}>선택한 품질로 다시 불러오기</button>
        </section>

        <section className="toggle-list">
          <label><span>바닥을 Z=0으로 정렬</span><input type="checkbox" checked={floorAligned} onChange={(e) => setFloorAligned(e.target.checked)} /><i /></label>
          <label><span>위아래 반전</span><input type="checkbox" checked={verticalFlipped} onChange={(e) => setVerticalFlipped(e.target.checked)} /><i /></label>
          <label><span>바닥 그리드</span><input type="checkbox" checked={gridVisible} onChange={(e) => setGridVisible(e.target.checked)} /><i /></label>
          <label><span>밝은 배경</span><input type="checkbox" checked={lightBackground} onChange={(e) => setLightBackground(e.target.checked)} /><i /></label>
        </section>

        <div className="action-row">
          <button onClick={() => fitViewRef.current?.()}><span>⌖</span> 화면 맞춤</button>
          <button onClick={saveScreenshot}><span>↓</span> 이미지 저장</button>
        </div>
      </aside>

      <footer className="hint-bar">
        <span><b>회전</b> 드래그</span><span><b>이동</b> 우클릭</span><span><b>확대</b> 스크롤</span>
        {stats && <em>{formatNumber(stats.loaded)} points rendered</em>}
      </footer>
    </main>
  );
}
