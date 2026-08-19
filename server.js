require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { pool, ensureSchema, NUM_SENSORES } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * El PSoC arma el payload como: "S1:12.50,3.75,10.00;S3:-4.20,-1.05,10.00"
 * (caudal_Lmin, volumen_L, tiempo_s), separado por ';', y solo incluye un
 * sensor si cambió de estado en esa ventana. Esta función lo parsea a una
 * lista de objetos.
 */
function parsearValor(valor) {
  if (!valor || typeof valor !== 'string') return [];
  return valor
    .split(';')
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      const [cabecera, datos] = seg.split(':');
      const sensorId = parseInt(cabecera.replace(/[^0-9]/g, ''), 10);
      const partes = (datos || '').split(',').map(Number);
      const [caudalLmin, volumenL, tiempoS] = partes;
      return { sensorId, caudalLmin, volumenL, tiempoS };
    })
    .filter((e) => Number.isFinite(e.sensorId) && Number.isFinite(e.volumenL));
}

async function obtenerEstadoActual() {
  const { rows } = await pool.query(
    `SELECT sensor_id, activo, ultimo_caudal_lmin, ultimo_volumen_l, actualizado_en
     FROM estado_sensor ORDER BY sensor_id ASC;`
  );
  const activos = rows.filter((r) => r.activo).length;
  const nivelPorcentaje = Math.round((activos / NUM_SENSORES) * 100);
  return { sensores: rows, nivelPorcentaje };
}

// --- Endpoint que llama el ESP32 ---
app.post('/api/data', async (req, res) => {
  try {
    const { dispositivo, valor, rssi, snr } = req.body;

    if (!dispositivo || !valor) {
      return res.status(400).json({ error: 'Faltan campos: dispositivo y valor son obligatorios.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO lecturas (dispositivo, valor, rssi, snr)
       VALUES ($1, $2, $3, $4)
       RETURNING id, dispositivo, valor, rssi, snr, creado_en;`,
      [dispositivo, valor, rssi ?? null, snr ?? null]
    );
    const lectura = rows[0];

    const eventos = parsearValor(valor);

    for (const ev of eventos) {
      await pool.query(
        `INSERT INTO eventos_sensor (lectura_id, sensor_id, caudal_lmin, volumen_l, tiempo_s)
         VALUES ($1, $2, $3, $4, $5);`,
        [lectura.id, ev.sensorId, ev.caudalLmin, ev.volumenL, ev.tiempoS]
      );

      // volumen positivo = el sensor paso a estar cubierto (subio el nivel)
      // volumen negativo = el sensor dejo de estar cubierto (bajo el nivel)
      const activo = ev.volumenL >= 0;

      await pool.query(
        `INSERT INTO estado_sensor (sensor_id, activo, ultimo_caudal_lmin, ultimo_volumen_l, actualizado_en)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (sensor_id) DO UPDATE SET
           activo = EXCLUDED.activo,
           ultimo_caudal_lmin = EXCLUDED.ultimo_caudal_lmin,
           ultimo_volumen_l = EXCLUDED.ultimo_volumen_l,
           actualizado_en = now();`,
        [ev.sensorId, activo, ev.caudalLmin, ev.volumenL]
      );
    }

    const estado = await obtenerEstadoActual();

    // Avisar a todos los navegadores conectados, sin que tengan que pedir nada
    io.emit('nueva-lectura', { lectura, eventos, estado });

    res.status(201).json({ ok: true, lectura, eventos });
  } catch (err) {
    console.error('Error en POST /api/data:', err);
    res.status(500).json({ error: 'Error interno al guardar la lectura.' });
  }
});

// --- Historial para poblar el dashboard al cargar la pagina ---
app.get('/api/data', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const { rows } = await pool.query(
      `SELECT l.id, l.dispositivo, l.valor, l.rssi, l.snr, l.creado_en,
              e.sensor_id, e.caudal_lmin, e.volumen_l, e.tiempo_s
       FROM lecturas l
       LEFT JOIN eventos_sensor e ON e.lectura_id = l.id
       ORDER BY l.creado_en DESC
       LIMIT $1;`,
      [limit]
    );
    res.json(rows.reverse());
  } catch (err) {
    console.error('Error en GET /api/data:', err);
    res.status(500).json({ error: 'Error interno al leer el historial.' });
  }
});

// --- Estado actual de los sensores (para el tanque) ---
app.get('/api/estado', async (req, res) => {
  try {
    const estado = await obtenerEstadoActual();
    const { rows } = await pool.query(
      `SELECT rssi, snr, creado_en FROM lecturas ORDER BY creado_en DESC LIMIT 1;`
    );
    res.json({ ...estado, ultimaLectura: rows[0] || null });
  } catch (err) {
    console.error('Error en GET /api/estado:', err);
    res.status(500).json({ error: 'Error interno al leer el estado.' });
  }
});

const PORT = process.env.PORT || 3000;

ensureSchema()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Servidor escuchando en el puerto ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('No se pudo inicializar el esquema de la base de datos:', err);
    process.exit(1);
  });
