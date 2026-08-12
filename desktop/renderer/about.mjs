const params = new URLSearchParams(window.location.search);

const version = params.get('version');
const electron = params.get('electron');
const chromium = params.get('chromium');

document.querySelector('#app-version').textContent = version ?? 'Unknown';
document.querySelector('#runtime-version').textContent =
  electron !== null && chromium !== null
    ? `Electron ${electron.split('.').slice(0, 2).join('.')} · Chromium ${chromium.split('.')[0]}`
    : 'Unknown';
document.querySelector('#copyright').textContent =
  `Copyright © ${new Date().getFullYear()} Chia Network`;
