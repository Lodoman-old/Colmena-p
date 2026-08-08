CREATE TABLE IF NOT EXISTS alertas_whatsapp (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ciudadano_id UUID NOT NULL REFERENCES ciudadanos(id) ON DELETE CASCADE,
    geofence_id UUID REFERENCES geofences(id) ON DELETE SET NULL,
    evento_id UUID REFERENCES eventos(id) ON DELETE SET NULL,
    telefono_ciudadano VARCHAR(20) NOT NULL,
    mensaje_enviado TEXT,
    timestamp_deteccion TIMESTAMP DEFAULT NOW(),
    timestamp_envio TIMESTAMP,
    enviado BOOLEAN DEFAULT FALSE,
    error_envio TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3
);

CREATE INDEX IF NOT EXISTS idx_alertas_whatsapp_ciudadano
    ON alertas_whatsapp (ciudadano_id);
CREATE INDEX IF NOT EXISTS idx_alertas_whatsapp_geofence
    ON alertas_whatsapp (geofence_id);
CREATE INDEX IF NOT EXISTS idx_alertas_whatsapp_pendientes
    ON alertas_whatsapp (enviado, retry_count)
    WHERE enviado = FALSE AND retry_count < max_retries;
