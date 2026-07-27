import { readFile, writeFile } from "node:fs/promises";
import { minify } from "terser";

const sourcePath = new URL("./max-wrapper.js", import.meta.url);
const targetPath = new URL("./max-wrapper.min.js", import.meta.url);

const source = await readFile(sourcePath, "utf8");
const result = await minify(source, {
  compress: true,
  mangle: true,
  output: {
    comments: /^!|@preserve|@license/i,
  },
});

if (result.error) {
  throw result.error;
}

await writeFile(targetPath, `${result.code}\n`, "utf8");

