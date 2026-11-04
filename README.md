# Videos — Panel de edición

Sitio estático en GitHub Pages con sidebar, proyectos, revisión de cortes y **aviso real a ZepFilms** por webhook.

**Live:** https://carromecanico2-jpg.github.io/Videos/

## Rutas (hash)
- `#/` — inicio (lista de proyectos)
- `#/p/<slug>` — vista de un proyecto
- `#/settings` — conexión con ZepFilms + cómo empezar + guía de estilo
- `/revision/<slug>/` — revisión de audio (Mary Cooper)

## Conexión con ZepFilms
1. Abre el panel de rutinas de ZepFilms y copia **POST to** (URL) y **key**.
2. En el sitio: **Settings → Conexión con ZepFilms**.
3. Pega URL y clave → **Guardar** → **Probar conexión**.
4. La clave se guarda solo en `localStorage` de tu navegador. **Nunca** va al repo.

### Auth (investigación)
- Docs de Routines (Grok Bot): el remitente envía la clave como `Authorization: Bearer <key>`.
- La skill `make-bot-ui` también documenta `X-Automation-Key`.
- El servidor exige el encabezado Authorization (sin él responde 401).
- **CORS:** `api2.cursor.sh` solo devuelve `Access-Control-Allow-Origin` para `https://cursor.com`, no para GitHub Pages. Un `fetch` autenticado desde este sitio puede fallar por CORS. Mitigaciones:
  - Campo opcional **Proxy CORS** en Settings (reenvía Authorization).
  - Cola (outbox) en `localStorage`: los eventos se reenvían solos cuando la entrega funciona.
  - Pruebas locales usan un mock con CORS abierto (`tools/mock-webhook.mjs`).

### Payload
```json
{
  "source": "zepfilms-edit-panel",
  "project": "mary-cooper",
  "project_slug": "mary-cooper",
  "step": "cuts",
  "step_id": "cuts",
  "action": "aprobar",
  "note": "",
  "timestamp": "2026-11-04T03:00:00.000Z",
  "timestamp_lima": "…",
  "cuts": {
    "available": true,
    "decisions": { "…": "borrar|dejar|pendiente" },
    "keepTake": {},
    "per_proposal": [],
    "keep_ranges": [{ "start": 0, "end": 1.2 }]
  }
}
```
Acciones: `aprobar` | `pedir_cambios` | `deshacer` | `guardar_decisiones` | `test`.

## Datos
- `data/projects.json` — proyectos oficiales (fuente de verdad; el panel hace poll ~60 s)
- `data/style.json` — guía de estilo / howto
- Aprobaciones locales: `zepfilms-edit-panel-approvals-v2`
- Webhook settings: `zepfilms-webhook-settings-v1`
- Outbox: `zepfilms-webhook-outbox-v1`

## Prueba local
```bash
node tools/mock-webhook.mjs 8765
# otro terminal:
npx serve -l 8791 .
# o: node tools/test-notify.mjs
```

## Actualizar un proyecto
Edita `data/projects.json` y push a `main`. Estados: `pendiente` | `en_progreso` | `esperando_aprobacion` | `aprobado`.
