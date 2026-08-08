export interface User {
  id: string;
  nombre: string;
  email: string;
  rol: 'admin' | 'coordinador' | 'enlace';
  municipio_id?: number;
}

export interface Ciudadano {
  id: string;
  seccion_id: number;
  numero_hogar?: string;
  nombre: string;
  telefono?: string;
  calle?: string;
  numero?: string;
  colonia?: string;
  cp?: string;
  ubicacion?: { lat: number; lng: number };
  simpatizante: boolean;
  prioridad: number;
  timestamp_registro: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    nombre: string;
    email: string;
    rol: string;
  };
}

export interface MobileSyncData {
  usuario_id: string;
  datos: {
    hogares: Ciudadano[];
    eventos?: any[];
    estado: string;
  };
  timestamp: string;
}
