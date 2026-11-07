/*
 * Sous "nose" firmware: ESP32 + Bosch BME688 (or BME680) over I2C.
 *
 * ---------------------------------------------------------------------------
 * PHYSICS (why this works, and what it can't do)
 * ---------------------------------------------------------------------------
 * The gas channel of the BME68x is a metal-oxide (MOX) sensor. A thin SnO2
 * (tin dioxide) film sits on a micro-hotplate. We heat it to ~320 C (see
 * GAS_HEATER_TEMP_C). At that temperature oxygen from the air adsorbs on the
 * SnO2 surface and captures conduction-band electrons, building a depletion
 * layer that gives the film a high resistance in clean air.
 *
 * Reducing gases (VOCs such as ethanol, amines from decaying protein,
 * acrolein from overheated oil, plus CO and H2) react with that adsorbed
 * oxygen and hand the electrons back to the film. Conductivity rises, so
 * RESISTANCE FALLS. Therefore:
 *
 *        lower ohms  ==  more reducing VOCs in the air.
 *
 * That is why the Sous backend computes   ratio = baseline_ohm / gas_ohm
 * (ratio > 1 means more VOCs than the clean-air baseline).
 *
 * Caveats we are honest about:
 *   - One heater step gives ONE resistance number. It does not identify a
 *     specific gas. Classification (spoilage vs burning vs cleaning) is done
 *     downstream from context (location, rate of rise, humidity) and, in a
 *     production build, a trained model (Bosch BSEC / BME AI-Studio).
 *   - Resistance is humidity cross-sensitive; we send rh so the backend can
 *     account for it.
 *   - Resistance DRIFTS for the first minutes after power-up while the
 *     hotplate and film reach thermal/chemical equilibrium. See WARM-UP.
 *
 * ---------------------------------------------------------------------------
 * WARM-UP
 * ---------------------------------------------------------------------------
 * Allow ~5 minutes of continuous operation before trusting gas_ohm for a
 * baseline (a fresh sensor benefits from 24-48 h of burn-in; Bosch suggests
 * this for new parts). Readings are still transmitted during warm-up so the
 * dashboard can show "warming"; a "# warming up" comment line is also printed
 * to Serial. Lines starting with '#' are comments; the serial bridge ignores
 * them. Set POST_DURING_WARMUP to 0 to suppress HTTP posts until warm.
 *
 * ---------------------------------------------------------------------------
 * OUTPUT
 * ---------------------------------------------------------------------------
 * Every READ_INTERVAL_MS we do one forced-mode measurement and:
 *   1. print one JSON line to Serial (115200 baud) - usable with
 *      tools/serial_bridge.py when WiFi is unavailable;
 *   2. HTTP POST the same JSON to http://SERVER_HOST:SERVER_PORT/api/sensor/reading
 *      (Sous contract: POST /api/sensor/reading).
 *
 *   {"sensor_id":"esp32-01","location":"walk-in","gas_ohm":123456.0,
 *    "temp_c":4.1,"rh":61.2,"pressure_hpa":1012.3,"t":1234.5}
 *
 * Libraries (Library Manager): "Adafruit BME680 Library", "Adafruit Unified Sensor".
 * ESP32 core (Espressif) provides WiFi.h and HTTPClient.h.
 */

#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <math.h>
#include <Adafruit_Sensor.h>
#include "Adafruit_BME680.h"

// ============================ USER CONFIGURATION ===========================
#define WIFI_SSID        "YOUR_WIFI_SSID"
#define WIFI_PASSWORD    "YOUR_WIFI_PASSWORD"
#define SERVER_HOST      "192.168.1.50"   // IP/hostname of the machine running the Sous backend
#define SERVER_PORT      8000
#define SENSOR_ID        "esp32-01"
#define SENSOR_LOCATION  "walk-in"        // e.g. "walk-in", "fry-station"

#define I2C_SDA_PIN      21
#define I2C_SCL_PIN      22
#define READ_INTERVAL_MS 1000UL

// BME68x heater profile: 320 C for 150 ms per measurement.
#define GAS_HEATER_TEMP_C   320
#define GAS_HEATER_TIME_MS  150

#define WARMUP_MS           (5UL * 60UL * 1000UL)
#define POST_DURING_WARMUP  1

#define HTTP_TIMEOUT_MS         2000   // keep short so a dead server cannot stall the 1 Hz loop
#define WIFI_CONNECT_TIMEOUT_MS 15000UL
#define WIFI_RETRY_INTERVAL_MS  10000UL
#define SENSOR_INIT_RETRY_MS    3000UL
#define MAX_FAILED_READS        10     // consecutive failures before re-initialising the sensor
// ===========================================================================

Adafruit_BME680 bme;  // I2C on the default Wire bus
static bool sensorReady = false;
static unsigned long lastReadMs = 0;
static unsigned long lastWifiAttemptMs = 0;
static uint8_t failedReads = 0;

// Configure oversampling / filter / heater. Returns false if the chip is not found.
// begin() takes the I2C address (default 0x77) and runs the chip init.
static bool initSensor() {
  // Breakouts ship as 0x77 (Adafruit default) or 0x76 (SDO pulled low / Pimoroni).
  if (!bme.begin(0x77) && !bme.begin(0x76)) {
    return false;
  }
  bme.setTemperatureOversampling(BME680_OS_2X);
  bme.setHumidityOversampling(BME680_OS_2X);
  bme.setPressureOversampling(BME680_OS_2X);
  bme.setIIRFilterSize(BME680_FILTER_SIZE_3);
  bme.setGasHeater(GAS_HEATER_TEMP_C, GAS_HEATER_TIME_MS);
  return true;
}

// Non-blocking-ish WiFi supervision: called every loop, retries at most every
// WIFI_RETRY_INTERVAL_MS. Serial output never depends on WiFi.
static void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  unsigned long now = millis();
  if (lastWifiAttemptMs != 0 && now - lastWifiAttemptMs < WIFI_RETRY_INTERVAL_MS) return;
  lastWifiAttemptMs = now ? now : 1;

  Serial.println("# WiFi down, (re)connecting...");
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
    delay(250);
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("# WiFi connected, IP ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("# WiFi connect timed out; will retry (serial output continues)");
  }
}

// Format a float for JSON; NaN/inf are not valid JSON so emit null.
static void appendNum(char *buf, size_t n, const char *key, float v, int decimals, bool last = false) {
  size_t len = strlen(buf);
  if (isnan(v) || isinf(v)) {
    snprintf(buf + len, n - len, "\"%s\":null%s", key, last ? "" : ",");
  } else {
    snprintf(buf + len, n - len, "\"%s\":%.*f%s", key, decimals, v, last ? "" : ",");
  }
}

static void buildJson(char *buf, size_t n, float gasOhm, float tempC, float rh, float pHpa) {
  snprintf(buf, n, "{\"sensor_id\":\"%s\",\"location\":\"%s\",", SENSOR_ID, SENSOR_LOCATION);
  appendNum(buf, n, "gas_ohm", gasOhm, 1);
  appendNum(buf, n, "temp_c", tempC, 2);
  appendNum(buf, n, "rh", rh, 2);
  appendNum(buf, n, "pressure_hpa", pHpa, 2);
  appendNum(buf, n, "t", millis() / 1000.0f, 1, true);
  size_t len = strlen(buf);
  snprintf(buf + len, n - len, "}");
}

static bool postReading(const char *json) {
  if (WiFi.status() != WL_CONNECTED) return false;
  char url[96];
  snprintf(url, sizeof(url), "http://%s:%d/api/sensor/reading", SERVER_HOST, SERVER_PORT);

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(url)) return false;
  http.addHeader("Content-Type", "application/json");
  int code = http.POST((uint8_t *)json, strlen(json));
  http.end();
  if (code < 200 || code >= 300) {
    Serial.print("# POST failed, code ");
    Serial.println(code);  // negative = transport error (e.g. connection refused)
    return false;
  }
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("# Sous ESP32 + BME688 nose booting");

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  sensorReady = initSensor();
  if (!sensorReady) {
    Serial.println("# BME68x not found at 0x77/0x76: check wiring; will keep retrying");
  }
  ensureWifi();
}

void loop() {
  ensureWifi();

  // Retry sensor init if the chip was missing at boot or was re-initialised.
  if (!sensorReady) {
    static unsigned long lastInitTry = 0;
    if (millis() - lastInitTry >= SENSOR_INIT_RETRY_MS) {
      lastInitTry = millis();
      sensorReady = initSensor();
      if (sensorReady) { Serial.println("# BME68x found"); failedReads = 0; }
    }
    delay(50);
    return;
  }

  unsigned long now = millis();
  if (now - lastReadMs < READ_INTERVAL_MS) { delay(5); return; }
  lastReadMs = now;

  // performReading() runs one forced-mode measurement (temp/hum/pres/gas) and
  // blocks until it finishes (~heater time + conversion). Returns false on failure.
  if (!bme.performReading()) {
    Serial.println("# performReading failed");
    if (++failedReads >= MAX_FAILED_READS) {
      Serial.println("# too many failed reads, re-initialising sensor");
      sensorReady = false;
    }
    return;
  }
  failedReads = 0;

  float gasOhm = (float)bme.gas_resistance;       // ohms
  float tempC  = bme.temperature;                 // deg C
  float rh     = bme.humidity;                    // %
  float pHpa   = bme.pressure / 100.0f;           // library reports Pa

  char json[200];
  buildJson(json, sizeof(json), gasOhm, tempC, rh, pHpa);
  Serial.println(json);   // always: serial bridge works without WiFi

  bool warming = millis() < WARMUP_MS;
  if (warming) {
    Serial.print("# warming up, ");
    Serial.print((WARMUP_MS - millis()) / 1000UL);
    Serial.println(" s left (gas_ohm still drifting)");
  }
  if (!warming || POST_DURING_WARMUP) {
    postReading(json);  // failures are logged and simply dropped; next reading is 1 s away
  }
}
