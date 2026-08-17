-- 022: Meta de votos esperados por sección electoral (engage/campo "meta")
ALTER TABLE secciones_electorales ADD COLUMN IF NOT EXISTS meta integer NOT NULL DEFAULT 0;