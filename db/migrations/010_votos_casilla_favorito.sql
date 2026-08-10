-- 010: partido favorito, meta votos casillas, lat/lng casillas,
--      votos (ya votaron), votantes_casa (extra en encuesta), casilla por ciudadano/comprometido

ALTER TABLE partidos_politicos ADD COLUMN IF NOT EXISTS es_favorito boolean NOT NULL DEFAULT false;

ALTER TABLE casillas ADD COLUMN IF NOT EXISTS meta_votos integer NOT NULL DEFAULT 0;
ALTER TABLE casillas ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE casillas ADD COLUMN IF NOT EXISTS lng double precision;

ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS casilla_id integer REFERENCES casillas(id) ON DELETE SET NULL;
ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS votantes_casa integer NOT NULL DEFAULT 1;
ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS no_abrio boolean NOT NULL DEFAULT false;

ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS casilla_id integer REFERENCES casillas(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS votos (
  id bigserial PRIMARY KEY,
  ciudadano_id uuid REFERENCES ciudadanos(id) ON DELETE CASCADE,
  comprometido_id uuid REFERENCES ciudadanos_comprometidos(id) ON DELETE CASCADE,
  partido_id integer REFERENCES partidos_politicos(id) ON DELETE SET NULL,
  casilla_id integer REFERENCES casillas(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((ciudadano_id IS NOT NULL)::int + (comprometido_id IS NOT NULL)::int = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS votos_ciudadano_unico ON votos (ciudadano_id) WHERE ciudadano_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS votos_comprometido_unico ON votos (comprometido_id) WHERE comprometido_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS votos_casilla_idx ON votos (casilla_id);

CREATE TABLE IF NOT EXISTS votantes_casa (
  id bigserial PRIMARY KEY,
  ciudadano_id uuid NOT NULL REFERENCES ciudadanos(id) ON DELETE CASCADE,
  nombre text,
  partido_id integer REFERENCES partidos_politicos(id) ON DELETE SET NULL,
  pendiente boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS votantes_casa_ciudadano_idx ON votantes_casa (ciudadano_id);
