const { download } = require('@electron/get');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

async function main() {
  // La versión es la que npm instaló según package.json, no una fija
  const version = require('./node_modules/electron/package.json').version;
  console.log(`[Electron Downloader] Obteniendo la ruta del zip de Electron v${version}...`);
  const zipPath = await download(version, {
    platform: 'win32',
    arch: 'x64'
  });

  const distPath = path.join(__dirname, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(distPath)) {
    fs.mkdirSync(distPath, { recursive: true });
  }

  console.log(`[Electron Downloader] Extrayendo desde ${zipPath} hacia ${distPath}...`);
  execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${distPath}' -Force"`, { stdio: 'inherit' });

  const pathTxtPath = path.join(__dirname, 'node_modules', 'electron', 'path.txt');
  fs.writeFileSync(pathTxtPath, 'electron.exe', 'utf-8');

  console.log('[Electron Downloader] 🟢 ¡Binario de Electron instalado y verificado exitosamente!');
}

main().catch(err => {
  console.error('[Electron Downloader] Error:', err);
  process.exit(1);
});
