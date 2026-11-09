import { readFile, writeFile, unlink } from 'node:fs/promises';
const html = await readFile('dist-mobile/mobile/index.html', 'utf8');
await writeFile('dist-mobile/index.html', html.replaceAll('../assets/', './assets/'));
await unlink('dist-mobile/mobile/index.html');
