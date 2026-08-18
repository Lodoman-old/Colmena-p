-- 028: el API usa intencion_voto_presidente/intencion_voto_diputado;
-- la tabla ciudadanos solo tenia intencion_voto (esquema inicial).
ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS intencion_voto_presidente integer REFERENCES partidos_politicos(id) ON DELETE SET NULL;
ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS intencion_voto_diputado integer REFERENCES partidos_politicos(id) ON DELETE SET NULL;
UPDATE ciudadanos SET intencion_voto_presidente = intencion_voto WHERE intencion_voto IS NOT NULL AND intencion_voto_presidente IS NULL;
