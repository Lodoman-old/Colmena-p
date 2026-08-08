ALTER TABLE eventos ADD COLUMN IF NOT EXISTS plantilla_id INTEGER REFERENCES plantillas_whatsapp(id);
