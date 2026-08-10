-- Alertas de votación (80% meta, 100% meta, sección estancada)
CREATE TABLE IF NOT EXISTS alertas_votacion (
  id bigserial PRIMARY KEY,
  seccion_id integer NOT NULL REFERENCES secciones_electorales(id) ON DELETE CASCADE,
  tipo varchar(30) NOT NULL,
  mensaje text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS alertas_votacion_dia_unico
  ON alertas_votacion (seccion_id, tipo, ((created_at AT TIME ZONE 'America/Mexico_City')::date));