/**
 * permissions.js - Página dedicada para activación de permisos de micrófono
 * Chrome bloquea diálogos de getUserMedia dentro de ventanas emergentes (action popup).
 * Esta página pestaña permite activar la ventana emergente nativa de Chrome 'Permitir / Bloquear'.
 */

document.addEventListener('DOMContentLoaded', () => {
  const btnAllow = document.getElementById('btn-allow-mic');
  const statusMsg = document.getElementById('status-msg');

  // Comprobar si el permiso ya fue concedido al abrir esta página
  checkExistingPermission();

  btnAllow.addEventListener('click', async () => {
    try {
      statusMsg.className = 'status-msg';
      statusMsg.textContent = 'Solicitando acceso al micrófono...';

      // Esta llamada despliega el banner nativo de Chrome "Permitir / Bloquear"
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Detener los tracks de audio inmediatamente tras la autorización exitosa
      stream.getTracks().forEach(track => track.stop());

      // Persistir el estado de autorización en chrome.storage.local
      await chrome.storage.local.set({ micPermissionGranted: true });

      statusMsg.className = 'status-msg success';
      statusMsg.textContent = '✅ ¡Permiso de micrófono concedido con éxito! Cerrando...';

      setTimeout(() => {
        window.close();
      }, 1200);

    } catch (err) {
      console.error('[MeetTranslate AI Permissions] Error al solicitar micrófono:', err);
      statusMsg.className = 'status-msg error';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        statusMsg.textContent = '⚠️ Permiso denegado. Haz clic en el icono del candado 🔒 en la barra de direcciones de Chrome y selecciona "Permitir" micrófono.';
      } else {
        statusMsg.textContent = `⚠️ No se pudo acceder al micrófono: ${err.message || err.name}`;
      }
    }
  });

  async function checkExistingPermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      await chrome.storage.local.set({ micPermissionGranted: true });
      statusMsg.className = 'status-msg success';
      statusMsg.textContent = '✅ El permiso de micrófono ya está activo.';
      setTimeout(() => {
        window.close();
      }, 1500);
    } catch (e) {
      // Si aún no está autorizado, la página permanece abierta para que el usuario presione el botón
    }
  }
});
