// Copies static renderer assets (HTML/CSS) into dist/ after the TypeScript build.
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src', 'renderer');
const outDir = path.join(__dirname, '..', 'dist', 'renderer');

fs.mkdirSync(outDir, { recursive: true });

for (const file of ['index.html', 'styles.css']) {
  const from = path.join(srcDir, file);
  const to = path.join(outDir, file);
  fs.copyFileSync(from, to);
  console.log(`copied ${file}`);
}
