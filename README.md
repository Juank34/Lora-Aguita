# Monitor de Tanque — Dashboard LoRa

Servidor Node/Express que recibe las lecturas del ESP32 (POST `/api/data`),
las guarda en PostgreSQL y las muestra en vivo (WebSocket) en un dashboard
con el nivel del tanque, gráfico de caudal y calidad de señal LoRa.

## 1. Formato esperado del POST

El ESP32 ya lo manda así (mismo JSON que tenías en tu sketch):

```json
{
  "dispositivo": "PSoC5",
  "valor": "S1:12.50,3.75,10.00;S3:-4.20,-1.05,10.00",
  "rssi": -47,
  "snr": 8.5
}
```

`valor` es el string que arma el PSoC: `Sn:caudal_Lmin,volumen_L,tiempo_s`,
uno por cada sensor que cambió de estado en esa ventana, separados por `;`.
El servidor lo parsea automáticamente.

## 2. Correr en local

```bash
npm install
cp .env.example .env    # completá DATABASE_URL con tu Postgres local
npm start
```

Abrí `http://localhost:3000`.

## 3. Desplegar en Render

1. Subí esta carpeta a un repo de GitHub.
2. En Render: **New → PostgreSQL** (plan free alcanza para esto). Copiá la
   "Internal Database URL" una vez creada.
3. En Render: **New → Web Service**, apuntá al repo.
   - Build command: `npm install`
   - Start command: `npm start`
4. En el Web Service, pestaña **Environment**, agregá la variable
   `DATABASE_URL` con la Internal Database URL del paso 2. Render también te
   ofrece linkear la base directamente desde el selector "Add from Database",
   que hace lo mismo automáticamente.
5. Deploy. La primera vez que arranca, el servidor crea las tablas solo
   (`ensureSchema()` en `server.js`), no hace falta correr ninguna migración
   a mano.
6. Actualizá `serverUrl` en el sketch del ESP32 con la URL pública que te da
   Render (`https://tu-servicio.onrender.com/api/data`).

## 4. Estructura

```
server.js           → rutas /api/data, /api/estado, Socket.IO
db.js                → conexión a Postgres y creación de tablas
public/index.html    → estructura del dashboard
public/style.css     → sistema de diseño (paleta, tipografía, layout)
public/dashboard.js  → websocket, gráfico Chart.js, animación del tanque
```

## 5. Notas

- El "nivel estimado" del tanque se calcula como
  `(sensores activos / 3) * 100`, no como un valor continuo — es una
  aproximación por umbrales, igual que el sensado original.
- Free tier de Render: tanto el Web Service como la base "se duermen" tras
  un rato de inactividad. La primera petición después de eso puede tardar
  20-50s en responder — normal, no es un bug.
- Si en algún momento sumás más de 3 sensores, actualizá `NUM_SENSORES` en
  `db.js` (ahí es lo único que hay que tocar del lado del servidor).
