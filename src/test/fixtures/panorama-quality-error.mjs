import { writeFile } from "node:fs/promises";

const valueAfter = (name) => process.argv[process.argv.indexOf(name) + 1];

await writeFile(valueAfter("--report"), JSON.stringify({
  ok: false,
  code: "QUALITY_CHECK_FAILED",
  message: "Directions 5 and 6 need more visual overlap.",
  retakeSequences: [4, 5],
}));

process.exitCode = 2;
