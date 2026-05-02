#define BLYNK_TEMPLATE_ID "TMPL3MuoyBjph"
#define BLYNK_TEMPLATE_NAME "Food Drier"
#define BLYNK_AUTH_TOKEN "qxfoOhdJ7Gh02hWGrN1ceZdAYDqWx-mL"

#define BLYNK_PRINT Serial
#include <BlynkSimpleEsp8266.h>

char auth[] = BLYNK_AUTH_TOKEN;

#include <Wire.h>
#include "HX711.h"
#include <EEPROM.h>
#include <ESP8266WiFi.h>
#include <Firebase_ESP_Client.h>

// ================= FIREBASE =================
#define FIREBASE_HOST "https://food-dryer-dab22-default-rtdb.asia-southeast1.firebasedatabase.app/"
#define FIREBASE_SECRET "MBU8l4t114ysjAytcWqhuNv6A4Iub7c86utPwXaW"

FirebaseData fbdo;
FirebaseConfig fbConfig;
FirebaseAuth fbAuth;

bool firebaseReady = false;
unsigned long lastFirebaseSend = 0;
const unsigned long FIREBASE_SEND_INTERVAL = 2000;

unsigned long lastFirebaseRead = 0;
const unsigned long FIREBASE_READ_INTERVAL = 3000;
const unsigned long CONTROL_TIMEOUT = 10000;
unsigned long lastControlOk = 0;

// ================= WIFI =================
const char* ssid = "Galaxy M34 5G 55D7";
const char* password = "1234567890";

// ================= HX711 =================
#define DOUT D2
#define CLK D1
HX711 scale;

// ================= SSR / RELAY =================
#define RELAY_PIN D5

// Most relay/SSR modules are active-LOW:
// LOW = ON, HIGH = OFF. If your module is normal active-HIGH, set this false.
const bool RELAY_ACTIVE_LOW = true;
const int RELAY_ON_LEVEL = RELAY_ACTIVE_LOW ? LOW : HIGH;
const int RELAY_OFF_LEVEL = RELAY_ACTIVE_LOW ? HIGH : LOW;

// ================= CALIBRATION =================
float known_weight = 250.0;
float calibration_factor;

// ================= PROCESS VARIABLES =================
float threshold = 50.0;
bool processActive = false;
bool relayState = false;

// ================= EEPROM =================
#define EEPROM_SIZE 512
#define CAL_ADDR 0
#define THRESHOLD_ADDR 20

void setRelay(bool on) {
  digitalWrite(RELAY_PIN, on ? RELAY_ON_LEVEL : RELAY_OFF_LEVEL);
  relayState = on;
}

void saveCalibration(float value) {
  EEPROM.put(CAL_ADDR, value);
  EEPROM.commit();
}

float loadCalibration() {
  float value;
  EEPROM.get(CAL_ADDR, value);
  if (isnan(value) || value == 0) return -1;
  return value;
}

void saveThreshold(float value) {
  EEPROM.put(THRESHOLD_ADDR, value);
  EEPROM.commit();
  Serial.println("Threshold saved");
}

float loadThreshold() {
  float value;
  EEPROM.get(THRESHOLD_ADDR, value);
  if (isnan(value) || value <= 0) return 50.0;
  return value;
}

BLYNK_WRITE(V2) {
  float newThreshold = param.asFloat();
  if (newThreshold != threshold && newThreshold > 0) {
    threshold = newThreshold;
    saveThreshold(threshold);
    Serial.print("New Threshold (Blynk): ");
    Serial.println(threshold);

    if (firebaseReady) {
      Firebase.RTDB.setFloat(&fbdo, "/foodDrier/targetWeight", threshold);
    }
  }
}

void readFirebaseControls() {
  if (!firebaseReady) return;

  unsigned long now = millis();
  if (now - lastFirebaseRead < FIREBASE_READ_INTERVAL) return;
  lastFirebaseRead = now;

  if (Firebase.RTDB.getBool(&fbdo, "/foodDrier/isActive")) {
    processActive = fbdo.boolData();
    lastControlOk = now;
  } else {
    Serial.print("Firebase isActive read failed: ");
    Serial.println(fbdo.errorReason());
  }

  if (processActive) {
    if (Firebase.RTDB.getFloat(&fbdo, "/foodDrier/targetWeight")) {
      float firebaseTarget = fbdo.floatData();
      if (firebaseTarget > 0 && firebaseTarget != threshold) {
        threshold = firebaseTarget;
        saveThreshold(threshold);
        Serial.print("New target weight from Firebase: ");
        Serial.println(threshold);
        Blynk.virtualWrite(V2, threshold);
      }
    } else {
      Serial.print("Firebase targetWeight read failed: ");
      Serial.println(fbdo.errorReason());
    }
  }

  if (processActive && lastControlOk > 0 && now - lastControlOk > CONTROL_TIMEOUT) {
    processActive = false;
    setRelay(false);
    Serial.println("Control timeout: SSR forced OFF");
  }
}

void sendToFirebase(float weight, bool relay) {
  if (!firebaseReady) return;

  unsigned long now = millis();
  if (now - lastFirebaseSend < FIREBASE_SEND_INTERVAL) return;
  lastFirebaseSend = now;

  FirebaseJson json;
  json.set("weight", weight);
  json.set("relayState", relay ? "ON" : "OFF");
  json.set("threshold", threshold);
  json.set("isActive", processActive);
  json.set("timestamp/.sv", "timestamp");

  if (Firebase.RTDB.setJSON(&fbdo, "/foodDrier/live", &json)) {
    Serial.println("Firebase: Data sent OK");
  } else {
    Serial.print("Firebase Error: ");
    Serial.println(fbdo.errorReason());
  }

  Firebase.RTDB.pushJSON(&fbdo, "/foodDrier/history", &json);
}

void calibrate() {
  Serial.println("\n=== CALIBRATION START ===");

  Serial.println("Remove all weight...");
  Blynk.virtualWrite(V1, "Remove all weight");
  delay(3000);

  scale.tare();
  Serial.println("Tare done");
  Blynk.virtualWrite(V1, "Tare done");

  Serial.print("Place ");
  Serial.print(known_weight);
  Serial.println(" g weight...");
  Blynk.virtualWrite(V1, "Place 250g Weight");
  delay(5000);

  long reading = scale.get_units(10);
  calibration_factor = reading / known_weight;
  scale.set_scale(calibration_factor);
  saveCalibration(calibration_factor);

  Serial.print("Calibration Factor: ");
  Serial.println(calibration_factor);
  Serial.println("=== CALIBRATION DONE ===\n");
  Blynk.virtualWrite(V1, "done");
}

void setup() {
  Serial.begin(9600);

  pinMode(RELAY_PIN, OUTPUT);
  setRelay(false);

  EEPROM.begin(EEPROM_SIZE);
  scale.begin(DOUT, CLK);

  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    setRelay(false);
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected: " + WiFi.localIP().toString());

  Blynk.config(auth);
  Blynk.connect();

  fbConfig.database_url = FIREBASE_HOST;
  fbConfig.signer.tokens.legacy_token = FIREBASE_SECRET;
  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectWiFi(true);

  firebaseReady = true;
  processActive = false;
  setRelay(false);
  Firebase.RTDB.setBool(&fbdo, "/foodDrier/isActive", false);
  Serial.println("Firebase initialized. SSR forced OFF.");

  calibration_factor = loadCalibration();
  if (calibration_factor == -1) {
    Serial.println("No valid calibration found!");
    calibrate();
  } else {
    Serial.println("Calibration loaded: " + String(calibration_factor));
    scale.set_scale(calibration_factor);
    delay(2000);
    scale.tare();
  }

  threshold = loadThreshold();
  Serial.print("Loaded Threshold: ");
  Serial.println(threshold);
  Serial.println("System Ready\n");
}

void loop() {
  Blynk.run();

  if (Serial.available()) {
    char cmd = Serial.read();
    if (cmd == 'c' || cmd == 'C') calibrate();
  }

  readFirebaseControls();

  float weight = abs(scale.get_units(5));
  Serial.print("Weight: ");
  Serial.print(weight, 2);
  Serial.println(" g");
  Blynk.virtualWrite(V0, weight);

  if (processActive && weight > threshold) {
    setRelay(true);
    Serial.println("Status: ACTIVE - SSR ON");
    Blynk.virtualWrite(V1, 1);
  } else {
    setRelay(false);
    Blynk.virtualWrite(V1, 0);

    if (processActive && weight <= threshold) {
      Serial.println("Status: TARGET REACHED - SSR OFF");
      if (Firebase.RTDB.setBool(&fbdo, "/foodDrier/isActive", false)) {
        processActive = false;
        Serial.println("Firebase updated: isActive set to false");
      }
    } else {
      Serial.println("Status: STANDBY - SSR OFF");
    }
  }

  sendToFirebase(weight, relayState);
  delay(200);
}
