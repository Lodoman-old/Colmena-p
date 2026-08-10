-- Votantes extra en la casa: partido de diputado por votante
ALTER TABLE votantes_casa ADD COLUMN IF NOT EXISTS partido_diputado_id integer REFERENCES partidos_politicos(id) ON DELETE SET NULL;