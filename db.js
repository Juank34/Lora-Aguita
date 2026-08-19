const { Pool } = require('pg');

// Render entrega la connection string completa en DATABASE_URL cuando
// agregás un servicio de PostgreSQL y lo linkeás a tu Web Service.
// SSL es obligatorio para conectarse a la instancia gestionada de Render,
// pero no hace falta (ni funciona igual) en una Postgres local de desarrollo.
const isRenderOrProd =
  process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRenderOrProd ? { rejectUnauthorized: false } : false,
});

const NUM_SENSORES = 3;

const NOMBRES_ESTADO_SISTEMA = ['INICIANDO', 'MONITOREANDO', 'ALERTA_CRECIDA', 'EMBALSE_LLENO'];
const NOMBRES_SALUD_SENSOR = ['OK', 'FALLA_FUERA_DE_RANGO', 'SOSPECHA_ESTANCADO'];

async function ensureSchema() {
  // Log crudo de cada POST que llega del ESP32
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lecturas (
      id SERIAL PRIMARY KEY,
      dispositivo TEXT NOT NULL,
      valor TEXT NOT NULL,
      rssi INTEGER,
      snr REAL,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Log de cada evento de sensor ya parseado (uno por cada "Sn:caudal,volumen,tiempo")
  await pool.query(`
    CREATE TABLE IF NOT EXISTS eventos_sensor (
      id SERIAL PRIMARY KEY,
      lectura_id INTEGER REFERENCES lecturas(id) ON DELETE CASCADE,
      sensor_id INTEGER NOT NULL,
      caudal_lmin REAL NOT NULL,
      volumen_l REAL NOT NULL,
      tiempo_s REAL NOT NULL,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Estado actual (1 fila por sensor): si está activo o no ahora mismo,
  // que es lo que usamos para dibujar el nivel del tanque.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS estado_sensor (
      sensor_id INTEGER PRIMARY KEY,
      activo BOOLEAN NOT NULL DEFAULT false,
      ultimo_caudal_lmin REAL,
      ultimo_volumen_l REAL,
      actualizado_en TIMESTAMPTZ
    );
  `);

  // Salud de cada sensor (0=OK, 1=FALLA_FUERA_DE_RANGO, 2=SOSPECHA_ESTANCADO),
  // que llega en el paquete "R:" del PSoC. Va aparte de "activo" porque un
  // sensor puede estar activo/inactivo y a la vez sano o en falla.
  await pool.query(`ALTER TABLE estado_sensor ADD COLUMN IF NOT EXISTS salud INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE estado_sensor ADD COLUMN IF NOT EXISTS salud_actualizada_en TIMESTAMPTZ;`);

  // Un registro por cada paquete "R:..." del PSoC: métricas hidrológicas
  // agregadas (capacidad, cota, caudal max/min/prom, dQ/dt, potencia,
  // tiempo estimado de llenado, estado del sistema y salud de los 3 sensores).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reportes_hidrologicos (
      id SERIAL PRIMARY KEY,
      lectura_id INTEGER REFERENCES lecturas(id) ON DELETE CASCADE,
      capacidad_pct REAL NOT NULL,
      cota_m REAL NOT NULL,
      caudal_max_lmin REAL NOT NULL,
      caudal_min_lmin REAL NOT NULL,
      caudal_prom_lmin REAL NOT NULL,
      dqdt_lmin_s REAL NOT NULL,
      potencia_w REAL NOT NULL,
      tiempo_llenado_min REAL NOT NULL,
      estado INTEGER NOT NULL,
      salud_s1 INTEGER NOT NULL,
      salud_s2 INTEGER NOT NULL,
      salud_s3 INTEGER NOT NULL,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  for (let i = 1; i <= NUM_SENSORES; i++) {
    await pool.query(
      `INSERT INTO estado_sensor (sensor_id, activo)
       VALUES ($1, false)
       ON CONFLICT (sensor_id) DO NOTHING;`,
      [i]
    );
  }
}

module.exports = { pool, ensureSchema, NUM_SENSORES, NOMBRES_ESTADO_SISTEMA, NOMBRES_SALUD_SENSOR };
