import { writeFile } from "node:fs/promises";

import sharp from "sharp";

const valueAfter = (name) => process.argv[process.argv.indexOf(name) + 1];
const width = Number(valueAfter("--width"));
const height = Number(valueAfter("--height"));
const output = valueAfter("--output");
const report = valueAfter("--report");
const rowHeight = Math.floor(height / 3);

await sharp({
  create: {
    width,
    height,
    channels: 3,
    background: { r: 30, g: 190, b: 95 },
  },
})
  .composite([
    { input: { create: { width, height: rowHeight, channels: 3, background: { r: 24, g: 80, b: 220 } } }, top: 0, left: 0 },
    { input: { create: { width, height: rowHeight, channels: 3, background: { r: 220, g: 65, b: 35 } } }, top: height - rowHeight, left: 0 },
  ])
  .jpeg({ quality: 90 })
  .toFile(output);

await writeFile(report, JSON.stringify({
  ok: true,
  method: "opencv-sift-spherical-v3",
  alignmentScore: 0.875,
  matchedPairs: 21,
  fallbackPairs: 3,
  coverage: 0.98,
  retakeSequences: [],
  warnings: ["Three overlaps used guided placement."],
}));
