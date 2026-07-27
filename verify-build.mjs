import { readFile } from "node:fs/promises";

const [source, minified] = await Promise.all([
  readFile(new URL("./max-wrapper.js", import.meta.url), "utf8"),
  readFile(new URL("./max-wrapper.min.js", import.meta.url), "utf8"),
]);

const requiredMarkers = [
  'customElements.define("maximize-wrapper-card"',
  'customElements.define("maximize-wrapper-card-editor"',
  'type: "maximize-wrapper-card"',
];

for (const marker of requiredMarkers) {
  if (!source.includes(marker)) {
    throw new Error(`Source is missing required marker: ${marker}`);
  }
}

if (!minified.trim()) {
  throw new Error("Minified HACS artifact is empty.");
}

if (minified.length >= source.length) {
  throw new Error("Minified HACS artifact is not smaller than the source.");
}

console.log("Build artifact verified.");

