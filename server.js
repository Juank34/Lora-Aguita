require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { pool, ensureSchema, NUM_SENSORES, NOMBRES_ESTADO_SISTEMA, NOMBRES_SALUD_SENSOR } = require('./db');

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

/**
 * El PSoC manda un segundo tipo de paquete, el reporte hidrologico
 * periodico, con este formato (12 campos separados por coma):
 *
 *   "R:pct,cota,qmax,qmin,qprom,dQdt,potencia,tLlenado,estado,H1,H2,H3"
 *
 * Devuelve null si "valor" no es un paquete de este tipo (o esta mal
 * formado), para que quien llama sepa que tiene que probar el otro
 * parser (parsearValor, para los paquetes "Sn:...").
 */
function parsearReporte(valor) {
  if (!valor || typeof valor !== 'string' || !valor.startsWith('R:')) return null;

  const partes = valor.slice(2).split(',').map(Number);
  if (partes.length !== 12 || partes.some((n) => !Number.isFinite(n))) return null;

  const [pct, cota, qmax, qmin, qprom, dqdt, potencia, tiempoLlenado, estado, h1, h2, h3] = partes;

  return {
    capacidadPct: pct,
    cotaM: cota,
    caudalMaxLmin: qmax,
    caudalMinLmin: qmin,
    caudalPromLmin: qprom,
    dqdtLminS: dqdt,
    potenciaW: potencia,
    tiempoLlenadoMin: tiempoLlenado,
    estado,
    salud: [h1, h2, h3],
  };
}


async function obtenerEstadoActual() {
  const { rows } = await pool.query(
    `SELECT sensor_id, activo, ultimo_caudal_lmin, ultimo_volumen_l, actualizado_en, salud, salud_actualizada_en
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

    // ---- Caso 1: es un reporte hidrologico ("R:...") ----
    const reporte = parsearReporte(valor);
    if (reporte) {
      const { rows: repRows } = await pool.query(
        `INSERT INTO reportes_hidrologicos
           (lectura_id, capacidad_pct, cota_m, caudal_max_lmin, caudal_min_lmin, caudal_prom_lmin,
            dqdt_lmin_s, potencia_w, tiempo_llenado_min, estado, salud_s1, salud_s2, salud_s3)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *;`,
        [
          lectura.id, reporte.capacidadPct, reporte.cotaM, reporte.caudalMaxLmin, reporte.caudalMinLmin,
          reporte.caudalPromLmin, reporte.dqdtLminS, reporte.potenciaW, reporte.tiempoLlenadoMin,
          reporte.estado, reporte.salud[0], reporte.salud[1], reporte.salud[2],
        ]
      );
      const reporteGuardado = repRows[0];

      // La salud de cada sensor se actualiza aca; "activo" sigue viniendo
      // solo de los paquetes "Sn:..." (son cosas independientes: un sensor
      // puede estar activo/inactivo Y sano/en falla a la vez).
      for (let i = 0; i < NUM_SENSORES; i++) {
        await pool.query(
          `UPDATE estado_sensor SET salud = $2, salud_actualizada_en = now() WHERE sensor_id = $1;`,
          [i + 1, reporte.salud[i]]
        );
      }

      const estado = await obtenerEstadoActual();
      io.emit('nuevo-reporte', { lectura, reporte: reporteGuardado, estado });

      return res.status(201).json({ ok: true, lectura, reporte: reporteGuardado });
    }

    // ---- Caso 2: son eventos de sensor ("Sn:...") ----
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

// --- Historial de reportes hidrologicos ("R:...") ---
app.get('/api/reportes', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 60, 300);
    const { rows } = await pool.query(
      `SELECT * FROM reportes_hidrologicos ORDER BY creado_en DESC LIMIT $1;`,
      [limit]
    );
    res.json(rows.reverse());
  } catch (err) {
    console.error('Error en GET /api/reportes:', err);
    res.status(500).json({ error: 'Error interno al leer los reportes.' });
  }
});

// --- Constantes para que el frontend traduzca codigos a nombres ---
app.get('/api/constantes', (req, res) => {
  res.json({
    nombresEstadoSistema: NOMBRES_ESTADO_SISTEMA,
    nombresSaludSensor: NOMBRES_SALUD_SENSOR,
  });
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
