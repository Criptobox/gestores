# AXONTECH · Notas de seguridad

Esta versión no tiene tercero por medio: los datos viven en TU hoja de
cálculo de Google y la puerta de entrada es la URL del Apps Script
(desplegada como "Aplicación web"). Esto es lo que conviene saber:

## Quién puede entrar

- **La URL del script es la llave.** Cualquiera que la tenga puede leer y
  escribir los datos de la hoja (la implementación va abierta para que los
  teléfonos no necesiten cuenta de Google).
- Trata la URL como una contraseña: no la publiques en el catálogo público
  ni en capturas. Se comparte con la app por `?gs=URL` o pegándola en
  `GS_DB_URL` (app.js).
- Si sospechas que se filtró: **Implementar → Gestionar implementaciones →
  editar → Versión nueva** cambia la URL; la vieja queda anulada. Pega la
  nueva en la app y listo.

## Cerradura extra (recomendado en producción)

En `Code.gs`, rellena `API_TOKEN` con una cadena larga y aleatoria. A partir
de ahí la API solo acepta peticiones que lleven ese token, y la app lo manda
si pones el mismo valor en `GS_DB_TOKEN` (app.js) o por enlace
(`?gs=URL|TOKEN`).

- Sin token: quien descubra la URL puede tocar los datos.
- Con token: la URL sola no sirve de nada.

## Las claves de la app (admin y gestores)

- Las claves de acceso al panel y a las fichas de gestor NO viajan en
  `data.json` (la semilla del repositorio nunca lleva claves) y los
  respaldos tampoco: se guardan como hash en `meta/claves_admin` dentro de
  la hoja.
- Cambio de clave del admin: panel → Perfil/Seguridad. Si se pierde, se
  restaura editando esa fila de `meta` desde la hoja.

## Datos personales

- La hoja guarda clientes, teléfonos y direcciones de los vales. Misma
  higiene que con cualquier base de clientes: no compartir la hoja con
  quien no lo necesite, y usar **Archivo → Hacer una copia** como respaldo
  en lugar de exportar CSVs sueltos.
- El respaldo automático a GitHub (si lo activas desde el panel) sube un
  `data.json` SIN vales ni claves: solo catálogo y configuración. Revisa
  igualmente que el repositorio que uses sea de confianza.
