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
const unsigned long FIREBASE_STANDBY_SEND_INTERVAL = 1000;
const unsigned long FIREBASE_ACTIVE_SEND_INTERVAL = 120000;

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

// ================= 2-MINUTE SAMPLING =================
#define MAX_SAMPLES 120  // One sample per second for 2 minutes
#define SAMPLING_INTERVAL 1000UL  // Sample once per second
#define SAMPLING_DURATION 120000UL  // 2 minutes in milliseconds
float weightSamples[MAX_SAMPLES];
int sampleCount = 0;
unsigned long samplingStartTime = 0;
unsigned long lastSampleTime = 0;
bool samplingActive = false;

// ================= WEIGHT AVERAGING =================
const unsigned long WEIGHT_AVERAGE_WINDOW = 120000UL; // 2 minutes
const float MIN_VALID_WEIGHT = 5.0;
unsigned long windowStartTime = 0;
double weightSum = 0;
unsigned int weightSampleCount = 0;
float averagedWeight = 0;
bool hasAveragedWeight = false;
bool lastProcessActive = false;
unsigned long lastStandbyUpdate = 0;
const unsigned long STANDBY_UPDATE_INTERVAL = 1000UL;  // Update every 1 second in standby

// ================= EEPROM =================
#define EEPROM_SIZE 512
#define CAL_ADDR 0
#define THRESHOLD_ADDR 20

void setRelay(bool on) {
  digitalWrite(RELAY_PIN, on ? RELAY_ON_LEVEL : RELAY_OFF_LEVEL);
  relayState = on;
}

// ================= SAMPLING FUNCTIONS =================
void addWeightSample(float weight) {
  if (sampleCount < MAX_SAMPLES) {
    weightSamples[sampleCount] = weight;
    sampleCount++;
  }
}

float getAverageWeight() {
  if (sampleCount == 0) return 0;
  float sum = 0;
  for (int i = 0; i < sampleCount; i++) {
    sum += weightSamples[i];
  }
  return sum / sampleCount;
}

void resetSampling() {
  sampleCount = 0;
  samplingStartTime = millis();
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

bool updateWeightAverage(float weight) {
  unsigned long now = millis();

  // Initialize window on first call
  if (windowStartTime == 0) {
    windowStartTime = now;
  }

  // Sample only once per second
  if (now - lastSampleTime >= SAMPLING_INTERVAL) {
    lastSampleTime = now;

    if (weight >= MIN_VALID_WEIGHT && weightSampleCount < MAX_SAMPLES) {
      weightSum += weight;
      weightSampleCount++;
      Serial.print("Sample ");
      Serial.print(weightSampleCount);
      Serial.print(": ");
      Serial.print(weight, 2);
      Serial.println(" g");
    }
  }

  // Check if 2-minute window has elapsed
  if (now - windowStartTime >= WEIGHT_AVERAGE_WINDOW) {
    windowStartTime = now;  // Start a new window

    if (weightSampleCount == 0) {
      Serial.println("No valid samples in 2-minute window!");
      return false;
    }

    // Calculate average
    averagedWeight = weightSum / weightSampleCount;
    hasAveragedWeight = true;

    Serial.print("=== 2-MINUTE WINDOW COMPLETE ===");
    Serial.print(" | Samples: ");
    Serial.print(weightSampleCount);
    Serial.print(" | Average: ");
    Serial.print(averagedWeight, 2);
    Serial.println(" g");

    // Reset for next window
    weightSum = 0;
    weightSampleCount = 0;
    lastSampleTime = 0;  // Reset sample timer for next window

    return true;
  }

  return false;
}

void resetWeightAverage() {
  windowStartTime = 0;
  weightSum = 0;
  weightSampleCount = 0;
  averagedWeight = 0;
  hasAveragedWeight = false;
  lastSampleTime = 0;
  lastFirebaseSend = 0;
  Serial.println("Weight averaging reset!");
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
  unsigned long sendInterval = processActive ? FIREBASE_ACTIVE_SEND_INTERVAL : FIREBASE_STANDBY_SEND_INTERVAL;
  if (now - lastFirebaseSend < sendInterval) return;
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

  if (processActive) {
    Firebase.RTDB.pushJSON(&fbdo, "/foodDrier/history", &json);
  }
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

  // Reset averaging when transitioning between standby and active
  if (processActive != lastProcessActive) {
    resetWeightAverage();
    lastProcessActive = processActive;
    Serial.print(">>> Process state changed to: ");
    Serial.println(processActive ? "ACTIVE" : "STANDBY");
  }

  unsigned long now = millis();
  float currentWeight = abs(scale.get_units(5));  // Current weight reading

  // ==========================================
  // UPDATE 2-MINUTE AVERAGE (if in ACTIVE mode)
  // ==========================================
  if (processActive) {
    bool windowComplete = updateWeightAverage(currentWeight);
  }

  // ==========================================
  // STANDBY MODE: Update display every 1 second
  // ==========================================
  if (!processActive) {
    if (now - lastStandbyUpdate >= STANDBY_UPDATE_INTERVAL) {
      lastStandbyUpdate = now;
      Serial.print("STANDBY | Current Weight: ");
      Serial.print(currentWeight, 2);
      Serial.println(" g");
      Blynk.virtualWrite(V0, currentWeight);
    }
  }

  // ==========================================
  // RELAY CONTROL: Based on 2-minute average
  // ==========================================
  bool shouldTurnOff = false;

  if (processActive && hasAveragedWeight) {
    // Only compare 2-minute average to threshold
    if (averagedWeight <= threshold) {
      shouldTurnOff = true;
      Serial.print(">>> 2-MIN AVERAGE (");
      Serial.print(averagedWeight, 2);
      Serial.print("g) <= THRESHOLD (");
      Serial.print(threshold, 2);
      Serial.println("g) - STOPPING");
    } else {
      Serial.print(">>> 2-MIN AVERAGE (");
      Serial.print(averagedWeight, 2);
      Serial.print("g) > THRESHOLD (");
      Serial.print(threshold, 2);
      Serial.println("g) - CONTINUING");
    }
  }

  // Apply relay control
  if (processActive && !shouldTurnOff) {
    // ACTIVE and target NOT reached: Keep heater ON
    setRelay(true);
    Blynk.virtualWrite(V1, 1);
    Serial.println(">>> SSR: ON (Drying in progress)");

    // Send average weight to Firebase every 2 minutes when available
    if (hasAveragedWeight) {
      sendToFirebase(averagedWeight, true);
      hasAveragedWeight = false;  // Mark as processed
    }
  } else {
    // STANDBY or target reached: Turn OFF
    setRelay(false);
    Blynk.virtualWrite(V1, 0);

    if (processActive && shouldTurnOff) {
      // Target reached - stop the process
      Serial.println(">>> SSR: OFF (Target reached!)");
      Firebase.RTDB.setBool(&fbdo, "/foodDrier/isActive", false);
      Firebase.RTDB.setBool(&fbdo, "/foodDrier/ssr", false);
      processActive = false;
      resetWeightAverage();
      sendToFirebase(averagedWeight, false);
    } else if (!processActive) {
      // Normal standby - always send weight to Firebase
      Serial.println(">>> SSR: OFF (Standby)");
      sendToFirebase(currentWeight, false);
    }
  }

  delay(100);  // Reduced delay for faster responsiveness
}
