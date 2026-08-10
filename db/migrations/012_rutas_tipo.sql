ALTER TABLE rutas ADD COLUMN IF NOT EXISTS tipo VARCHAR(20);
UPDATE rutas SET tipo = CASE WHEN encuesta_campana_id IS NOT NULL THEN 'encuesta' ELSE 'seguros' END WHERE tipo IS NULL;
ALTER TABLE rutas ALTER COLUMN tipo SET DEFAULT 'seguros';
ALTER TABLE rutas ALTER COLUMN tipo SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rutas_tipo ON rutas(tipo);
