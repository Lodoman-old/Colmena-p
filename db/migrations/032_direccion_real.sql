-- 032_direccion_real.sql
-- Dirección real del ciudadano (distinta de la dirección de su INE).
--
-- La dirección del INE (calle, numero, colonia, cp, ubicacion) NO se modifica:
-- sigue siendo la referencia legal/electoral (sección y casilla donde vota).
-- Los campos *_real guardan dónde vive actualmente la persona y son los que se
-- usan para rutas/visitas y campañas (que filtran por sección).
--
-- direccion_real = false  -> se usa la dirección del INE (comportamiento anterior).
-- direccion_real = true   -> se usa la dirección real si está capturada.

ALTER TABLE ciudadanos
  ADD COLUMN IF NOT EXISTS direccion_real   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS calle_real       varchar(150),
  ADD COLUMN IF NOT EXISTS numero_real      varchar(20),
  ADD COLUMN IF NOT EXISTS colonia_real     varchar(100),
  ADD COLUMN IF NOT EXISTS cp_real          varchar(5),
  ADD COLUMN IF NOT EXISTS ubicacion_real   geometry(Point,4326),
  ADD COLUMN IF NOT EXISTS seccion_real_id  integer REFERENCES secciones_electorales(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS nota_direccion   text;

ALTER TABLE ciudadanos_comprometidos
  ADD COLUMN IF NOT EXISTS direccion_real   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS calle_real       varchar(150),
  ADD COLUMN IF NOT EXISTS numero_real      varchar(20),
  ADD COLUMN IF NOT EXISTS colonia_real     varchar(100),
  ADD COLUMN IF NOT EXISTS cp_real          varchar(5),
  ADD COLUMN IF NOT EXISTS ubicacion_real   geometry(Point,4326),
  ADD COLUMN IF NOT EXISTS seccion_real_id  integer REFERENCES secciones_electorales(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS nota_direccion   text;

CREATE INDEX IF NOT EXISTS idx_ciudadanos_ubicacion_real
  ON ciudadanos USING gist (ubicacion_real);
CREATE INDEX IF NOT EXISTS idx_ciudadanos_seccion_real
  ON ciudadanos (seccion_real_id);

CREATE INDEX IF NOT EXISTS idx_comprometidos_ubicacion_real
  ON ciudadanos_comprometidos USING gist (ubicacion_real);
CREATE INDEX IF NOT EXISTS idx_comprometidos_seccion_real
  ON ciudadanos_comprometidos (seccion_real_id);

-- Si no hay dirección real capturada, los campos reales son espejo de los del INE.
-- Así rutas/visitas y campañas siempre pueden leer los campos "reales".
UPDATE ciudadanos
   SET calle_real      = calle,
       numero_real     = numero,
       colonia_real    = colonia,
       cp_real         = cp,
       ubicacion_real  = ubicacion,
       seccion_real_id = seccion_id,
       nota_direccion  = NULL
 WHERE direccion_real = FALSE;

UPDATE ciudadanos_comprometidos
   SET calle_real      = calle,
       numero_real     = numero,
       colonia_real    = colonia,
       cp_real         = cp,
       ubicacion_real  = ubicacion,
       seccion_real_id = seccion_id,
       nota_direccion  = NULL
 WHERE direccion_real = FALSE;
