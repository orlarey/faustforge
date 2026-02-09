#!/usr/bin/env node
import path from 'path';
import { buildFaustDocIndexFromFaustWasm, writeFaustDocIndexToFile } from '../faust-doc-index.mjs';

async function main() {
  const output = process.argv[2] || 'dist/faust-doc-index.json';
  const outputPath = path.resolve(process.cwd(), output);
  const index = await buildFaustDocIndexFromFaustWasm();
  await writeFaustDocIndexToFile(index, outputPath);
  console.log(
    JSON.stringify({
      output: outputPath,
      librariesCount: index.libraries.length,
      symbolsCount: index.symbols.length,
      rootLibPath: index.rootLibPath
    })
  );
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
