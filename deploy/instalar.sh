#!/bin/bash
set -e

# ============================================================
#  Colmena - instalacion en SERVIDOR NUEVO
#  Ejecutar desde la raiz del paquete descomprimido:
#     chmod +x deploy/instalar.sh && ./deploy/instalar.sh
# ============================================================
cd "$(dirname "$0")/.."

DB_USER=$(grep -E '^DB_USER=' .env | cut -d= -f2 | tr -d '\r')
DB_USER="${DB_USER:-postgres}"
DB_NAME=$(grep -E '^DB_NAME=' .env | cut -d= -f2 | tr -d '\r')
DB_NAME="${DB_NAME:-colmena_db}"

psql_cmd() {
  docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "${@:1}"
}

echo "==> 1/6 Levantando postgres y redis (el init crea esquema, catalogos y admin)"
docker compose up -d postgres redis

echo "==> 2/6 Esperando a que el init de la BD termine..."
for i in $(seq 1 120); do
  if echo "SELECT 1 FROM usuarios LIMIT 1;" | psql_cmd >/dev/null 2>&1; then break; fi
  sleep 2
done
sleep 3

echo "==> 3/6 Cargando poligonos de secciones (seccion_geo, 36 secciones de Juventino Rosas)"
cat infrastructure/seed-seccion-geo-jr.sql | psql_cmd

echo "==> 4/6 Aplicando migraciones (001 y 003-015; 002 es legacy y se omite)"
apply() {
  if cat "db/migrations/$1.sql" | psql_cmd >/dev/null; then
    echo "    OK  $1"
  else
    echo "    FALLO  $1" ; exit 1
  fi
}
apply 001_extensiones_postgis
apply 003_geofences
apply 004_alertas_whatsapp
apply 005_triggers_gps
apply 006_evento_plantilla
apply 007_geofence_update_trigger
apply 008_ciudadanos_comprometidos
apply 009_fecha_nacimiento_comprometidos
apply 010_votos_casilla_favorito
apply 011_backfill_casilla
{
  printf 'ALTER TABLE rutas ADD COLUMN IF NOT EXISTS encuesta_campana_id uuid REFERENCES campanas(id);\n'
  cat db/migrations/012_rutas_tipo.sql
} | psql_cmd >/dev/null && echo "    OK  012_rutas_tipo (con guardia)"
apply 013_alertas_votacion
apply 014_incidencias
apply 015_votantes_casa_diputado

echo "==> 5/6 Preparando OSRM (rutas)"
bash deploy/preparar-osrm.sh

echo "==> 6/6 Levantando api, nginx y osrm-router"
docker compose up -d api nginx osrm-router

echo ""
echo "============================================================="
echo " LISTO"
echo " - Web:                http://<IP-del-servidor>/"
echo " - APK para descarga:  http://<IP-del-servidor>/apk/PRIoridadTerritorial.apk"
echo " - Admin:              admin@colmena.app"
docker compose logs postgres 2>/dev/null | grep -E 'ADMIN_PASSWORD' | tail -1 || true
echo "   (si no sale arriba: docker compose logs postgres | grep ADMIN_PASSWORD)"
echo "   Al entrar: cambiar la password e indicar la URL publica en Configuracion"
echo "============================================================="