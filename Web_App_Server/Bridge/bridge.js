/**
 * Bridge (room1): MQTT -> Firebase RTDB  (storage/history/log)
 *
 * MQTT = realtime control/data bus (ESP32 <-> Web/App)
 * Firebase = stores last state + latest tele + history + logs (for UI + analytics/ML export)
 *
 * Requirements:
 *   npm i mqtt firebase-admin
 * Put serviceAccountKey.json next to this file (same folder).
 *
 * Run:
 *   node bridge.js
 */

"use strict";

const mqtt = require("mqtt");
const admin = require("firebase-admin");
const path = require("path");

// ===================== CONFIG =====================
const ROOM = process.env.ROOM || "room1";

// Firebase allowlist path (RFID)
const ACL_PATH = process.env.ACL_PATH || "config/rfid/allow";
const ACL_TOPIC = `${ROOM}/rfid/allow`;

// HiveMQ Cloud (MQTTS)
const MQTT_HOST =
  process.env.MQTT_HOST ||
  "92864f9d9c26428b9eb175c5fd429f4f.s1.eu.hivemq.cloud";
const MQTT_PORT = Number(process.env.MQTT_PORT || 8883);
const MQTT_USER = process.env.MQTT_USER || "bridge";
const MQTT_PASS = process.env.MQTT_PASS || "Hung@2005";

// Firebase RTDB
const FIREBASE_DB_URL =
  process.env.FIREBASE_DB_URL ||
  "https://smartroom-562e0-default-rtdb.firebaseio.com";

// Timezone used to group daily history keys
const TZ = process.env.TZ_IANA || "Asia/Ho_Chi_Minh";

// ===================== FIREBASE INIT =====================
const saPath =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.join(__dirname, "serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(require(saPath)),
  databaseURL: FIREBASE_DB_URL,
});

const db = admin.database();

// ===================== HELPERS =====================
function nowMs() {
  return Date.now();
}

function normalizeTsMs(tsLike) {
  const n = Number(tsLike);
  if (!Number.isFinite(n) || n <= 0) return nowMs();
  // seconds -> ms
  if (n > 1e9 && n < 1e12) return Math.floor(n * 1000);
  // already ms
  return Math.floor(n);
}

function dayKeyFromTs(tsMs) {
  // YYYYMMDD in Asia/Ho_Chi_Minh (or configured TZ)
  const d = new Date(tsMs);
  const s = d.toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
  return s.replaceAll("-", "");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}


function normalizeUidKey(s) {
  return String(s || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

function truthy(v){
  return v === true || v === 1 || v === "1" || v === "true" || v === "TRUE";
}

// Accept allow record as:
// - true / 1 / "true"
// - {enabled:true} or {allow:true}
function extractAllowedUids(map) {
  const out = [];
  if (!map || typeof map !== "object") return out;

  for (const [k, v] of Object.entries(map)) {
    const uid = normalizeUidKey(k);
    if (!uid) continue;

    const ok =
      truthy(v) ||
      (v && typeof v === "object" && (truthy(v.enabled) || truthy(v.allow)));

    if (ok) out.push(uid);
  }

  out.sort();
  return out;
}
async function setPath(p, value) {
  await db.ref(p).set(value);
}

async function pushPath(p, value) {
  await db.ref(p).push(value);
}

async function appendRaw(kind, topic, data, tsMs) {
  const rec = {
    ts: tsMs,
    kind, // "cmd" | "event" | "status" | "state"
    topic,
    data: data ?? null,
  };
  await pushPath("log/raw", rec);
}

// Avoid spamming raw logs with retained state replays
let lastSeenStateReqId = "";

// ===================== WRITERS =====================
async function writeStatus(text) {
  const ts = nowMs();
  const status = String(text || "").trim();

  await setPath("device/status", {
    ts,
    online: status === "online",
    status,
    room: ROOM,
  });

  await appendRaw("status", `${ROOM}/status`, status, ts);
}

async function writeState(obj) {
  if (!obj || typeof obj !== "object") return;

  const ts = normalizeTsMs(obj.ts);
  const dayKey = dayKeyFromTs(ts);

  // last state (for UI)
  await setPath("device/state", obj);

  // state history
  await pushPath(`history/state/${dayKey}`, obj);

  // convenience latest copy
  await setPath("latest/state", obj);

  // Raw log only when a new command is reflected in state
  const reqId = obj?.lastCmd?.reqId ? String(obj.lastCmd.reqId) : "";
  if (reqId && reqId !== lastSeenStateReqId) {
    lastSeenStateReqId = reqId;
    await appendRaw(
      "state",
      `${ROOM}/state`,
      {
        ts,
        modeIdx: obj.modeIdx,
        occupied: obj.occupied,
        light: obj.light,
        fan: obj.fan,
        siren: obj.siren,
        alarmState: obj.alarmState,
        lastCmd: obj.lastCmd || null,
      },
      ts
    );
  }
}

async function writeTele(obj) {
  if (!obj || typeof obj !== "object") return;

  const ts = normalizeTsMs(obj.ts);
  const dayKey = dayKeyFromTs(ts);

  await setPath("latest/tele", { ...obj, ts });
  await pushPath(`history/tele/${dayKey}`, { ...obj, ts });
}

async function writeEvent(obj) {
  if (!obj || typeof obj !== "object") return;

  const ts = normalizeTsMs(obj.ts);
  const dayKey = dayKeyFromTs(ts);

  await pushPath(`log/event/${dayKey}`, { ...obj, ts });

  // keep latest rfid for UI table
  if (obj.type === "rfid") {
    await setPath("latest/rfid", { ...obj, ts });
  }

  await appendRaw("event", `${ROOM}/event`, { ...obj, ts }, ts);
}

async function writeCmd(obj) {
  if (!obj || typeof obj !== "object") return;

  const ts = normalizeTsMs(obj.ts);
  const dayKey = dayKeyFromTs(ts);

  await pushPath(`log/cmd/${dayKey}`, { ...obj, ts });
  await appendRaw("cmd", `${ROOM}/cmd`, { ...obj, ts }, ts);
}

// ===================== Firebase -> MQTT (RFID allowlist) =====================
let _aclTimer = null;
let _lastAclJson = "";
let _pendingAclJson = ""; // publish once MQTT connected

function publishAllowlistJson(json) {
  if (!json) return;

  if (!client || !client.connected) {
    _pendingAclJson = json;
    return;
  }

  client.publish(ACL_TOPIC, json, { qos: 1, retain: true }, (err) => {
    if (err) console.error("[Bridge] publish allowlist err", err);
    else console.log(`[Bridge] published ${ACL_TOPIC} retain`);
  });
}

function schedulePublishAllowlist(uids) {
  const payload = { ts: nowMs(), uids: Array.isArray(uids) ? uids : [] };
  const json = JSON.stringify(payload);

  // avoid re-publish same content
  if (json === _lastAclJson) return;
  _lastAclJson = json;

  if (_aclTimer) clearTimeout(_aclTimer);
  _aclTimer = setTimeout(() => publishAllowlistJson(json), 250);
}

db.ref(ACL_PATH).on(
  "value",
  (snap) => {
    const map = snap.val() || {};
    const uids = extractAllowedUids(map);
    console.log(`[Bridge] ACL update from Firebase: ${uids.length} uids`);
    schedulePublishAllowlist(uids);
  },
  (err) => {
    console.error("[Bridge] ACL listener error:", err?.message || err);
  }
);

console.log(`[Bridge] ACL sync: ${ACL_PATH} -> ${ACL_TOPIC} (retain)`);

let client = null;

// ===================== MQTT CONNECT =====================
const mqttUrl = `mqtts://${MQTT_HOST}:${MQTT_PORT}`;

client = mqtt.connect(mqttUrl, {
  username: MQTT_USER,
  password: MQTT_PASS,
  clientId: `bridge-${ROOM}-` + Math.random().toString(16).slice(2),
  keepalive: 30,
  reconnectPeriod: 2000,
  clean: true,
});

client.on("connect", () => {
  console.log("[Bridge] MQTT connected:", mqttUrl);
  client.subscribe(`${ROOM}/#`, { qos: 0 }, (err) => {
    if (err) console.error("[Bridge] subscribe err", err);
    else console.log("[Bridge] subscribed:", `${ROOM}/#`);
  });

  // publish pending retained allowlist right after connect
  if (_pendingAclJson) {
    const tmp = _pendingAclJson;
    _pendingAclJson = "";
    publishAllowlistJson(tmp);
  }
});

client.on("reconnect", () => console.log("[Bridge] MQTT reconnecting..."));
client.on("close", () => console.log("[Bridge] MQTT closed"));
client.on("error", (e) => console.error("[Bridge] MQTT error", e?.message || e));

client.on("message", async (topic, payload) => {

  // Ignore the ACL topic (Bridge publishes it; no need to mirror to Firebase)
  if (topic === ACL_TOPIC) return;
  const text = payload.toString("utf8");

  try {
    if (topic === `${ROOM}/tele`) {
      const obj = safeJsonParse(text);
      if (obj) await writeTele(obj);
      return;
    }

    if (topic === `${ROOM}/state`) {
      const obj = safeJsonParse(text);
      if (obj) await writeState(obj);
      return;
    }

    if (topic === `${ROOM}/event`) {
      const obj = safeJsonParse(text);
      if (obj) await writeEvent(obj);
      return;
    }

    if (topic === `${ROOM}/cmd`) {
      const obj = safeJsonParse(text);
      if (obj) await writeCmd(obj);
      return;
    }

    if (topic === `${ROOM}/status`) {
      await writeStatus(text);
      return;
    }
  } catch (e) {
    console.error("[Bridge] write failed", topic, e?.message || e);
  }
});

console.log(
  `[Bridge] running (MQTT -> Firebase + ACL sync) ROOM=${ROOM} DB=${FIREBASE_DB_URL}`
);
