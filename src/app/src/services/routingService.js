const API_BASE_URL = __DEV__
  ? 'http://localhost:3000/api'
  : 'https://api.colmena.pri.mx/api';

let authToken = null;

export function setAuthToken(token) {
  authToken = token;
}

export async function getMisionDiaria(sectorId, soloSimpatizantes = false) {
  try {
    const response = await fetch(`${API_BASE_URL}/rutas/mision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        sector_id: sectorId,
        tipo: soloSimpatizantes ? 'seguros' : 'encuesta',
      }),
    });

    if (!response.ok) {
      throw new Error(`Error HTTP: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error obteniendo misión diaria:', error);
    throw error;
  }
}

export async function getRutaOptimizada(origen, sectorId, soloSimpatizantes = false) {
  try {
    const response = await fetch(`${API_BASE_URL}/rutas/optimizar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        origen_lat: origen.latitude,
        origen_lng: origen.longitude,
        sector_id: sectorId,
        tipo: soloSimpatizantes ? 'seguros' : 'encuesta',
      }),
    });

    if (!response.ok) {
      throw new Error(`Error HTTP: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error optimizando ruta:', error);
    throw error;
  }
}

export async function getParadasSector(sectorId) {
  try {
    const response = await fetch(`${API_BASE_URL}/rutas/paradas/${sectorId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Error HTTP: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error obteniendo paradas:', error);
    throw error;
  }
}

export function formatMision(resumen) {
  if (!resumen || !resumen.paradas) {
    return { resumen: 'No hay misiones asignadas', paradas: [] };
  }

  return {
    resumen: `Distancia total: ${resumen.distancia_total_km} km | Tiempo estimado: ${resumen.tiempo_total_minutos} min | Paradas: ${resumen.paradas.length}`,
    paradas: resumen.paradas.map((p, i) => ({
      orden: i + 1,
      nombre: p.nombre,
      telefono: p.telefono,
      lat: p.ubicacion.lat,
      lng: p.ubicacion.lng,
      es_simpatizante: p.es_simpatizante,
      prioridad: p.prioridad,
      distancia_km: p.distancia_desde_origen || 0,
    })),
    polyline: resumen.polyline || [],
    advertencias: resumen.advertencias || [],
  };
}
