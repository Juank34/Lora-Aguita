const socket = io();

const LIMITE_EVENTOS_TABLA = 60;
const SEGUNDOS_SIN_SENAL = 45; // si no llega nada en este tiempo, se marca "sin señal"

const TANQUE_Y_TOPE = 20;
const TANQUE_ALTO = 280;
const TANQUE_Y_BASE = TANQUE_Y_TOPE + TANQUE_ALTO; // 300

const elLiquido = document.getElementById('liquido');
const elLiquidoOnda = document.getElementById('liquido-onda');
const elNivelPorcentaje = document.getElementById('nivel-porcentaje');
const elListaSensores = document.getElementById('lista-sensores');
const elPuntoEstado = document.getElementById('punto-estado');
const elTextoEstado = document.getElementById('texto-estado');
const elTextoUltimaVez = document.getElementById('texto-ultima-vez');
const elValorRssi = document.getElementById('valor-rssi');
const elBarraRssi = document.getElementById('barra-rssi');
const elValorSnr = document.getElementById('valor-snr');
const elBarraSnr = document.getElementById('barra-snr');
const elCuerpoTabla = document.getElementById('cuerpo-tabla-eventos');
const elContadorEventos = document.getElementById('contador-eventos');

let ultimaVezRecibido = null;
let totalEventos = 0;

const COLORES_SENSOR = { 1: '#2DD4BF', 2: '#F5A623', 3: '#60A5FA' };

/* ---------------------------------------------------------
 * Gráfico de caudal (Chart.js)
 * --------------------------------------------------------- */
const ctx = document.getElementById('grafico-caudal').getContext('2d');
const datasetsPorSensor = {};

function obtenerDataset(sensorId) {
  if (!datasetsPorSensor[sensorId]) {
    datasetsPorSensor[sensorId] = {
      label: `Sensor ${sensorId}`,
      data: [],
      borderColor: COLORES_SENSOR[sensorId] || '#94A3B8',
      backgroundColor: 'transparent',
      tension: 0.3,
      pointRadius: 3,
      pointHoverRadius: 5,
      borderWidth: 2,
    };
    grafico.data.datasets.push(datasetsPorSensor[sensorId]);
  }
  return datasetsPorSensor[sensorId];
}

const grafico = new Chart(ctx, {
  type: 'line',
  data: { datasets: [] },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'nearest', intersect: false },
    scales: {
      x: {
        type: 'time',
        time: { unit: 'minute' },
        grid: { color: 'rgba(255,255,255,0.05)' },
        ticks: { color: '#7C93A0', font: { family: 'IBM Plex Mono', size: 11 } },
      },
      y: {
        title: { display: true, text: 'L/min', color: '#7C93A0' },
        grid: { color: 'rgba(255,255,255,0.05)' },
        ticks: { color: '#7C93A0', font: { family: 'IBM Plex Mono', size: 11 } },
      },
    },
    plugins: {
      legend: { labels: { color: '#E7EEF2', font: { family: 'Inter', size: 12 } } },
    },
  },
});

// Chart.js necesita el adaptador de fechas; si no está disponible, cae a categoría simple.
if (!Chart.registry.getScale('time')) {
  grafico.options.scales.x.type = 'category';
}

function agregarPuntoGrafico(sensorId, timestamp, caudal) {
  const ds = obtenerDataset(sensorId);
  ds.data.push({ x: new Date(timestamp), y: caudal });
  if (ds.data.length > 200) ds.data.shift();
  grafico.update('none');
}

/* ---------------------------------------------------------
 * Tanque SVG
 * --------------------------------------------------------- */
function actualizarTanque(nivelPorcentaje) {
  const alto = (nivelPorcentaje / 100) * TANQUE_ALTO;
  const y = TANQUE_Y_BASE - alto;
  elLiquido.setAttribute('y', y);
  elLiquido.setAttribute('height', alto);
  elLiquidoOnda.setAttribute('y', Math.max(TANQUE_Y_TOPE, y - 3));
  elNivelPorcentaje.textContent = `${nivelPorcentaje}%`;
}

function actualizarListaSensores(sensores) {
  sensores.forEach((s) => {
    const li = elListaSensores.querySelector(`li[data-sensor="${s.sensor_id}"]`);
    if (!li) return;
    li.classList.toggle('activo', s.activo);
    const valorEl = li.querySelector('.valor-sensor');
    if (s.ultimo_caudal_lmin !== null && s.ultimo_caudal_lmin !== undefined) {
      valorEl.textContent = `${Number(s.ultimo_caudal_lmin).toFixed(2)} L/min`;
    } else {
      valorEl.textContent = s.activo ? 'activo' : 'inactivo';
    }
  });
}

/* ---------------------------------------------------------
 * Señal LoRa
 * --------------------------------------------------------- */
function actualizarSenal(rssi, snr) {
  if (rssi !== null && rssi !== undefined) {
    elValorRssi.textContent = `${rssi} dBm`;
    // RSSI tipico LoRa: -120 (muy debil) a -30 (muy fuerte)
    const pct = Math.min(100, Math.max(0, ((rssi + 120) / 90) * 100));
    elBarraRssi.style.width = `${pct}%`;
  }
  if (snr !== null && snr !== undefined) {
    elValorSnr.textContent = `${Number(snr).toFixed(1)} dB`;
    // SNR tipico LoRa: -20 (muy debil) a 10 (muy fuerte)
    const pct = Math.min(100, Math.max(0, ((snr + 20) / 30) * 100));
    elBarraSnr.style.width = `${pct}%`;
  }
}

/* ---------------------------------------------------------
 * Estado del dispositivo (en linea / sin señal)
 * --------------------------------------------------------- */
function marcarEnLinea(timestamp) {
  ultimaVezRecibido = new Date(timestamp);
  elPuntoEstado.className = 'punto-estado en-linea';
  elTextoEstado.textContent = 'En línea';
}

function refrescarTextoUltimaVez() {
  if (!ultimaVezRecibido) {
    elTextoUltimaVez.textContent = 'sin datos aún';
    return;
  }
  const segundos = Math.round((Date.now() - ultimaVezRecibido.getTime()) / 1000);
  elTextoUltimaVez.textContent = segundos < 5 ? 'justo ahora' : `hace ${segundos}s`;

  if (segundos > SEGUNDOS_SIN_SENAL) {
    elPuntoEstado.className = 'punto-estado sin-senal';
    elTextoEstado.textContent = 'Sin señal';
  }
}
setInterval(refrescarTextoUltimaVez, 1000);

/* ---------------------------------------------------------
 * Tabla de eventos
 * --------------------------------------------------------- */
function agregarFilaTabla({ hora, sensorId, caudal, volumen, rssi }) {
  const filaVacia = elCuerpoTabla.querySelector('.fila-vacia');
  if (filaVacia) filaVacia.remove();

  const tr = document.createElement('tr');
  tr.className = 'fila-nueva';
  tr.innerHTML = `
    <td>${hora}</td>
    <td style="color:${COLORES_SENSOR[sensorId] || '#E7EEF2'}">S${sensorId}</td>
    <td>${Number(caudal).toFixed(2)}</td>
    <td>${Number(volumen).toFixed(2)}</td>
    <td>${rssi ?? '—'}</td>
  `;
  elCuerpoTabla.prepend(tr);

  while (elCuerpoTabla.children.length > LIMITE_EVENTOS_TABLA) {
    elCuerpoTabla.removeChild(elCuerpoTabla.lastChild);
  }

  totalEventos++;
  elContadorEventos.textContent = `${totalEventos} recibidos`;
}

/* ---------------------------------------------------------
 * Carga inicial: historial + estado actual
 * --------------------------------------------------------- */
async function cargarEstadoInicial() {
  try {
    const [resEstado, resHistorial] = await Promise.all([
      fetch('/api/estado').then((r) => r.json()),
      fetch('/api/data?limit=150').then((r) => r.json()),
    ]);

    actualizarTanque(resEstado.nivelPorcentaje || 0);
    actualizarListaSensores(resEstado.sensores || []);
    if (resEstado.ultimaLectura) {
      actualizarSenal(resEstado.ultimaLectura.rssi, resEstado.ultimaLectura.snr);
      marcarEnLinea(resEstado.ultimaLectura.creado_en);
      refrescarTextoUltimaVez();
    }

    resHistorial
      .filter((fila) => fila.sensor_id !== null)
      .forEach((fila) => {
        agregarPuntoGrafico(fila.sensor_id, fila.creado_en, fila.caudal_lmin);
        agregarFilaTabla({
          hora: new Date(fila.creado_en).toLocaleTimeString(),
          sensorId: fila.sensor_id,
          caudal: fila.caudal_lmin,
          volumen: fila.volumen_l,
          rssi: fila.rssi,
        });
      });
  } catch (err) {
    console.error('No se pudo cargar el estado inicial:', err);
    elTextoEstado.textContent = 'Error al conectar con el servidor';
  }
}

/* ---------------------------------------------------------
 * Eventos en vivo por Socket.IO
 * --------------------------------------------------------- */
socket.on('nueva-lectura', ({ lectura, eventos, estado }) => {
  marcarEnLinea(lectura.creado_en);
  refrescarTextoUltimaVez();
  actualizarSenal(lectura.rssi, lectura.snr);
  actualizarTanque(estado.nivelPorcentaje);
  actualizarListaSensores(estado.sensores);

  eventos.forEach((ev) => {
    agregarPuntoGrafico(ev.sensorId, lectura.creado_en, ev.caudalLmin);
    agregarFilaTabla({
      hora: new Date(lectura.creado_en).toLocaleTimeString(),
      sensorId: ev.sensorId,
      caudal: ev.caudalLmin,
      volumen: ev.volumenL,
      rssi: lectura.rssi,
    });
  });
});

socket.on('connect', () => console.log('Conectado al servidor por WebSocket'));
socket.on('disconnect', () => console.log('Desconectado del servidor'));

cargarEstadoInicial();
