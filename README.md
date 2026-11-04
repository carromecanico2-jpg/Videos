# Videos — Panel de edición

Sitio estático en GitHub Pages. Al aprobar un paso, el panel avisa a ZepFilms por **ntfy.sh** (sin cuenta, sin pegar URL ni clave).

**Live:** https://carromecanico2-jpg.github.io/Videos/

## Rutas (hash)
- `#/` — inicio
- `#/p/<slug>` — proyecto
- `#/settings` — estado de conexión + guía de estilo
- `/revision/<slug>/` — revisión de audio

## Avisos a ZepFilms
- Entrega: `POST https://ntfy.sh/zepfilms-panel-5947e6bd6cb6e863` con el JSON del evento en el body.
- Sin login. CORS abierto en ntfy.sh.
- Cola en `localStorage` si un envío falla; se reintenta solo.
- En el primer load se reenvían aprobaciones locales pendientes (una sola vez).

## Datos
- `data/projects.json` — fuente de verdad (poll ~60 s)
- Aprobaciones locales: `zepfilms-edit-panel-approvals-v2`
