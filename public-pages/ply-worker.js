self.onmessage = async ({ data }) => {
  try {
    const buffer = await loadParts(data.manifestUrl);
    parsePly(buffer, data.maxPoints);
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "PLY 파일을 불러오지 못했습니다.",
    });
  }
};

async function loadParts(manifestUrl) {
  const manifestResponse = await fetch(manifestUrl, { cache: "force-cache" });
  if (!manifestResponse.ok) throw new Error(`데이터 목록 응답 오류 (${manifestResponse.status})`);
  const manifest = await manifestResponse.json();
  const output = new Uint8Array(manifest.totalBytes);
  let written = 0;

  for (const part of manifest.parts) {
    const partUrl = new URL(part.file, manifestResponse.url);
    const response = await fetch(partUrl, { cache: "force-cache" });
    if (!response.ok || !response.body) throw new Error(`점군 조각 응답 오류 (${response.status})`);
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output.set(value, written);
      written += value.byteLength;
      self.postMessage({
        type: "progress",
        value: (written / manifest.totalBytes) * 0.68,
        stage: "PLY 다운로드 중",
      });
    }
  }

  if (written !== manifest.totalBytes) throw new Error("점군 데이터 길이가 예상과 다릅니다.");
  return output.buffer;
}

const typeSizes = { char:1, uchar:1, int8:1, uint8:1, short:2, ushort:2, int16:2, uint16:2, int:4, uint:4, int32:4, uint32:4, float:4, float32:4, double:8, float64:8 };

function parsePly(buffer, maxPoints) {
  self.postMessage({ type: "progress", value: 0.7, stage: "헤더 분석 중" });
  const bytes = new Uint8Array(buffer);
  const probe = new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(bytes.length, 16384)));
  const match = probe.match(/end_header\r?\n/);
  if (!match || match.index === undefined) throw new Error("올바른 PLY 헤더를 찾을 수 없습니다.");
  const headerEnd = match.index + match[0].length;
  const header = probe.slice(0, headerEnd);
  if (!header.includes("format binary_little_endian 1.0")) throw new Error("binary little-endian PLY만 지원합니다.");

  const countMatch = header.match(/element vertex (\d+)/);
  if (!countMatch) throw new Error("점 개수를 찾을 수 없습니다.");
  const totalPoints = Number(countMatch[1]);
  const vertexSection = header.split(/element vertex \d+\r?\n/)[1]?.split(/\r?\nelement /)[0] ?? "";
  const properties = [];
  let stride = 0;
  for (const line of vertexSection.split(/\r?\n/)) {
    const property = line.match(/^property\s+(\w+)\s+(\w+)$/);
    if (!property) continue;
    const [, type, name] = property;
    const size = typeSizes[type];
    if (!size) throw new Error(`지원하지 않는 속성 형식: ${type}`);
    properties.push({ type, name, offset: stride });
    stride += size;
  }
  const getProperty = (name) => properties.find((item) => item.name === name);
  const x = getProperty("x"), y = getProperty("y"), z = getProperty("z");
  const red = getProperty("red"), green = getProperty("green"), blue = getProperty("blue");
  if (!x || !y || !z) throw new Error("XYZ 좌표가 없습니다.");
  if (headerEnd + totalPoints * stride > buffer.byteLength) throw new Error("PLY 데이터 길이가 예상보다 짧습니다.");

  const loadedPoints = Math.min(totalPoints, maxPoints);
  const positions = new Float32Array(loadedPoints * 3);
  const colors = new Uint8Array(loadedPoints * 3);
  const view = new DataView(buffer);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const readFloat = (offset, property) => property.type === "double" || property.type === "float64" ? view.getFloat64(offset + property.offset, true) : view.getFloat32(offset + property.offset, true);

  for (let i = 0; i < loadedPoints; i++) {
    const sourceIndex = Math.min(totalPoints - 1, Math.floor(i * totalPoints / loadedPoints));
    const offset = headerEnd + sourceIndex * stride;
    const px = readFloat(offset, x), py = readFloat(offset, y), pz = readFloat(offset, z);
    const target = i * 3;
    positions[target] = px; positions[target + 1] = py; positions[target + 2] = pz;
    colors[target] = red ? view.getUint8(offset + red.offset) : 210;
    colors[target + 1] = green ? view.getUint8(offset + green.offset) : 225;
    colors[target + 2] = blue ? view.getUint8(offset + blue.offset) : 235;
    if (px < min[0]) min[0] = px; if (py < min[1]) min[1] = py; if (pz < min[2]) min[2] = pz;
    if (px > max[0]) max[0] = px; if (py > max[1]) max[1] = py; if (pz > max[2]) max[2] = pz;
    if (i % 120000 === 0) self.postMessage({ type: "progress", value: 0.72 + 0.27 * i / loadedPoints, stage: "포인트 구성 중" });
  }
  self.postMessage({ type: "progress", value: 0.99, stage: "GPU로 전송 중" });
  self.postMessage({ type: "result", data: { positions, colors, loadedPoints, totalPoints, bounds: { min, max } } }, [positions.buffer, colors.buffer]);
}
