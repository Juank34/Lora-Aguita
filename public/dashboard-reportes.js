/* ============================================================
 *  DASHBOARD - REPORTES HIDROLOGICOS
 *  ------------------------------------------------------------
 *  Se carga DESPUES de dashboard.js y reusa:
 *    - la variable global `socket` (ya conectada ahi)
 *    - la funcion global `actualizarTanque(pct)` (ya definida ahi)
 *  No redeclara nada de eso, solo agrega lo nuevo.
 * ============================================================ */

const NOMBRES_ESTADO_SISTEMA = ['INICIANDO', 'MONITOREANDO', 'ALERTA_CRECIDA', 'EMBALSE_LLENO'];
const NOMBRES_SALUD_SENSOR = ['OK', 'FALLA_FUERA_DE_RANGO', 'SOSPECHA_ESTANCADO'];

const elChipEstadoSistema = document.getElementById('chip-estado-sistema');
const elGrillaSalud = document.getElementById('grilla-salud');

const elMCapacidad = document.getElementById('m-capacidad');
const elMCota = document.getElementById('m-cota');
const elMQmax = document.getElementById('m-qmax');
const elMQmin = document.getElementById('m-qmin');
const elMQprom = document.getElementById('m-qprom');
const elMDqdt = document.getElementById('m-dqdt');
const elMPotencia = document.getElementById('m-potencia');
const elMTiempoLlenado = document.getElementById('m-tiempo-llenado');

function num(v, decimales = 2) {
  return (v === null || v === undefined || Number.isNaN(Number(v))) ? '—' : Number(v).toFixed(decimales);
}

/* ---------------------------------------------------------
 * Tarjetas de metricas + chip de estado
 * --------------------------------------------------------- */
function actualizarMetricas(reporte) {
  elMCapacidad.textContent = `${num(reporte.capacidad_pct, 1)} %`;
  elMCota.textContent = `${num(reporte.cota_m)} m`;
  elMQmax.textContent = `${num(reporte.caudal_max_lmin)} L/min`;
  elMQmin.textContent = `${num(reporte.caudal_min_lmin)} L/min`;
  elMQprom.textContent = `${num(reporte.caudal_prom_lmin)} L/min`;
  elMDqdt.textContent = `${num(reporte.dqdt_lmin_s)} L/min·s`;
  elMPotencia.textContent = `${num(reporte.potencia_w)} W`;
  elMTiempoLlenado.textContent = (reporte.tiempo_llenado_min < 0)
    ? 'N/D'
    : `${num(reporte.tiempo_llenado_min)} min`;

  const estado = Number(reporte.estado);
  elChipEstadoSistema.dataset.estado = estado;
  elChipEstadoSistema.textContent = NOMBRES_ESTADO_SISTEMA[estado] || 'DESCONOCIDO';
}

/* ---------------------------------------------------------
 * Badges de salud (usa el array de sensores que ya devuelve
 * /api/estado y /api/data via socket "estado")
 * --------------------------------------------------------- */
function actualizarSalud(sensores) {
  sensores.forEach((s) => {
    const badge = elGrillaSalud.querySelector(`[data-sensor-salud="${s.sensor_id}"]`);
    if (!badge) return;
    const codigo = Number(s.salud) || 0;
    badge.dataset.estado = codigo;
    badge.querySelector('.badge-salud__estado').textContent = NOMBRES_SALUD_SENSOR[codigo] || '—';
  });
}

/* ---------------------------------------------------------
 * Grafico de barras: % de capacidad por reporte
 * --------------------------------------------------------- */
const ctxBarras = document.getElementById('grafico-barras-capacidad').getContext('2d');
const graficoBarras = new Chart(ctxBarras, {
  type: 'bar',
  data: {
    labels: [],
    datasets: [{
      label: 'Capacidad (%)',
      data: [],
      backgroundColor: 'rgba(45, 212, 191, 0.55)',
      borderColor: '#2DD4BF',
      borderWidth: 1,
      borderRadius: 4,
      maxBarThickness: 28,
    }],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        grid: { display: false },
        ticks: { color: '#7C93A0', font: { family: 'IBM Plex Mono', size: 10 }, maxRotation: 0 },
      },
      y: {
        beginAtZero: true,
        max: 100,
        grid: { color: 'rgba(255,255,255,0.05)' },
        ticks: { color: '#7C93A0', font: { family: 'IBM Plex Mono', size: 11 } },
      },
    },
    plugins: {
      legend: { display: false },
    },
  },
});

function agregarBarraCapacidad(timestamp, pct) {
  const etiqueta = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  graficoBarras.data.labels.push(etiqueta);
  graficoBarras.data.datasets[0].data.push(pct);
  if (graficoBarras.data.labels.length > 40) {
    graficoBarras.data.labels.shift();
    graficoBarras.data.datasets[0].data.shift();
  }
  graficoBarras.update('none');
}

/* ---------------------------------------------------------
 * Carga inicial: ultimo reporte + historial de reportes
 * --------------------------------------------------------- */
async function cargarReportesIniciales() {
  try {
    const reportes = await fetch('/api/reportes?limit=40').then((r) => r.json());
    reportes.forEach((rep) => agregarBarraCapacidad(rep.creado_en, rep.capacidad_pct));
    if (reportes.length > 0) {
      actualizarMetricas(reportes[reportes.length - 1]);
    }
  } catch (err) {
    console.error('No se pudo cargar el historial de reportes:', err);
  }
}

/* ---------------------------------------------------------
 * Reportes en vivo por Socket.IO
 * --------------------------------------------------------- */
socket.on('nuevo-reporte', ({ reporte, estado }) => {
  actualizarMetricas(reporte);
  agregarBarraCapacidad(reporte.creado_en, reporte.capacidad_pct);

  // El % de capacidad del embalse es mas preciso que el conteo de
  // sensores activos, asi que pisa el nivel del tanque con este dato
  // apenas llega un reporte.
  if (typeof actualizarTanque === 'function') {
    actualizarTanque(Math.round(reporte.capacidad_pct));
  }

  if (estado && estado.sensores) {
    actualizarSalud(estado.sensores);
  }
});

// Tambien llega la salud (sin cambios de metricas) en cada "nueva-lectura"
// normal, porque obtenerEstadoActual() siempre incluye la columna salud.
socket.on('nueva-lectura', ({ estado }) => {
  if (estado && estado.sensores) {
    actualizarSalud(estado.sensores);
  }
});

cargarReportesIniciales();
