#!/bin/bash
set -e

# ============================================================
#  Colmena - init idempotente (poligonos + migraciones)
#  Servicio one-shot en docker-compose: corre en cada deploy
#  y es seguro porque todo es ON CONFLICT / IF NOT EXISTS.
# ============================================================

DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-colmena_db}"
PGHOST="${PGHOST:-postgres}"
export PGPASSWORD="${DB_PASSWORD:-}"

echo "==> Esperando a postgres..."
for i in $(seq 1 120); do
  if psql -h "$PGHOST" -U "$DB_USER" -d "$DB_NAME" -t -A -c "SELECT 1 FROM usuarios LIMIT 1;" >/dev/null 2>&1; then break; fi
  sleep 2
done
sleep 3

echo "==> Poligonos de secciones (idempotente)"
psql -h "$PGHOST" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -f /infrastructure/seed-seccion-geo-jr.sql

echo "==> Migraciones (001 y 003-015; 002 es legacy y se omite)"
apply() {
  if psql -h "$PGHOST" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "/db/migrations/$1.sql" >/dev/null; then
    echo "    OK  $1"
  else
    echo "    FALLO  $1"; exit 1
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
  cat /db/migrations/012_rutas_tipo.sql
} | psql -h "$PGHOST" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 >/dev/null && echo "    OK  012_rutas_tipo (con guardia)"
apply 013_alertas_votacion
apply 014_incidencias
apply 015_votantes_casa_diputado

echo "==> Init completado"