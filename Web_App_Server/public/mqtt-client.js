// mqtt-client.js
(function () {
  const HOST = "92864f9d9c26428b9eb175c5fd429f4f.s1.eu.hivemq.cloud";
  const USER = "ESP32";
  const PASS = "Hung@2005";

  const url = `wss://${HOST}:8884/mqtt`;

  const state = { light:false, fan:false, siren:false, modeIdx:0, ts:0 };
  const MODES = ["HOME", "AWAY", "NIGHT"];

  // For UI status pill (common.js expects {online:true/false})
  let online = false;

  const client = mqtt.connect(url, {
    username: USER,
    password: PASS,
    clientId: "web-" + Math.random().toString(16).slice(2),
    keepalive: 30,
    reconnectPeriod: 2000,
    clean: true,
  });

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  client.on("connect", () => {
    console.log("[MQTT] connected");
    client.subscribe(["room1/state", "room1/status", "room1/tele", "room1/event"], { qos: 0 });
    online = true;
    emit("iot:status", { ok: true, online: true, label: "connected" });
  });

  client.on("reconnect", () => { online = false; emit("iot:status", { ok: false, online: false, label: "reconnecting" }); });
  client.on("offline",   () => { online = false; emit("iot:status", { ok: false, online: false, label: "offline" }); });
  client.on("close",     () => { online = false; emit("iot:status", { ok: false, online: false, label: "closed" }); });
  client.on("error", (e) => { online = false; emit("iot:status", { ok: false, online: false, label: e?.message || "error" }); });

  client.on("message", (topic, payload) => {
    const text = payload.toString();

    if (topic === "room1/state") {
      try {
        const st = JSON.parse(text);

        // merge vào state hiện tại
        Object.assign(state, st);

        // fallback ts nếu device không gửi
        if (!("ts" in st)) state.ts = Date.now();

        emit("iot:state", {
          ...state,
          mode: MODES[(Number(state.modeIdx) || 0) % MODES.length]
        });
      } catch (e) {
        console.warn("[MQTT] bad state json:", text);
      }
      return;
    }

    if (topic === "room1/status") {
      emit("iot:device", { status: text });
      return;
    }

    emit("iot:msg", { topic, text });
  });

  function reqId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + "-" + Math.random().toString(16).slice(2);
  }

  function publishCmd(payloadObj) {
    const msg = { reqId: reqId(), source: "web", ts: Date.now(), ...payloadObj };
    client.publish("room1/cmd", JSON.stringify(msg), { qos: 1 });
    return msg.reqId;
  }

  window.IOT = { client, state, MODES, publishCmd, get online(){ return online; } };
})();
