import {cp, mkdir} from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const copies = [
  ['test/fixtures', 'build/test/fixtures'],
  ['test/unit/fixtures', 'build/test/unit/fixtures'],
  ['test/unit/plist/fixtures', 'build/test/unit/plist/fixtures'],
];

for (const [source, destination] of copies) {
  await mkdir(path.dirname(path.join(root, destination)), {recursive: true});
  await cp(path.join(root, source), path.join(root, destination), {
    filter: (sourcePath) =>
      !sourcePath.split(path.sep).includes('.tmp') &&
      !sourcePath.endsWith('.ts') &&
      !sourcePath.endsWith('.tsx'),
    recursive: true,
  });
}
