# Colmena - Despliegue en Coolify (desde git)

El repo `Colmena-p` (GitHub) es desplegable completo: codigo, mapas (tiles),
APK, poligonos, migraciones y datos OSRM.

## 1) Preparar en Coolify (una vez)

1. **Servidor**: agregar servidor VPS (acceso SSH, Docker instalado via Coolify).
2. **Recurso → Docker Compose**:
   - Repositorio: `https://github.com/Lodoman-old/Colmena-p` (branch `main`)
   - Tipo de despliegue: **Docker Compose** (usa el `docker-compose.yml` de la raiz).
3. **Variables de entorno** en el recurso (Coolify las inyecta al compose;
   el archivo `.env` NO es parte del repo):
   ```
   DB_USER=postgres
   DB_PASSWORD=<generar una fuerte>
   DB_NAME=colmena_db
   JWT_SECRET=<cadena larga aleatoria>
   TWILIO_AUTH_TOKEN=<solo si se usara Twilio>
   VAPID_PUBLIC_KEY=<si se usan push del navegador>
   VAPID_PRIVATE_KEY=<igual que la publica>
   VAPID_SUBJECT=mailto:admin@colmena.app
   ```
4. **Deploy**. Orden de arranque automatico:
   `postgres` (init crea esquema + catalogos + admin con password aleatoria)
   → `app-init` (poligonos + migraciones, idempotente, corre en cada deploy)
   → `api` → `nginx` → `osrm-router` (se auto-prepara con los datos del repo).

## 2) Primer ingreso

- La **password del admin** la imprime postgres durante el primer arranque:
  en Coolify, Logs del contenedor `postgres` → buscar `ADMIN_PASSWORD`.
  Usuario: `admin@colmena.app`.
- Entrar a `http://<dominio-o-IP>/`, cambiar la password y en **Configuracion**
  poner la URL publica real (se usa en los enlaces de encuesta).
- APK para descarga directa: `http://<dominio-o-IP>/apk/PRIoridadTerritorial.apk`.

## 3) Persistencia (lo conserva Coolify)

- Volumen `postgres_data` (BD), `redis_data`, `uploads_data` (evidencias de
  incidencias) y `osrm_data` (rutas ya preparadas). No se pierden en redeploys.

## 4) Subir una version nueva (APK)

1. Local: reconstruir el APK (`npx cap sync android` + `gradlew.bat assembleRelease`)
   y copiarlo a `src/web/apk/PRIoridadTerritorial.apk` (e `infrastructure/nginx/apk/PRIoridadTerritorial.apk`).
2. `git add` + `git commit` + `git push`. El APK se actualiza solo en el siguiente
   deploy (git solo sube el archivo que cambio, no los tiles ni el pbf).

## 5) Notas / limites

- git sube solo lo modificado: commits de codigo NO re-suben los tiles (176MB)
  ni el pbf (49MB). El push inicial es grande (una sola vez).
- Migracion 002 del repo es legacy (referencia tabla inexistente): el
  `app-init` la omite por diseno y agrega una guardia a la 012.
- Si la VPS no tiene salida a internet para bajar imagenes la primera vez,
  hacer pull previo en el servidor: `docker pull postgis/postgis:15-3.4`,
  `docker pull nginx:alpine`, `docker pull redis:7-alpine`, `docker pull osrm/osrm-backend`.
- Respaldo de la BD (cron en la VPS):
  `docker exec colmena-postgres-1 pg_dump -U postgres -d colmena_db -F c | gzip > backup/colmena-$(date +%F).dump.gz`