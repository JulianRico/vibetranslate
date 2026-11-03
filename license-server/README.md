# Servidor de licencias · ViBeTranslate Pro

Activación de 30 días por equipo, renovación manual, bloqueo de la app al vencer y avisos desde ventas@tikal.com.co a 7, 3 y 0 días.

## Qué hace

- `POST /v1/activate`: la app envía la clave y el identificador del equipo. Si la clave es válida y no está ligada a otro equipo, devuelve un token firmado que vence a los 30 días.
- `POST /v1/validate`: la app comprueba el token al iniciar y cada 24 horas. Devuelve un token nuevo, para que una renovación llegue sola.
- `GET /v1/public-key`: clave pública Ed25519 que la app incluye para comprobar las firmas.
- `/admin/*`: crear claves, listar, renovar y revocar. Requiere `Authorization: Bearer <ADMIN_TOKEN>`.
- Cron diario: marca las licencias vencidas y envía los avisos (un aviso por umbral y por licencia).

Las claves tienen forma `VBTP-XXXX-XXXX-XXXX` y se guardan solo como hash SHA-256.

## Requisitos

- Node.js 20 o superior.
- HTTPS delante del servidor (nginx, Caddy o IIS como proxy inverso). El servicio escucha en `127.0.0.1` y no debe quedar expuesto por HTTP.

## Instalación

```bash
cd license-server
npm install --omit=dev         # instala nodemailer para el envío real
export ADMIN_TOKEN="$(openssl rand -hex 32)"   # guárdalo en un gestor de contraseñas
export DATA_DIR=/var/lib/vibetranslate-licencias
export PORT=8080
# SMTP para ventas@tikal.com.co (sin esto, los avisos se guardan en outbox.jsonl)
export SMTP_HOST=...
export SMTP_PORT=587
export SMTP_USER=ventas@tikal.com.co
export SMTP_PASS=...           # solo en el entorno del servidor, nunca en el repositorio
export MAIL_FROM=ventas@tikal.com.co
npm start
```

En Windows, usa `set` o `$env:` en lugar de `export`.

## Uso del panel (por ahora, con curl)

Crear una licencia (la clave se muestra una sola vez):

```bash
curl -s -X POST https://licencias.tudominio.com/admin/licenses \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer":"Nombre del cliente","email":"cliente@correo.com"}'
```

Listar licencias:

```bash
curl -s https://licencias.tudominio.com/admin/licenses -H "Authorization: Bearer $ADMIN_TOKEN"
```

Renovar 30 días más (se suman desde el vencimiento si aún no ha vencido; si ya venció, desde hoy):

```bash
curl -s -X POST https://licencias.tudominio.com/admin/licenses/<id>/renew -H "Authorization: Bearer $ADMIN_TOKEN"
```

Revocar una licencia:

```bash
curl -s -X POST https://licencias.tudominio.com/admin/licenses/<id>/revoke -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Cron

El servidor ejecuta la comprobación diaria dentro del propio proceso. No hace falta un cron del sistema. Si prefieres uno del sistema, el proceso puede configurarse para no ejecutar el intervalo y llamar a `runCron()` desde un script.

## Pruebas

```bash
npm test
```

## Lo que no hace todavía

- Pagos automáticos: la renovación es manual.
- Varios equipos por licencia: el plan individual admite un equipo.
- Panel web: el panel es de momento la API con curl.
- Copias de seguridad: haz copia de `DATA_DIR` (licencias y clave de firma) con regularidad. Si pierdes la clave privada, las licencias activas dejarán de validar.
