/*
 * Sous "nose" fallback: Arduino Uno/Nano + MQ-135 analog gas sensor.
 *
 * Physics: like the BME688, the MQ-135 is a heated SnO2 metal-oxide sensor.
 * Reducing gases (ammonia/amines, alcohols, smoke) LOWER its resistance Rs,
 * so lower ohms = more VOCs. It cannot identify which gas.
 *
 * Wiring: VCC -> 5V (the heater needs 5 V; 3.3 V will not heat it properly),
 *         GND -> GND, AOUT -> A0. Most modules already include the RL load
 *         resistor on board; we assume it is 10 kOhm (check/adjust the pot
 *         or part marking on your module and set RL_OHM accordingly).
 *
 * Voltage divider:  Vout = Vcc * RL / (Rs + RL)
 *                   => Rs = RL * (Vcc - Vout) / Vout
 *
 * Burn-in: a new MQ-135 should run powered for 24-48 h before readings are
 * meaningful, and needs a few minutes of warm-up after every power-up.
 *
 * Output (1 line per second, 115200 baud) for tools/serial_bridge.py:
 *   {"sensor_id":"mq135-01","location":"walk-in","gas_ohm":<Rs>,"temp_c":null,"rh":null,"t":<s>}
 * Lines starting with '#' are comments and are ignored by the bridge.
 */

#define SENSOR_ID    "mq135-01"
#define LOCATION     "walk-in"
#define ANALOG_PIN   A0
#define RL_OHM       10000.0f   // load resistor, 10 kOhm
#define VCC          5.0f       // ADC reference = supply (default AVR AREF)
#define ADC_MAX      1023.0f
#define SAMPLES      16         // average to tame ADC noise
#define INTERVAL_MS  1000UL

unsigned long lastMs = 0;

void setup() {
  Serial.begin(115200);
  Serial.println(F("# Sous Arduino + MQ-135 starting; allow 24-48 h burn-in for new sensors"));
}

void loop() {
  unsigned long now = millis();
  if (now - lastMs < INTERVAL_MS) return;
  lastMs = now;

  unsigned long sum = 0;
  for (uint8_t i = 0; i < SAMPLES; i++) {
    sum += analogRead(ANALOG_PIN);
    delay(2);
  }
  float adc = (float)sum / SAMPLES;

  // adc at 0 or full scale means open/shorted sensor: Rs would be infinite/zero.
  if (adc < 1.0f || adc > ADC_MAX - 1.0f) {
    Serial.println(F("# ADC out of range (check wiring / 5 V supply)"));
    return;
  }

  float vout = adc * VCC / ADC_MAX;
  float rs = RL_OHM * (VCC - vout) / vout;

  Serial.print(F("{\"sensor_id\":\"" SENSOR_ID "\",\"location\":\"" LOCATION "\",\"gas_ohm\":"));
  Serial.print(rs, 1);
  Serial.print(F(",\"temp_c\":null,\"rh\":null,\"t\":"));
  Serial.print(now / 1000.0, 1);
  Serial.println('}');
}
