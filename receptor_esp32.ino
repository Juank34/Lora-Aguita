/* ============================================================
 *  RECEPTOR ESP32 -> POST /api/data
 *  ------------------------------------------------------------
 *  El servidor (server.js) espera el payload CRUDO del PSoC, tal
 *  cual llega por LoRa (sea "S1:12.50,3.75,10.00;S3:..." o el
 *  reporte "R:84.32,10.05,...,1"), en el campo "valor". El propio
 *  server se encarga de parsear cada tipo (parsearValor / parsearReporte)
 *  y guardarlo en Postgres. Aca NO se arma ningun JSON estructurado,
 *  simplemente se reenvia el string tal cual.
 *
 *  LIBRERIAS NECESARIAS (Arduino Library Manager):
 *    - "LoRa" de Sandeep Mistry
 *    - "ArduinoJson" (v6 o v7) -- solo para armar el body del POST
 *
 *  COMPLETAR ANTES DE USAR:
 *    - WIFI_SSID / WIFI_PASSWORD
 *    - URL_SERVIDOR (la base de tu servicio en Render + "/api/data")
 * ============================================================ */
#include <SPI.h>
#include <LoRa.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

/* ---------------- Pines LoRa (ajustar segun wiring) ---------------- */
#define PIN_SS    5
#define PIN_RST   14
#define PIN_DIO0  2
#define FRECUENCIA_HZ  915E6

/* ---------------- WiFi ---------------- */
const char* WIFI_SSID     = "NOMBRE_DE_TU_RED";
const char* WIFI_PASSWORD = "CLAVE_DE_TU_RED";

/* ---------------- Servidor ----------------
 * OJO: tiene que apuntar exactamente a /api/data, que es la ruta
 * que existe en tu server.js (app.post('/api/data', ...)). */
const char* URL_SERVIDOR = "https://TU-SERVICIO.onrender.com/api/data";

/* Identificador que va a quedar guardado en la columna "dispositivo"
 * de la tabla "lecturas". Util si en el futuro tenes mas de un PSoC. */
const char* NOMBRE_DISPOSITIVO = "psoc-tanque-01";

#define HTTP_TIMEOUT_MS   5000

void setup() {
    Serial.begin(115200);
    delay(200);

    conectarWiFi();

    LoRa.setPins(PIN_SS, PIN_RST, PIN_DIO0);
    if (!LoRa.begin(FRECUENCIA_HZ)) {
        Serial.println("Error al iniciar LoRa");
        while (1) {}
    }

    Serial.println("Receptor LoRa listo, esperando paquetes...");
}

void loop() {
    if (WiFi.status() != WL_CONNECTED) {
        conectarWiFi();
    }

    int tamPaquete = LoRa.parsePacket();
    if (tamPaquete == 0) return;

    String paquete = "";
    while (LoRa.available()) {
        paquete += (char)LoRa.read();
    }
    int   rssi = LoRa.packetRssi();
    float snr  = LoRa.packetSnr();

    Serial.println("----------------------------------------");
    Serial.print("RSSI: "); Serial.print(rssi); Serial.println(" dBm");
    Serial.print("SNR: ");  Serial.print(snr);  Serial.println(" dB");
    Serial.print("Payload crudo recibido: ");
    Serial.println(paquete);

    subirPayload(paquete, rssi, snr);
}

void conectarWiFi() {
    Serial.print("Conectando a WiFi");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    uint8_t intentos = 0;
    while (WiFi.status() != WL_CONNECTED && intentos < 40) {
        delay(250);
        Serial.print(".");
        intentos++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.print("\nWiFi conectado, IP: ");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println("\nNo se pudo conectar al WiFi (se reintentara en el proximo paquete).");
    }
}

/* Arma {dispositivo, valor, rssi, snr} y lo postea a /api/data.
 * ArduinoJson se usa aca SOLO para escapar bien el string "valor"
 * (por si algun caracter especial aparece), no para reestructurar
 * los datos -- eso lo hace el servidor. */
void subirPayload(const String& valorCrudo, int rssi, float snr) {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("Sin WiFi, no se pudo subir el dato.");
        return;
    }

    JsonDocument doc; // ArduinoJson v7. Si usas v6: StaticJsonDocument<256> doc;
    doc["dispositivo"] = NOMBRE_DISPOSITIVO;
    doc["valor"]        = valorCrudo;
    doc["rssi"]          = rssi;
    doc["snr"]            = snr;

    String jsonBody;
    serializeJson(doc, jsonBody);

    Serial.print("POST hacia: "); Serial.println(URL_SERVIDOR);
    Serial.print("Body: ");       Serial.println(jsonBody);

    HTTPClient http;
    http.begin(URL_SERVIDOR);
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(HTTP_TIMEOUT_MS);

    int codigoHttp = http.POST(jsonBody);

    if (codigoHttp > 0) {
        Serial.print("POST -> codigo HTTP: ");
        Serial.println(codigoHttp);
        String respuesta = http.getString();
        if (respuesta.length() > 0) {
            Serial.print("Respuesta del servidor: ");
            Serial.println(respuesta);
        }
    } else {
        Serial.print("Error en POST: ");
        Serial.println(http.errorToString(codigoHttp));
    }

    http.end();
}
