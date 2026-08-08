# Panel YouTube 📺

Panel personal (mobile-first) para monitorear **todos tus canales de YouTube** en un solo lugar, directamente desde tu celular. 100% estático, sin backend.

## Características

- 📊 **Panel general**: suscriptores, vistas y videos de cada canal en tarjetas.
- 🏆 **Comparación y ranking** entre tus canales (barras + tabla).
- 🎬 **Últimos videos**: título, thumbnail, duración, categoría, fecha, vistas, likes y comentarios de los últimos N videos por canal.
- 📈 **Historial / evolución**: guarda un snapshot diario en tu navegador y dibuja la curva de crecimiento de suscriptores y vistas.
- ⚙️ **Canales editables**: agrega/quita canales por URL, `@handle` o ID desde la app (la lista se guarda en el navegador).
- 📱 **Mobile-first** con tema oscuro y pestañas inferiores.

## Demo

Publicado en GitHub Pages. Una vez configurado tu API key quedará listo en:

```
https://<tu-usuario>.github.io/youtube-panel/
```

## Cómo usarlo

1. Abre el panel desde tu navegador (móvil o PC).
2. En **Ajustes** pega tu **API key de YouTube Data API v3** (gratis). Se guarda **solo en tu navegador** (localStorage), nunca se sube a GitHub.
3. En **Ajustes → Agregar canal**, pega la URL, `@handle` o ID de cada canal.
4. Listo. Los datos se refrescan automáticamente con el botón ↻ y se registra un punto de historial diario.

### Cómo crear tu API key

1. Entra a [console.cloud.google.com](https://console.cloud.google.com/).
2. Crea/elige un proyecto → "APIs y servicios".
3. Activa **YouTube Data API v3**.
4. "Credenciales" → "Crear credenciales" → "API key".
5. Restríngela a "Referidos HTTP" con tu dominio de GitHub Pages por seguridad.

> ⚠️ La cuota gratuita de la API es de 10.000 unidades/día. Este panel hace pocas llamadas por carga (canales + videos), y cachea durante 5 minutos para no agotarla.

## Desarrollo local

Es 100% estático (HTML + CSS + JS vanilla + Chart.js por CDN). Abre `index.html` con cualquier servidor estático:

```bash
python -m http.server 8080
# o
npx serve .
```

## Licencia

MIT