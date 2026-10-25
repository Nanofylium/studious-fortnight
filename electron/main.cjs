// Forja desktop: the same app as the web build, in its own window. All audio
// processing already runs locally (Web Audio + a Web Worker), so the shell
// only serves the built files and handles windows and saving.
const { app, BrowserWindow, dialog, protocol, net, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');

// A privileged custom scheme instead of file://: the page gets a real origin,
// so module workers, fetch and the router behave exactly as on the web.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Cross-origin isolation lets ONNX Runtime use threads (SharedArrayBuffer),
// several times faster for the AI stem separation. Everything is local, so
// nothing is lost by requiring it.
function isolated(res) {
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function serveDist() {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(DIST, rel || 'index.html'));
    // Unknown paths fall back to the app shell (client-side routes); nothing
    // outside dist is ever served.
    const inside = file.startsWith(DIST + path.sep);
    const target = inside && path.extname(file) ? file : path.join(DIST, 'index.html');
    if (!fs.existsSync(target)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(target).toString()).then(isolated);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0d0f13',
    title: 'Forja',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Playback keeps going while the window is in the background.
      backgroundThrottling: false,
    },
  });

  // Stems dropped outside the drop area must not replace the app with the file.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // "Baixar master" asks where to save, starting in the Music folder.
  win.webContents.session.on('will-download', (event, item) => {
    const chosen = dialog.showSaveDialogSync(win, {
      title: 'Salvar master',
      defaultPath: path.join(app.getPath('music'), item.getFilename()),
      filters: [{ name: 'Áudio WAV', extensions: ['wav'] }],
    });
    if (!chosen) {
      item.cancel();
      return;
    }
    item.setSavePath(chosen);
    item.once('done', (_e, state) => {
      if (state === 'completed') shell.showItemInFolder(chosen);
    });
  });

  win.loadURL('app://forja/');
  return win;
}

app.whenReady().then(() => {
  serveDist();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
