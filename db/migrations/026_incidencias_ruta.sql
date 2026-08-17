ALTER TABLE incidencias ALTER COLUMN casilla_id DROP NOT NULL;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS seccion_id integer;
ALTER TABLE incidencias ADD COLUMN IF NOT EXISTS ruta_id uuid;
ALTER TABLE incidencias DROP CONSTRAINT IF EXISTS incidencias_ruta_id_fkey;
ALTER TABLE incidencias DROP CONSTRAINT IF EXISTS incidencias_seccion_id_fkey;
ALTER TABLE incidencias ADD CONSTRAINT incidencias_ruta_id_fkey FOREIGN KEY (ruta_id) REFERENCES rutas(id) ON DELETE SET NULL;
ALTER TABLE incidencias ADD CONSTRAINT incidencias_seccion_id_fkey FOREIGN KEY (seccion_id) REFERENCES secciones_electorales(id) ON DELETE SET NULL;