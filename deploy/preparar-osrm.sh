#!/bin/bash
set -e

# ============================================================
#  Colmena - prepara los datos de ruteo OSRM (Guanajuato)
#  Idempotente: si ya existen, no hace nada.
# ============================================================
cd "$(dirname "$0")"

echo "==> OSRM: verificando si ya existen datos..."
docker compose up -d osrm-router >/dev/null 2>&1 || true
VOL=$(docker volume ls -q --filter name=osrm_data | head -1)
if [ -z "$VOL" ]; then
  echo "   No se encontro el volumen de OSRM; creandolo"
  VOL=$(docker compose config --volumes 2>/dev/null | grep osrm_data | head -1 || true)
  [ -z "$VOL" ] && VOL="colmena_osrm_data"
  docker volume create "$VOL" >/dev/null
fi

if docker run --rm -v "$VOL:/data" alpine sh -c 'test -f /data/guanajuato.osrm' 2>/dev/null; then
  echo "   OSRM ya preparado, se omite"
  exit 0
fi

echo "==> OSRM: de guanajuato.osm.pbf (puede tardar varios minutos)"
docker run --rm \
  -v "$(pwd)/osrm-data:/src:ro" \
  -v "$VOL:/data" \
  osrm/osrm-backend sh -c \
  "cp /src/guanajuato.osm.pbf /data/ && cd /data && osrm-extract -p /opt/car.lua guanajuato.osm.pbf && osrm-partition guanajuato.osrm && osrm-customize guanajuato.osrm"

echo "==> OSRM listo"