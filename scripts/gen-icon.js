// Generates build/icon.ico + build/icon.png for the installer/app icon.
// Reuses the compiled shield generator (run after `npm run build`).
const fs = require('fs');
const path = require('path');
const { shieldPng, shieldIco } = require('../dist/main/icon.js');

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });

const ACCENT = '#4f8cff';
fs.writeFileSync(path.join(buildDir, 'icon.png'), shieldPng(ACCENT, 256));
fs.writeFileSync(path.join(buildDir, 'icon.ico'), shieldIco(ACCENT));
console.log('wrote build/icon.png and build/icon.ico');
