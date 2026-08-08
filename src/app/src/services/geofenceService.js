import { Platform, PermissionsAndroid } from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import BackgroundGeolocation from 'react-native-background-geolocation';

const API_BASE_URL = __DEV__
  ? 'http://localhost:3000/api'
  : 'https://api.colmena.pri.mx/api';

let authToken = null;

export function setAuthToken(token) {
  authToken = token;
}

export async function requestLocationPermissions() {
  if (Platform.OS === 'android') {
    const granted = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
    ]);

    return (
      granted['android.permission.ACCESS_FINE_LOCATION'] ===
        PermissionsAndroid.RESULTS.GRANTED
    );
  }

  return true;
}

export function startGeofenceMonitoring(onEnter, onExit, onError) {
  BackgroundGeolocation.on('geofence', event => {
    if (event.action === 'ENTER') {
      onEnter(event);
    } else if (event.action === 'EXIT') {
      onExit(event);
    }
  });

  BackgroundGeolocation.on('http', response => {
    console.log('BackgroundGeolocation HTTP response:', response);
  });

  BackgroundGeolocation.ready(
    {
      desiredAccuracy: BackgroundGeolocation.DESIRED_ACCURACY_HIGH,
      distanceFilter: 10,
      stopTimeout: 5,
      startOnBoot: true,
      stopOnTerminate: false,
      enableHeadless: true,
      heartbeatInterval: 60,
      autoSync: true,
      url: `${API_BASE_URL}/geo/ubicacion`,
      httpHeaders: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      params: {
        tipo: 'enlace_campo',
      },
      geofenceProximityRadius: 100,
      geofenceInitialTriggerEntry: true,
    },
    state => {
      if (!state.enabled) {
        BackgroundGeolocation.start(() => {
          console.log('BackgroundGeolocation started');
        });
      }
    },
  );
}

export function addGeofence(geofence) {
  BackgroundGeolocation.addGeofence({
    identifier: geofence.id,
    radius: geofence.radio_metros,
    latitude: geofence.ubicacion.lat,
    longitude: geofence.ubicacion.lng,
    notifyOnEntry: true,
    notifyOnExit: true,
    loiteringDelay: 60000,
    extras: {
      evento_id: geofence.evento_id,
      nombre: geofence.nombre,
    },
  });
}

export async function syncGeofences(sectorId) {
  try {
    const response = await fetch(
      `${API_BASE_URL}/geo/geocercas/${sectorId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Error HTTP: ${response.status}`);
    }

    const geocercas = await response.json();

    BackgroundGeolocation.removeGeofences();

    for (const geofence of geocercas) {
      addGeofence(geofence);
    }

    console.log(`${geocercas.length} geocercas sincronizadas`);
    return geocercas;
  } catch (error) {
    console.error('Error sincronizando geocercas:', error);
    throw error;
  }
}

export function stopGeofenceMonitoring() {
  BackgroundGeolocation.removeGeofences();
  BackgroundGeolocation.stop();
}

export async function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    Geolocation.getCurrentPosition(
      position => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp,
        });
      },
      error => {
        reject(error);
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 10000,
      },
    );
  });
}

export async function checkProximity(ciudadanoId, geocercaId) {
  try {
    const response = await fetch(
      `${API_BASE_URL}/geo/proximidad`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          ciudadano_id: ciudadanoId,
          geocerca_id: geocercaId,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Error HTTP: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error verificando proximidad:', error);
    throw error;
  }
}
