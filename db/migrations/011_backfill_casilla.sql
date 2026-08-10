-- Asigna casilla a comprometidos y ciudadanos sin casilla: la única casilla de su
-- sección, o la primera por orden de id cuando hay varias (visible y ajustable).
UPDATE ciudadanos_comprometidos c
SET casilla_id = sub.cid
FROM (
  SELECT c2.id, (SELECT id FROM casillas WHERE seccion_id = c2.seccion_id ORDER BY id LIMIT 1) AS cid
  FROM ciudadanos_comprometidos c2
  WHERE c2.casilla_id IS NULL
) sub
WHERE c.id = sub.id AND sub.cid IS NOT NULL;

UPDATE ciudadanos c
SET casilla_id = sub.cid
FROM (
  SELECT c2.id, (SELECT id FROM casillas WHERE seccion_id = c2.seccion_id ORDER BY id LIMIT 1) AS cid
  FROM ciudadanos c2
  WHERE c2.casilla_id IS NULL
) sub
WHERE c.id = sub.id AND sub.cid IS NOT NULL;
