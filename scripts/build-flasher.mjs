import {build} from 'esbuild';
// Bundle JSON stubs with esbuild so named exports match esptool's import contract.
// Runtime flashing is fully same-origin; no CDN or dynamic JSON fetches.
await build({stdin:{contents:"export {ESPLoader,Transport} from 'esptool-js'; export {getStubJsonByChipName} from 'esptool-js/lib/stubFlasher.js';",resolveDir:process.cwd(),sourcefile:'ric-flasher-entry.js'},bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'eof',outfile:'artifacts/web/media/esptool-0.6.0.mjs'});
