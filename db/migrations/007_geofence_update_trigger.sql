CREATE OR REPLACE FUNCTION actualizar_geofence_evento()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.ubicacion IS DISTINCT FROM NEW.ubicacion OR OLD.radio_geocerca IS DISTINCT FROM NEW.radio_geocerca THEN
        UPDATE geofences SET ubicacion = NEW.ubicacion, radio_metros = NEW.radio_geocerca WHERE evento_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_actualizar_geofence_evento ON eventos;
CREATE TRIGGER trg_actualizar_geofence_evento AFTER UPDATE ON eventos FOR EACH ROW EXECUTE FUNCTION actualizar_geofence_evento();
