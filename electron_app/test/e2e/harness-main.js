/**
 * harness-main.js - Arranca la app real para pruebas: activa la traducción y publica cada subtítulo por stdout
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const emit = (payload) => console.log('E2E ' + JSON.stringify(payload));

ipcMain.on('DISPLAY_SUBTITLE', (event, payload) => emit({ ...payload, type: 'subtitle', at: Date.now() }));
ipcMain.on('LOG_CLIENT_EVENT', (event, payload) => emit({ ...payload, type: 'log' }));

// Los errores de consola del renderer salen en el registro de la prueba: sin esto un fallo en la interfaz es mudo
app.on('web-contents-created', (event, contents) => {
  contents.on('console-message', (e, level, message, line) => {
    if (level >= 2) emit({ type: 'log', category: 'CONSOLE', message: `${message} (línea ${line})` });
  });
});

require(path.join(__dirname, '..', '..', 'main.js'));

// La interfaz registra el interruptor al final de una inicialización asíncrona (dispositivos, voces de Fish Audio),
// así que un clic temprano se pierde: se reintenta hasta que la app confirma la activación.
let activated = false;
ipcMain.on('LOG_CLIENT_EVENT', (event, payload) => {
  if (payload.category === 'CONTROL' && String(payload.message).includes('ACTIVADA')) activated = true;
});

app.whenReady().then(() => {
  const timer = setInterval(() => {
    if (activated) return clearInterval(timer);
    const control = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'));
    if (!control || control.webContents.isLoading()) return;
    emit({ type: 'activating', at: Date.now() });
    control.webContents.executeJavaScript(
      "(() => { const t = document.getElementById('toggle-active'); if (t.checked) t.checked = false; t.click(); })()", true);
  }, 1500);
});
