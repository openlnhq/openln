// Vendors the landing fonts (Archivo variable, IBM Plex Sans, IBM Plex Mono; SIL OFL 1.1) from Google Fonts
// into artifacts/web/media/fonts/ and prints the @font-face CSS for landing.html.
//   node scripts/vendor-landing-fonts.mjs > /root/.hermes/cache/scratch/landing-v7/fontface.css
import fs from 'node:fs';
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@0,62..125,300..900&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const OUT = 'artifacts/web/media/fonts';
fs.mkdirSync(OUT, { recursive: true });
const css = await (await fetch(CSS_URL, { headers: { 'user-agent': UA } })).text();
const faces = [];
for (const [, subset, body] of css.matchAll(/\/\* (latin|latin-ext) \*\/\s*@font-face \{([\s\S]*?)\}/g)) {
  const family = body.match(/font-family: '([^']+)'/)[1];
  const weight = body.match(/font-weight: ([^;]+);/)[1];
  const stretch = body.match(/font-stretch: ([^;]+);/)?.[1];
  const url = body.match(/url\((https:[^)]+)\)/)[1];
  const range = body.match(/unicode-range: ([^;]+);/)[1];
  const slug = family.toLowerCase().replace(/\s+/g, '-');
  const file = `${slug}${weight.includes(' ') ? '' : '-' + weight}-${subset}.woff2`;
  fs.writeFileSync(`${OUT}/${file}`, Buffer.from(await (await fetch(url)).arrayBuffer()));
  faces.push(`@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};${stretch ? `font-stretch:${stretch};` : ''}font-display:swap;src:url(/media/fonts/${file}) format('woff2');unicode-range:${range}}`);
}
console.log(faces.join('\n'));
console.error(`wrote ${faces.length} files to ${OUT}`);
