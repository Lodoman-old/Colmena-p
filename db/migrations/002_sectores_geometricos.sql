CREATE TABLE IF NOT EXISTS sectores_geometricos (
    id UUID PRIMARY KEY REFERENCES sectores(id) ON DELETE CASCADE,
    bounds GEOMETRY(POLYGON, 4326),
    centroid GEOMETRY(POINT, 4326),
    area_hectareas FLOAT,
    tipo_uso_suelo VARCHAR(50) CHECK (tipo_uso_suelo IN ('rural', 'urbano', 'suburbano')),
    asentamiento VARCHAR(100),
    actualizado_en TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sectores_geometricos_bounds
    ON sectores_geometricos USING GIST (bounds);
CREATE INDEX IF NOT EXISTS idx_sectores_geometricos_centroid
    ON sectores_geometricos USING GIST (centroid);
