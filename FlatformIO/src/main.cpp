#include <Arduino.h>
#include <vector>

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>

#include <time.h>
#include <sys/time.h>

#include <Wire.h>
#include <SPI.h>

#include <ArduinoJson.h>
#include <Adafruit_SHT31.h>
#include <Adafruit_PN532.h>

/*************************************************
 * SmartRoom ESP32 — MQTT realtime + PN532 + SHT31
 * ----------------------------------------------
 * Architecture (final):
 *   ESP32 <-> MQTT Broker (realtime control + telemetry + events)
 *   Bridge (Node.js) subscribes room1/# -> Firebase RTDB (storage/history/log)
 *
 * Topics (ROOM=room1):
 *   Publish:
 *     room1/state   (retain) : state snapshot
 *     room1/tele             : telemetry {ts,motion,t,h}
 *     room1/event            : rfid/alarm/mode events
 *     room1/status (retain)  : "online"/"offline" (LWT)
 *   Subscribe:
 *     room1/cmd              : web/app commands
 *     room1/rfid/allow (retain) : allowlist payload {ts,uids:[...]}
 *
 * RFID allowlist (Cách B):
 *   Firebase RTDB: config/rfid/allow/<UID_KEY> ... (handled by web admin)
 *   Bridge publishes retained MQTT:
 *     room1/rfid/allow = { "ts": 170..., "uids": ["04ABCDEF12", ...] }
 *   ESP32 checks UID locally (no REST calls, no bridge dependency at swipe-time).
 *
 * Mode mapping (no web changes):
 *   modeIdx=0 -> HOME (AUTO_HOME)
 *   modeIdx=1 -> AWAY (AWAY_ARMED)
 *   modeIdx=2 -> NIGHT (MANUAL)
 *
 * Time:
 *   Publish field "ts" uses Unix epoch milliseconds.
 *   If NTP not synced, falls back to millis() (still monotonic).
 *************************************************/

// ===================== USER CONFIG =====================
// WiFi
static const char* WIFI_SSID = "AuRoRa_Lau1_2.4G";  //
static const char* WIFI_PASS = "43qaurora";  //

// MQTT (HiveMQ Cloud)
static const char* MQTT_HOST = "92864f9d9c26428b9eb175c5fd429f4f.s1.eu.hivemq.cloud";
static const uint16_t MQTT_PORT = 8883; // TLS
static const char* MQTT_USER = "ESP32";
static const char* MQTT_PASS = "Hung@2005";

// ROOM
static const char* ROOM = "room1";

// Relay active-low? (LOW => ON)
static const bool RELAY_ACTIVE_LOW = false;

// ===================== PIN MAP =====================
// I2C (SHT31)
static const uint8_t PIN_I2C_SDA = 21;
static const uint8_t PIN_I2C_SCL = 22;

// PIR
static const uint8_t PIN_PIR     = 27;

// Relays (match your wiring)
static const uint8_t PIN_RELAY_LIGHT = 26;
static const uint8_t PIN_RELAY_FAN   = 25;
static const uint8_t PIN_RELAY_SIREN = 33;

// PN532 (SPI)
static const uint8_t PIN_PN532_SCK  = 18;
static const uint8_t PIN_PN532_MISO = 19;
static const uint8_t PIN_PN532_MOSI = 23;
static const uint8_t PIN_PN532_SS   = 5;
static const uint8_t PIN_PN532_RST  = 4;

// ===================== TIMINGS / DEFAULTS =====================
static const uint32_t TELE_PERIOD_MS       = 2000;
static const uint32_t SHT_PERIOD_MS        = 2000;
static const uint32_t PN532_POLL_MS        = 150;
static const uint32_t RFID_DEBOUNCE_MS     = 2000;

static const uint32_t OCC_TIMEOUT_MS       = 60000;   // occupied=false after 60s no motion
static const uint32_t LIGHT_OFF_DELAY_MS   = 5UL * 60UL * 1000UL; // 5 minutes
static const uint32_t FAN_RUNON_MS         = 60000;   // run-on after unoccupied

static const uint32_t AWAY_EXIT_DELAY_MS   = 15000;
static const uint32_t AWAY_PENDING_MS      = 30000;
static const uint32_t AWAY_SIREN_MAX_MS    = 60000;

static const uint32_t MANUAL_TIMEOUT_MS    = 10UL * 60UL * 1000UL;
static const uint32_t MANUAL_SIREN_MAX_MS  = 30000;

// Fan hysteresis
static float T_on  = 30.0f;
static float T_off = 28.0f;
static float H_on  = 80.0f;
static float H_off = 70.0f;

// Allowlist limits
static const uint16_t ALLOWLIST_MAX_UIDS = 80;

// ===================== TIME HELPERS =====================
static uint64_t g_epochBaseMs = 0;  // epoch ms at sync
static uint32_t g_uptimeBaseMs = 0; // millis() at sync

static inline bool timeReached(uint32_t now, uint32_t deadline) {
  return (int32_t)(now - deadline) >= 0;
}

static inline uint64_t nowEpochMs() {
  if (g_epochBaseMs == 0) return 0;
  uint32_t up = millis();
  return g_epochBaseMs + (uint64_t)(up - g_uptimeBaseMs);
}

static inline uint64_t epochMsOrFallback() {
  uint64_t e = nowEpochMs();
  if (e == 0) return (uint64_t)millis();
  return e;
}

static inline uint64_t monoDeadlineToEpoch(uint32_t deadlineMono) {
  if (deadlineMono == 0) return 0;
  uint64_t nowE = nowEpochMs();
  if (nowE == 0) return 0;
  uint32_t nowM = millis();
  int32_t delta = (int32_t)(deadlineMono - nowM);
  return nowE + (int64_t)delta;
}

static inline uint64_t normalizeTsMs(uint64_t ts) {
  // accept seconds and ms
  if (ts > 1000000000ULL && ts < 1000000000000ULL) return ts * 1000ULL;
  return ts;
}

// ===================== IO HELPERS =====================
static inline void relayWrite(uint8_t pin, bool on) {
  if (RELAY_ACTIVE_LOW) digitalWrite(pin, on ? LOW : HIGH);
  else digitalWrite(pin, on ? HIGH : LOW);
}

static String uidToHexKey(const uint8_t* uid, uint8_t len) {
  // UID_KEY: uppercase hex without ':'
  String out;
  out.reserve(len * 2);
  const char* hex = "0123456789ABCDEF";
  for (uint8_t i = 0; i < len; i++) {
    out += hex[(uid[i] >> 4) & 0xF];
    out += hex[uid[i] & 0xF];
  }
  return out;
}

static String normalizeUidKey(const String& s) {
  String out;
  out.reserve(s.length());
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    bool isHex =
      (c >= '0' && c <= '9') ||
      (c >= 'A' && c <= 'F') ||
      (c >= 'a' && c <= 'f');
    if (!isHex) continue;
    if (c >= 'a' && c <= 'f') c = (char)(c - 32);
    out += c;
  }
  return out;
}

// ===================== DEVICE STATE =====================
enum ModeIdx : uint8_t { MODE_HOME = 0, MODE_AWAY = 1, MODE_MANUAL = 2 };

static const char* alarmStates[] = {
  "DISARMED",
  "EXIT_DELAY",
  "ARMED_IDLE",
  "ALARM_PENDING",
  "ALARM_ON"
};

enum AlarmState : uint8_t {
  DISARMED = 0,
  EXIT_DELAY = 1,
  ARMED_IDLE = 2,
  ALARM_PENDING = 3,
  ALARM_ON = 4
};

static struct {
  uint64_t ts = 0;

  uint8_t modeIdx = MODE_HOME;
  bool occupied = false;

  bool light = false;
  bool fan = false;
  bool siren = false;

  uint8_t alarmState = DISARMED;

  // deadlines in monotonic ms
  uint32_t alarmUntilMono = 0;
  uint32_t sirenUntilMono = 0;
  uint32_t manualUntilMono = 0;

  // last command
  String lastReqId;
  String lastSource;
  String lastTarget;
  int lastValue = 0;
  uint64_t lastCmdTs = 0;
} st;

static uint32_t lastMotionMs = 0;
static uint32_t unoccSinceMs = 0;
static uint32_t fanRunonUntil = 0;

static uint32_t lastShtMs = 0;
static float lastT = NAN;
static float lastH = NAN;

static uint32_t lastTeleMs = 0;

static uint32_t lastCardMs = 0;

// ===================== RFID allowlist (dynamic, from MQTT retain) =====================
static std::vector<String> g_allowUids;
static bool g_allowReady = false;
static uint64_t g_allowMsgTs = 0;

// Optional emergency/fallback cards (compile-time). Put 0 cards to disable.
static const char* FALLBACK_MASTER_UIDS[] = {
  // "04ABCDEF12"
};

static bool isAllowedUid(const String& uidKeyRaw) {
  const String uidKey = normalizeUidKey(uidKeyRaw);
  if (uidKey.length() == 0) return false;

  // dynamic allowlist
  for (const auto& u : g_allowUids) {
    if (u == uidKey) return true;
  }

  // fallback allowlist
  for (const auto* m : FALLBACK_MASTER_UIDS) {
    if (uidKey == String(m)) return true;
  }

  return false;
}

// ===================== MQTT =====================
static WiFiClientSecure net;
static PubSubClient mqtt(net);

static String topicState()     { return String(ROOM) + "/state"; }
static String topicTele()      { return String(ROOM) + "/tele"; }
static String topicEvent()     { return String(ROOM) + "/event"; }
static String topicCmd()       { return String(ROOM) + "/cmd"; }
static String topicStatus()    { return String(ROOM) + "/status"; }
static String topicRfidAllow() { return String(ROOM) + "/rfid/allow"; }

static void publishJson(const String& topic, const JsonDocument& doc, bool retain = false) {
  String out;
  serializeJson(doc, out);
  mqtt.publish(topic.c_str(), out.c_str(), retain);
}

static void publishStatus(const char* status) {
  mqtt.publish(topicStatus().c_str(), status, true);
}

static void publishState() {
  StaticJsonDocument<896> doc;

  st.ts = epochMsOrFallback();
  doc["ts"] = st.ts;
  doc["timeSynced"] = (nowEpochMs() != 0);

  doc["modeIdx"] = st.modeIdx;
  doc["occupied"] = st.occupied;
  doc["light"] = st.light;
  doc["fan"] = st.fan;
  doc["siren"] = st.siren;

  doc["alarmState"] = alarmStates[st.alarmState];

  doc["alarmUntil"]  = (uint64_t)monoDeadlineToEpoch(st.alarmUntilMono);
  doc["sirenUntil"]  = (uint64_t)monoDeadlineToEpoch(st.sirenUntilMono);
  doc["manualUntil"] = (uint64_t)monoDeadlineToEpoch(st.manualUntilMono);

  JsonObject lc = doc.createNestedObject("lastCmd");
  lc["reqId"] = st.lastReqId;
  lc["source"] = st.lastSource;
  lc["target"] = st.lastTarget;
  lc["value"] = st.lastValue;
  lc["ts"] = (uint64_t)st.lastCmdTs;

  // optional debug
  doc["uptimeMs"] = (uint32_t)millis();
  doc["aclReady"] = g_allowReady;
  doc["aclCount"] = (uint16_t)g_allowUids.size();
  doc["aclTs"] = (uint64_t)g_allowMsgTs;

  publishJson(topicState(), doc, true);
}

static void publishTele(bool motion) {
  StaticJsonDocument<256> doc;
  doc["ts"] = (uint64_t)epochMsOrFallback();
  doc["motion"] = motion ? 1 : 0;
  if (!isnan(lastT)) doc["t"] = lastT;
  if (!isnan(lastH)) doc["h"] = lastH;
  publishJson(topicTele(), doc, false);
}

static void publishEventRfid(const String& uidKey, const char* result) {
  StaticJsonDocument<256> doc;
  doc["ts"] = (uint64_t)epochMsOrFallback();
  doc["type"] = "rfid";
  doc["uid"] = uidKey;
  doc["result"] = result;
  publishJson(topicEvent(), doc, false);
}

static void publishEventAlarm(const char* from, const char* to, const char* reason) {
  StaticJsonDocument<256> doc;
  doc["ts"] = (uint64_t)epochMsOrFallback();
  doc["type"] = "alarm";
  doc["from"] = from;
  doc["to"] = to;
  doc["reason"] = reason;
  publishJson(topicEvent(), doc, false);
}

static void publishEventMode(uint8_t from, uint8_t to, const char* reason) {
  StaticJsonDocument<256> doc;
  doc["ts"] = (uint64_t)epochMsOrFallback();
  doc["type"] = "mode";
  doc["from"] = from;
  doc["to"] = to;
  doc["reason"] = reason;
  publishJson(topicEvent(), doc, false);
}

// ===================== SENSORS =====================
static Adafruit_SHT31 sht31;
static Adafruit_PN532 nfc(PIN_PN532_SCK, PIN_PN532_MISO, PIN_PN532_MOSI, PIN_PN532_SS);

static void initSht() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  if (!sht31.begin(0x44)) {
    Serial.println("[SHT31] NOT FOUND");
  } else {
    Serial.println("[SHT31] OK");
  }
}

static void initPN532() {
  pinMode(PIN_PN532_RST, OUTPUT);
  digitalWrite(PIN_PN532_RST, LOW);
  delay(40);
  digitalWrite(PIN_PN532_RST, HIGH);
  delay(40);

  SPI.begin(PIN_PN532_SCK, PIN_PN532_MISO, PIN_PN532_MOSI, PIN_PN532_SS);
  nfc.begin();

  uint32_t ver = nfc.getFirmwareVersion();
  if (!ver) {
    Serial.println("[PN532] NOT FOUND (check SPI wiring)");
    return;
  }
  Serial.printf("[PN532] OK chip=0x%02X fw=%u.%u\n",
                (uint8_t)((ver >> 24) & 0xFF),
                (uint8_t)((ver >> 16) & 0xFF),
                (uint8_t)((ver >> 8) & 0xFF));
  nfc.SAMConfig();
}

static void readSht() {
  if (millis() - lastShtMs < SHT_PERIOD_MS) return;
  lastShtMs = millis();
  float t = sht31.readTemperature();
  float h = sht31.readHumidity();
  if (isnan(t) || isnan(h)) return;
  lastT = t;
  lastH = h;
}

static bool readPir() {
  bool motion = digitalRead(PIN_PIR) == HIGH;
  if (motion) lastMotionMs = millis();
  return motion;
}

// ===================== MODE LOGIC =====================
static void enterMode(uint8_t newMode, const char* reason) {
  if (newMode > MODE_MANUAL) newMode = MODE_HOME;
  if (newMode == st.modeIdx) return;

  uint8_t old = st.modeIdx;
  st.modeIdx = newMode;

  uint32_t nowM = millis();

  if (st.modeIdx == MODE_HOME) {
    st.alarmState = DISARMED;
    st.alarmUntilMono = 0;
    st.manualUntilMono = 0;
    relayWrite(PIN_RELAY_SIREN, false);
    st.siren = false;
    st.sirenUntilMono = 0;
  }

  if (st.modeIdx == MODE_AWAY) {
    st.alarmState = EXIT_DELAY;
    st.alarmUntilMono = nowM + AWAY_EXIT_DELAY_MS;

    relayWrite(PIN_RELAY_LIGHT, false);
    relayWrite(PIN_RELAY_FAN, false);
    relayWrite(PIN_RELAY_SIREN, false);
    st.light = false;
    st.fan = false;
    st.siren = false;
    st.sirenUntilMono = 0;
  }

  if (st.modeIdx == MODE_MANUAL) {
    st.manualUntilMono = nowM + MANUAL_TIMEOUT_MS;
    st.alarmState = DISARMED;
    st.alarmUntilMono = 0;

    if (st.siren) st.sirenUntilMono = nowM + MANUAL_SIREN_MAX_MS;
  }

  publishEventMode(old, st.modeIdx, reason);
  publishState();
}

static void updateOccupancy(bool motion) {
  if (motion) {
    st.occupied = true;
    unoccSinceMs = 0;
    return;
  }

  if (st.occupied) {
    if (millis() - lastMotionMs > OCC_TIMEOUT_MS) {
      st.occupied = false;
      unoccSinceMs = millis();
      fanRunonUntil = millis() + FAN_RUNON_MS;
    }
  }
}

static void autoHomeLogic() {
  // Siren always OFF
  if (st.siren) {
    relayWrite(PIN_RELAY_SIREN, false);
    st.siren = false;
    st.sirenUntilMono = 0;
  }

  // Light
  if (st.occupied) {
    if (!st.light) {
      st.light = true;
      relayWrite(PIN_RELAY_LIGHT, true);
      publishState();
    }
  } else {
    if (unoccSinceMs && (millis() - unoccSinceMs >= LIGHT_OFF_DELAY_MS)) {
      if (st.light) {
        st.light = false;
        relayWrite(PIN_RELAY_LIGHT, false);
        publishState();
      }
      unoccSinceMs = 0;
    }
  }

  // Fan hysteresis + run-on
  bool wantFan = st.fan;

  if (st.occupied) {
    if (!isnan(lastT) && !isnan(lastH)) {
      if (lastT > T_on || lastH > H_on) wantFan = true;
      if (lastT < T_off && lastH < H_off) wantFan = false;
    }
  } else {
    if (fanRunonUntil && millis() < fanRunonUntil) wantFan = true;
    else wantFan = false;
  }

  if (wantFan != st.fan) {
    st.fan = wantFan;
    relayWrite(PIN_RELAY_FAN, st.fan);
    publishState();
  }
}

static void awayArmedLogic(bool motion) {
  uint32_t nowM = millis();

  if (st.alarmState == EXIT_DELAY) {
    if (st.alarmUntilMono && timeReached(nowM, st.alarmUntilMono)) {
      st.alarmState = ARMED_IDLE;
      st.alarmUntilMono = 0;
      publishEventAlarm("EXIT_DELAY", "ARMED_IDLE", "timeout");
      publishState();
    }
    return;
  }

  if (st.alarmState == ARMED_IDLE) {
    if (motion) {
      st.alarmState = ALARM_PENDING;
      st.alarmUntilMono = nowM + AWAY_PENDING_MS;
      publishEventAlarm("ARMED_IDLE", "ALARM_PENDING", "pir");
      publishState();
    }
    return;
  }

  if (st.alarmState == ALARM_PENDING) {
    if (st.alarmUntilMono && timeReached(nowM, st.alarmUntilMono)) {
      st.alarmState = ALARM_ON;
      st.alarmUntilMono = 0;
      st.siren = true;
      st.sirenUntilMono = nowM + AWAY_SIREN_MAX_MS;
      relayWrite(PIN_RELAY_SIREN, true);
      publishEventAlarm("ALARM_PENDING", "ALARM_ON", "timeout");
      publishState();
    }
    return;
  }

  if (st.alarmState == ALARM_ON) {
    // siren auto-off but alarm stays until disarm
    if (st.siren && st.sirenUntilMono && timeReached(nowM, st.sirenUntilMono)) {
      st.siren = false;
      st.sirenUntilMono = 0;
      relayWrite(PIN_RELAY_SIREN, false);
      publishState();
    }
    return;
  }
}

static void manualLogic() {
  uint32_t nowM = millis();

  if (st.manualUntilMono && timeReached(nowM, st.manualUntilMono)) {
    enterMode(MODE_HOME, "manual_timeout");
    return;
  }

  if (st.siren && st.sirenUntilMono && timeReached(nowM, st.sirenUntilMono)) {
    st.siren = false;
    st.sirenUntilMono = 0;
    relayWrite(PIN_RELAY_SIREN, false);
    publishState();
  }
}

// ===================== RFID POLL =====================
static void handleRfidDisarm() {
  relayWrite(PIN_RELAY_SIREN, false);
  st.siren = false;
  st.sirenUntilMono = 0;

  uint8_t oldMode = st.modeIdx;
  st.modeIdx = MODE_HOME;
  st.alarmState = DISARMED;
  st.alarmUntilMono = 0;
  st.manualUntilMono = 0;

  publishEventMode(oldMode, st.modeIdx, "rfid_disarm");
  publishState();
}

static void pollPN532() {
  static uint32_t lastPoll = 0;
  if (millis() - lastPoll < PN532_POLL_MS) return;
  lastPoll = millis();

  uint8_t uid[8];
  uint8_t uidLen = 0;
  bool ok = nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLen, 30);
  if (!ok || uidLen == 0) return;

  uint32_t now = millis();
  if (now - lastCardMs < RFID_DEBOUNCE_MS) return;
  lastCardMs = now;

  String uidKey = uidToHexKey(uid, uidLen);
  bool allow = isAllowedUid(uidKey);

  publishEventRfid(uidKey, allow ? "allow" : "deny");

  if (allow && st.modeIdx == MODE_AWAY && (st.alarmState == ALARM_PENDING || st.alarmState == ALARM_ON)) {
    handleRfidDisarm();
  }
}

// ===================== CMD HANDLER =====================
static String lastReqId;

static void updateAllowlistFromMqtt(const byte* payload, unsigned int length) {
  // payload: {ts,uids:[...]}
  DynamicJsonDocument doc(4096);
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.print("[ACL] JSON err: ");
    Serial.println(err.c_str());
    return;
  }

  g_allowUids.clear();
  g_allowUids.reserve(ALLOWLIST_MAX_UIDS);

  g_allowMsgTs = (uint64_t)(doc["ts"] | 0ULL);

  JsonArray arr = doc["uids"].as<JsonArray>();
  uint16_t cnt = 0;
  for (JsonVariant v : arr) {
    const char* s = v.as<const char*>();
    if (!s) continue;
    String uid = normalizeUidKey(String(s));
    if (!uid.length()) continue;
    g_allowUids.push_back(uid);
    cnt++;
    if (cnt >= ALLOWLIST_MAX_UIDS) break;
  }

  g_allowReady = true;
  Serial.printf("[ACL] updated %u uids (ts=%llu)\n", cnt, (unsigned long long)g_allowMsgTs);

  // publish state so UI can show aclCount/aclReady
  publishState();
}

static void onMqttMsg(char* topic, byte* payload, unsigned int length) {
  // LOG
  Serial.print("[RX] ");
  Serial.print(topic);
  Serial.print(" | ");
  Serial.write(payload, length);
  Serial.println();

  const String allowTopic = topicRfidAllow();
  if (strcmp(topic, allowTopic.c_str()) == 0) {
    updateAllowlistFromMqtt(payload, length);
    return;
  }

  const String cmdTopic = topicCmd();
  if (strcmp(topic, cmdTopic.c_str()) != 0) return;

  StaticJsonDocument<640> doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.print("[CMD] JSON err: ");
    Serial.println(err.c_str());
    return;
  }

  const char* reqId  = doc["reqId"]  | "";
  const char* source = doc["source"] | "";
  const char* type   = doc["type"]   | "";
  const char* target = doc["target"] | "";
  int value          = doc["value"]  | 0;
  uint64_t cmdTs     = normalizeTsMs((uint64_t)(doc["ts"] | 0ULL));

  if (strlen(reqId) && lastReqId == String(reqId)) return;
  if (strlen(reqId)) lastReqId = String(reqId);

  // store last cmd
  st.lastReqId = String(reqId);
  st.lastSource = String(source);
  st.lastTarget = String(target);
  st.lastValue = value;
  st.lastCmdTs = cmdTs;

  uint32_t nowM = millis();

  // Any user interaction extends manual timeout if in manual
  if (st.modeIdx == MODE_MANUAL) st.manualUntilMono = nowM + MANUAL_TIMEOUT_MS;

  if (strcmp(type, "set") != 0) return;

  // Mode change
  if (strcmp(target, "modeIdx") == 0) {
    enterMode((uint8_t)value, "cmd_mode");
    publishState();
    return;
  }

  const bool isRelayCmd =
    (strcmp(target, "light") == 0) ||
    (strcmp(target, "fan") == 0) ||
    (strcmp(target, "siren") == 0);

  if (!isRelayCmd) return;

  // Rule: HOME/AWAY + user toggles relay => switch MANUAL then apply
  if (st.modeIdx == MODE_HOME || st.modeIdx == MODE_AWAY) {
    enterMode(MODE_MANUAL, "web_relay");
  }

  bool on = (value != 0);

  if (strcmp(target, "light") == 0) {
    st.light = on;
    relayWrite(PIN_RELAY_LIGHT, on);
  } else if (strcmp(target, "fan") == 0) {
    st.fan = on;
    relayWrite(PIN_RELAY_FAN, on);
  } else if (strcmp(target, "siren") == 0) {
    st.siren = on;
    relayWrite(PIN_RELAY_SIREN, on);

    if (st.modeIdx == MODE_MANUAL && on) st.sirenUntilMono = nowM + MANUAL_SIREN_MAX_MS;
    if (!on) st.sirenUntilMono = 0;
  }

  if (st.modeIdx == MODE_MANUAL) st.manualUntilMono = nowM + MANUAL_TIMEOUT_MS;

  publishState();
}

// ===================== NETWORK =====================
static void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[WIFI] Connecting to %s", WIFI_SSID);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WIFI] OK IP=%s RSSI=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    Serial.println("[WIFI] FAILED (check SSID/PASS)");
  }
}

static void syncTime() {
  // UTC+7
  configTime(7 * 3600, 0, "pool.ntp.org", "time.nist.gov");
  Serial.print("[TIME] NTP sync");

  for (int i = 0; i < 40; i++) {
    time_t s = time(nullptr);
    if (s > 100000) {
      struct timeval tv;
      gettimeofday(&tv, NULL);
      g_epochBaseMs = (uint64_t)tv.tv_sec * 1000ULL + (uint64_t)tv.tv_usec / 1000ULL;
      g_uptimeBaseMs = millis();
      Serial.print(" OK epochMs=");
      Serial.println((unsigned long long)g_epochBaseMs);
      return;
    }
    delay(250);
    Serial.print(".");
  }

  Serial.println(" (no NTP) -> timestamps will be uptime-based");
  g_epochBaseMs = 0;
  g_uptimeBaseMs = millis();
}

static void connectMQTT() {
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMsg);

  // allowlist payload can be >1KB
  mqtt.setBufferSize(2048);

  // TLS (easy mode): skip CA validation (replace with CA cert later)
  net.setInsecure();

  while (!mqtt.connected()) {
    Serial.print("[MQTT] Connecting...");
    String clientId = String("esp32-") + String((uint32_t)ESP.getEfuseMac(), HEX);

    bool ok = mqtt.connect(
      clientId.c_str(),
      MQTT_USER,
      MQTT_PASS,
      topicStatus().c_str(),
      1,
      true,
      "offline"
    );

    if (ok) {
      Serial.println(" OK");

      bool subCmd = mqtt.subscribe(topicCmd().c_str(), 1);
      Serial.printf("[MQTT] subscribe %s => %s\n", topicCmd().c_str(), subCmd ? "OK" : "FAIL");

      bool subAcl = mqtt.subscribe(topicRfidAllow().c_str(), 1);
      Serial.printf("[MQTT] subscribe %s => %s\n", topicRfidAllow().c_str(), subAcl ? "OK" : "FAIL");

      publishStatus("online");
      publishState();
    } else {
      Serial.printf(" fail rc=%d\n", mqtt.state());
      delay(2000);
    }
  }
}

// ===================== SETUP/LOOP =====================
void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(PIN_PIR, INPUT);

  pinMode(PIN_RELAY_LIGHT, OUTPUT);
  pinMode(PIN_RELAY_FAN, OUTPUT);
  pinMode(PIN_RELAY_SIREN, OUTPUT);

  relayWrite(PIN_RELAY_LIGHT, false);
  relayWrite(PIN_RELAY_FAN, false);
  relayWrite(PIN_RELAY_SIREN, false);

  g_allowUids.reserve(ALLOWLIST_MAX_UIDS);

  connectWiFi();
  syncTime();

  initSht();
  initPN532();

  connectMQTT();

  Serial.println("[READY] MQTT control path active (room1)");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();

  if (!mqtt.connected()) connectMQTT();
  mqtt.loop();

  bool motion = readPir();
  readSht();
  pollPN532();

  updateOccupancy(motion);

  if (st.modeIdx == MODE_HOME) {
    autoHomeLogic();
  } else if (st.modeIdx == MODE_AWAY) {
    awayArmedLogic(motion);
  } else {
    manualLogic();
  }

  if (millis() - lastTeleMs >= TELE_PERIOD_MS) {
    lastTeleMs = millis();
    publishTele(motion);
  }
}
