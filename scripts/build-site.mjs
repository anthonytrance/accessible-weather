import { cp, mkdir, rm } from "node:fs/promises";

const files = [
  "index.html",
  "styles.css",
  "app.js",
  "weather-utils.js",
  "deep-data.js",
  "i18n.js",
  "icons.js",
  "manifest.webmanifest",
  "icon.svg",
  "sw.js"
];

await rm("dist", { recursive: true, force: true });
await mkdir("dist/data", { recursive: true });

await Promise.all(files.map((file) => cp(file, `dist/${file}`)));
await cp("data/kmi-latest.json", "dist/data/kmi-latest.json");

console.log(`Built ${files.length + 1} static files in dist/.`);
