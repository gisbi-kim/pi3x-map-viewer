# Pi3X Map Viewer

Interactive WebGL viewer for the Pi3X color point cloud.

## Features

- 300K, 700K, or full 1M point rendering
- automatic floor alignment to Z=0
- orbit, pan, zoom, point-size and brightness controls
- dark/light backgrounds, floor grid, and PNG capture

The original 4.1M-point scan is evenly sampled to a 1M-point, 27 MB binary PLY for reliable GitHub Pages delivery.

## Local development

```bash
npm ci
npm run dev
```

## GitHub Pages build

```bash
npm run build:pages
```
