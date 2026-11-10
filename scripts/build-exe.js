'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const electronDistDir = path.join(rootDir, 'node_modules', 'electron', 'dist');
const transyncInstallDir = 'C:\\Program Files\\Transync AI';
const outDir = path.join(rootDir, 'dist', 'Transync-PTBR-win32-x64');
const appDir = path.join(outDir, 'resources', 'app');
const icoPath = path.join(rootDir, 'build', 'icon.ico');
const exePath = path.join(outDir, 'Transync-PTBR.exe');

const RUNTIME_FILES = [
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'd3dcompiler_47.dll',
  'ffmpeg.dll',
  'icudtl.dat',
  'libEGL.dll',
  'libGLESv2.dll',
  'LICENSE.electron.txt',
  'LICENSES.chromium.html',
  'resources.pak',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll'
];

function copyRecursive(src, dest, filterFn = null) {
  if (!fs.existsSync(src)) return;
  if (filterFn && !filterFn(src)) return;

  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry), filterFn);
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function copyElectronBaseRuntime(targetDir) {
  const localElectronExe = path.join(electronDistDir, 'electron.exe');
  const installedTransyncExe = path.join(transyncInstallDir, 'Transync AI.exe');

  if (fs.existsSync(localElectronExe)) {
    console.log('2. Copiando runtime do Electron (node_modules/electron/dist)...');
    copyRecursive(electronDistDir, targetDir);
    const defaultAsar = path.join(targetDir, 'resources', 'default_app.asar');
    if (fs.existsSync(defaultAsar)) fs.rmSync(defaultAsar, { force: true });
    fs.renameSync(path.join(targetDir, 'electron.exe'), exePath);
    return;
  }

  if (fs.existsSync(installedTransyncExe)) {
    console.log('2. Copiando runtime Electron x64 local (verificado via REA Fuses)...');
    for (const fileName of RUNTIME_FILES) {
      const srcFile = path.join(transyncInstallDir, fileName);
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, path.join(targetDir, fileName));
      }
    }
    copyRecursive(path.join(transyncInstallDir, 'locales'), path.join(targetDir, 'locales'));
    fs.copyFileSync(installedTransyncExe, exePath);

    // Também popula node_modules/electron/dist para que `npm start` funcione
    try {
      fs.mkdirSync(electronDistDir, { recursive: true });
      for (const fileName of RUNTIME_FILES) {
        const srcFile = path.join(transyncInstallDir, fileName);
        if (fs.existsSync(srcFile)) {
          fs.copyFileSync(srcFile, path.join(electronDistDir, fileName));
        }
      }
      copyRecursive(path.join(transyncInstallDir, 'locales'), path.join(electronDistDir, 'locales'));
      fs.copyFileSync(installedTransyncExe, localElectronExe);
      fs.writeFileSync(path.join(rootDir, 'node_modules', 'electron', 'path.txt'), 'electron.exe', 'utf8');
    } catch {}
    return;
  }

  throw new Error('Runtime do Electron não encontrado.');
}

function main() {
  console.log('1. Limpando diretório de saída:', outDir);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  copyElectronBaseRuntime(outDir);

  console.log('3. Empacotando código da aplicação e dependências em resources/app...');
  fs.mkdirSync(appDir, { recursive: true });
  fs.copyFileSync(path.join(rootDir, 'package.json'), path.join(appDir, 'package.json'));
  if (fs.existsSync(path.join(rootDir, 'README.md'))) {
    fs.copyFileSync(path.join(rootDir, 'README.md'), path.join(appDir, 'README.md'));
  }

  copyRecursive(path.join(rootDir, 'src'), path.join(appDir, 'src'));
  copyRecursive(path.join(rootDir, 'build'), path.join(appDir, 'build'));
  copyRecursive(path.join(rootDir, 'resources'), path.join(appDir, 'resources'));
  copyRecursive(
    path.join(rootDir, 'resources', 'win-native-helpers'),
    path.join(outDir, 'resources', 'win-native-helpers')
  );

  // Copia node_modules de produção (excluindo 'electron' e '.bin')
  const nmSrc = path.join(rootDir, 'node_modules');
  const nmDest = path.join(appDir, 'node_modules');
  if (fs.existsSync(nmSrc)) {
    fs.mkdirSync(nmDest, { recursive: true });
    for (const pkg of fs.readdirSync(nmSrc)) {
      if (pkg === 'electron' || pkg === '.bin' || pkg === '.package-lock.json') continue;
      copyRecursive(path.join(nmSrc, pkg), path.join(nmDest, pkg));
    }
  }

  console.log('4. Aplicando ícone customizado (icon.ico) no executável Transync-PTBR.exe...');
  const embedScript = path.join(__dirname, 'embed-icon.ps1');
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', embedScript, '-ExePath', exePath, '-IcoPath', icoPath],
    { stdio: 'inherit' }
  );

  console.log('5. Criando atalho na Área de Trabalho (Desktop)...');
  try {
    const shortcutPs = `
      $desktop = [Environment]::GetFolderPath('Desktop')
      if ($desktop -and (Test-Path $desktop)) {
        $lnkPath = Join-Path $desktop 'Transync AI PT-BR.lnk'
        $wsh = New-Object -ComObject WScript.Shell
        $sc = $wsh.CreateShortcut($lnkPath)
        $sc.TargetPath = '${exePath.replace(/'/g, "''")}'
        $sc.WorkingDirectory = '${outDir.replace(/'/g, "''")}'
        $sc.IconLocation = '${icoPath.replace(/'/g, "''")},0'
        $sc.Description = 'Transync AI PT-BR <-> ES (Tradução Simultânea Microsoft Teams)'
        $sc.Save()
        Write-Output "Atalho criado em: $lnkPath"
      }
    `;
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', shortcutPs], {
      stdio: 'inherit'
    });
  } catch (err) {
    console.warn('Aviso ao criar atalho na Área de Trabalho:', err.message);
  }

  console.log('\n✅ Build concluído com sucesso!');
  console.log('Executável:', exePath);
}

main();
