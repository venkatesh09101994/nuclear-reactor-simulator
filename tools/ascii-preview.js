'use strict';

/**
 * Renders a PNG as a luminance character grid so layout can be inspected in a
 * terminal. Development helper only.
 *
 *   npx electron tools/ascii-preview.js verify-shots/02-dashboard.png [width]
 */

const { app, nativeImage } = require('electron');

app.whenReady().then(() => {
  const file = process.argv[2];
  const width = Number(process.argv[3]) || 108;
  if (!file) {
    console.error('usage: electron tools/ascii-preview.js <file.png> [width]');
    app.exit(1);
    return;
  }

  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    console.error('could not read image:', file);
    app.exit(1);
    return;
  }

  const small = image.resize({ width, quality: 'good' });
  const size = small.getSize();
  const bitmap = small.toBitmap(); // BGRA, row-major
  const ramp = ' .:-=+*#%@';

  // Dark UI: normalise against the brightest pixel so structure is visible.
  let peak = 0;
  for (let i = 0; i < bitmap.length; i += 4) {
    const lum = (0.2126 * bitmap[i + 2] + 0.7152 * bitmap[i + 1] + 0.0722 * bitmap[i]) / 255;
    if (lum > peak) peak = lum;
  }
  const scale = peak > 0.04 ? peak : 1;

  const lines = [];
  for (let y = 0; y < size.height; y += 1) {
    let row = '';
    for (let x = 0; x < size.width; x += 1) {
      const index = (y * size.width + x) * 4;
      const b = bitmap[index];
      const g = bitmap[index + 1];
      const r = bitmap[index + 2];
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const normalized = Math.min(1, Math.pow(lum / scale, 0.55));
      row += ramp[Math.min(ramp.length - 1, Math.floor(normalized * ramp.length))];
    }
    lines.push(row);
  }

  console.log(lines.join('\n'));
  app.exit(0);
});
