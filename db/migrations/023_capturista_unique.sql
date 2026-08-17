-- 023: Un capturista pertenece a un solo seccional (unique en capturista_id)
DELETE FROM seccional_capturistas a USING seccional_capturistas b
WHERE a.capturista_id = b.capturista_id AND a.seccional_id != b.seccional_id;
ALTER TABLE seccional_capturistas DROP CONSTRAINT IF EXISTS seccional_capturistas_capturista_unique;
ALTER TABLE seccional_capturistas ADD CONSTRAINT seccional_capturistas_capturista_unique UNIQUE (capturista_id);