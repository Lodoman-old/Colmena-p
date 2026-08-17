-- 021: Asignación de casillas a representantes (el representante solo ve su casilla, sus simpatizantes e incidencias)
CREATE TABLE IF NOT EXISTS representantes_casillas (
  representante_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  casilla_id integer NOT NULL REFERENCES casillas(id) ON DELETE CASCADE,
  PRIMARY KEY (representante_id, casilla_id)
);
CREATE INDEX IF NOT EXISTS idx_representantes_casillas_casilla ON representantes_casillas (casilla_id);