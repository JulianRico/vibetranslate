# Contributing to ViBeTranslate Pro Studio / Guía de Contribución

**[English](#english)** · **[Español](#español)**

---

<a id="english"></a>
## English

Thank you for your interest in contributing to **ViBeTranslate Pro Studio**! Every improvement — from bug fixes and new language pairs to audio engineering, accessibility, and documentation — helps professionals communicate better in international teams.

### 1. Development Setup

1. Fork the repository and clone your fork:
   ```bash
   git clone https://github.com/<your-username>/vibetranslate.git
   cd vibetranslate/electron_app
   npm install
   ```
2. Copy the environment template:
   ```bash
   cp .env.example .env
   ```
   Fill in only the keys you need for your task (the offline **Local** engine works without any API keys).
3. Download local AI models if you plan to run local-engine or E2E tests:
   ```bash
   npm run models
   ```

### 2. Branch & Commit Conventions

- Create a focused branch from `master`:
  - `feat/<short-description>` for new features
  - `fix/<short-description>` for bug fixes
  - `docs/<short-description>` for documentation improvements
  - `test/<short-description>` for test coverage
- Use clear, concise commit messages following Conventional Commits (e.g., `feat(training): add supply chain scenarios`, `fix(audio): prevent overlap on rapid reconnect`).

### 3. Security & Privacy Rules (Mandatory)

- **Never commit `.env` files, personal `settings.json`, real API keys, tokens, or personal audio/document files.**
- Any new environment variable **must** be added to `electron_app/.env.example` with a clearly fictitious placeholder value and documented in `README.md` / `README.es.md`.
- Always run `node --test test/env.test.js` before committing — it automatically scans source files for hardcoded keys and verifies `.env.example` & `package.json` packaging exclusions.

### 4. Testing Checklist Before Opening a Pull Request

From `electron_app/`:
1. Run all unit & integration tests (must pass with `0` failures):
   ```bash
   npm test
   ```
2. If you touched the local engine, audio pipeline, or Electron main/renderer integration, run the E2E suite:
   ```bash
   npm run test:e2e
   ```
3. Keep business logic in pure, Electron-independent modules (`*.js` with unit tests in `test/*.test.js`) whenever possible so features stay fast to test and easy to review.
4. Keep UI changes accessible (semantic HTML, associated `<label>`s, keyboard focus rings, Light & Dark theme support, `prefers-reduced-motion`).

### 5. Opening a Pull Request

- Describe **what** changed, **why**, and **how** you verified it (test output, screenshots or logs for UI/audio changes).
- Keep PRs small and focused on one concern.

---

<a id="español"></a>
## Español

¡Gracias por tu interés en aportar a **ViBeTranslate Pro Studio**! Cada mejora — corrección de errores, nuevos idiomas, ingeniería de audio, accesibilidad o documentación — ayuda a que más profesionales puedan integrarse a equipos internacionales.

### 1. Configuración del entorno de desarrollo

1. Haz un fork del repositorio y clónalo:
   ```bash
   git clone https://github.com/<tu-usuario>/vibetranslate.git
   cd vibetranslate/electron_app
   npm install
   ```
2. Crea tu archivo local `.env` a partir de la plantilla:
   ```powershell
   Copy-Item .env.example .env
   ```
   Agrega solo las claves necesarias para tu tarea (el motor **Local** funciona completamente sin claves API).
3. Si vas a probar el motor local o las pruebas E2E, descarga los modelos locales:
   ```bash
   npm run models
   ```

### 2. Convenciones de ramas y commits

- Crea una rama específica a partir de `master`:
  - `feat/<descripcion-corta>` para nuevas funcionalidades
  - `fix/<descripcion-corta>` para corrección de errores
  - `docs/<descripcion-corta>` para documentación
  - `test/<descripcion-corta>` para pruebas
- Usa mensajes claros siguiendo Conventional Commits (ej. `feat(training): agregar escenarios de logistica`, `fix(audio): evitar solapamiento al reconectar`).

### 3. Reglas de seguridad y privacidad (obligatorias)

- **Nunca subas archivos `.env`, `settings.json` personales, claves API reales, tokens ni grabaciones o documentos personales.**
- Toda variable de entorno nueva **debe** documentarse en `electron_app/.env.example` con un valor claramente ficticio y reflejarse en `README.md` y `README.es.md`.
- Ejecuta siempre `node --test test/env.test.js` antes de hacer commit: verifica automáticamente que no existan secretos quemados en código y que `package.json` excluya `.env` del instalador.

### 4. Checklist antes de abrir un Pull Request

Dentro de `electron_app/`:
1. Ejecuta todas las pruebas unitarias y de integración (`0` fallos):
   ```bash
   npm test
   ```
2. Si modificaste el motor local, el pipeline de audio o el proceso principal/renderer de Electron, ejecuta también las pruebas E2E:
   ```bash
   npm run test:e2e
   ```
3. Mantén la lógica de negocio en módulos puros sin dependencia de Electron (con pruebas unitarias en `test/*.test.js`) siempre que sea posible.
4. Cuida la accesibilidad y el diseño (HTML semántico, `<label>` asociados, navegación por teclado, tema claro/oscuro y `prefers-reduced-motion`).

### 5. Abrir un Pull Request

- Explica **qué** cambiaste, **por qué** y **cómo** lo validaste (resultado de pruebas y capturas si toca interfaz).
- Mantén cada PR enfocado en un único objetivo para agilizar la revisión.
