import { readFileSync, writeFileSync } from "node:fs";

const [sourcePath, outputPath, targetCountText = "1000000"] = process.argv.slice(2);
if (!sourcePath || !outputPath) {
  throw new Error("Usage: node scripts/downsample-ply.mjs <source.ply> <output.ply> [point-count]");
}

const targetCount = Number(targetCountText);
const source = readFileSync(sourcePath);
const probe = source.subarray(0, 16384).toString("ascii");
const headerMatch = probe.match(/end_header\r?\n/);
const countMatch = probe.match(/element vertex (\d+)/);
if (!headerMatch || headerMatch.index === undefined || !countMatch) {
  throw new Error("Invalid PLY header");
}

const headerEnd = headerMatch.index + headerMatch[0].length;
const sourceCount = Number(countMatch[1]);
const stride = (source.length - headerEnd) / sourceCount;
if (!Number.isInteger(stride) || targetCount > sourceCount) {
  throw new Error("Unsupported PLY layout or point count");
}

const header = source
  .subarray(0, headerEnd)
  .toString("ascii")
  .replace(/element vertex \d+/, `element vertex ${targetCount}`);
const headerBytes = Buffer.from(header, "ascii");
const output = Buffer.allocUnsafe(headerBytes.length + targetCount * stride);
headerBytes.copy(output, 0);

for (let i = 0; i < targetCount; i++) {
  const sourceIndex = Math.floor((i * sourceCount) / targetCount);
  const sourceOffset = headerEnd + sourceIndex * stride;
  const outputOffset = headerBytes.length + i * stride;
  source.copy(output, outputOffset, sourceOffset, sourceOffset + stride);
}

writeFileSync(outputPath, output);
console.log(JSON.stringify({ sourceCount, targetCount, stride, bytes: output.length }));
