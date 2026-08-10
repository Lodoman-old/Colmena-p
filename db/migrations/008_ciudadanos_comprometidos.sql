-- Tabla ciudadanos_comprometidos: voto seguro del partido (2da tabla separada de ciudadanos)
CREATE TABLE IF NOT EXISTS ciudadanos_comprometidos (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seccion_id                integer NOT NULL,
    numero_hogar              character varying(20),
    nombre                    character varying(100) NOT NULL,
    telefono                  character varying(20),
    calle                     character varying(150),
    numero                    character varying(20),
    colonia                   character varying(100),
    cp                        character varying(5),
    ubicacion                 geometry(Point,4326),
    simpatizante              boolean DEFAULT false,
    prioridad                 integer DEFAULT 0,
    timestamp_registro        timestamptz DEFAULT now(),
    intencion_voto            integer,
    intencion_voto_presidente integer,
    intencion_voto_diputado   integer,
    notas                     text,
    edad                      integer,
    idempotency_key           text,
    -- Campos extra de ciudadano seguro
    correo                    character varying(150),
    curp                      character varying(18),
    ine                       character varying(30),
    nivel_compromiso          character varying(30),
    capturado_por             uuid REFERENCES usuarios(id) ON DELETE SET NULL,
    -- FK espejo de ciudadanos
    CONSTRAINT ciudadanos_comprometidos_seccion_fkey FOREIGN KEY (seccion_id) REFERENCES secciones_electorales(id),
    CONSTRAINT ciudadanos_comprometidos_int_voto_fkey FOREIGN KEY (intencion_voto) REFERENCES partidos_politicos(id),
    CONSTRAINT ciudadanos_comprometidos_int_voto_pres_fkey FOREIGN KEY (intencion_voto_presidente) REFERENCES partidos_politicos(id),
    CONSTRAINT ciudadanos_comprometidos_int_voto_dip_fkey FOREIGN KEY (intencion_voto_diputado) REFERENCES partidos_politicos(id)
);

CREATE INDEX IF NOT EXISTS idx_comprometidos_idempotency ON ciudadanos_comprometidos (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comprometidos_seccion ON ciudadanos_comprometidos (seccion_id);
CREATE INDEX IF NOT EXISTS idx_comprometidos_ubicacion ON ciudadanos_comprometidos USING gist (ubicacion);
