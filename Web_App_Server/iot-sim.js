(function(){
  // Realtime sensor stream from Firebase RTDB.
  // UI pages use the Sim API: Sim.latest / Sim.start() / Sim.stop() / Sim.subscribe().
  //
  // Why this file exists:
  // - Your ESP32 often writes sensors to separate nodes (e.g. /latest/pir, /latest/sht, /latest/rfid)
  //   while some UIs read a combined object (e.g. /latest).
  // - Firebase rules sometimes allow reading child paths but not the parent.
  //
  // This implementation listens to the sensor child paths by default and merges them into Sim.latest.
  // It also keeps a small Sim.meta object so the UI can show stable Online/Offline/Device-offline states.

  const qsBase = (()=>{
    try{
      const sp = new URLSearchParams(location.search);
      return sp.get("path") || localStorage.getItem("iot_latest_path") || "latest";
    }catch{ return "latest"; }
  })();

  // Allow overriding base path without changing code:
  //   localStorage.setItem('iot_latest_path','device/latest'); location.reload();
  const BASE = String(qsBase || "latest").replace(/^\/+/,"").replace(/\/+$/,"");

  const latest = {
    pir:  { motion: 0, occupancy: false, ts: 0 },
    rfid: { uid: "----", result: "none", ts: 0 },
    sht:  { t: 0.0, h: 0.0, ts: 0 },
  };

  const meta = {
    base: BASE,
    hasData: false,          // true once we received at least 1 non-null snapshot
    lastRecvAt: 0,           // Date.now() when we last received data
    lastErr: "",             // last RTDB listener error message (if any)
    sources: { pir:false, rfid:false, sht:false, root:false },
  };

  let unsubs = [];
  const listeners = new Set();

  // UI tick: even if Firebase has no new data, pages still want to refresh
  // timestamps / online indicators / charts every N ms.
  let tickTimer = null;
  let tickMs = 0;

  const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
  async function getFB(){
    if(window.FBReady) return await window.FBReady;
    for(let i=0;i<80;i++){
      if(window.FB?.db) return window.FB;
      await sleep(50);
    }
    throw new Error("Firebase not loaded");
  }

  async function ensureAuth(){
    const FB = await getFB();
    // firebase-init.js already tries: existing session -> anonymous -> email/pass.
    // Here we just wait a little in case module is still initializing.
    for(let i=0;i<40;i++){
      if(FB?.auth) break;
      await sleep(50);
    }
    return FB;
  }

  function cloneObj(o){
    try{
      if(typeof structuredClone === "function") return structuredClone(o);
    }catch{}
    // Fallback for older browsers
    return JSON.parse(JSON.stringify(o));
  }

  function emit(){
    const snap = { latest: cloneObj(latest), meta: { ...meta }, now: Date.now() };
    listeners.forEach(fn=>{ try{ fn(snap); }catch{} });
  }

  // Normalize timestamps coming from different producers:
  // - epoch milliseconds (13 digits)
  // - epoch seconds (10 digits)
  // - 0 / invalid when NTP not ready
  function normTs(x){
    const n = Number(x);
    if(!Number.isFinite(n) || n <= 0) return 0;
    // Likely seconds epoch
    if(n > 1e9 && n < 1e11) return n * 1000;
    // Too small -> likely uptime ms; ignore
    if(n < 1e12) return 0;
    return n;
  }

  function markRecv(which){
    meta.hasData = true;
    meta.lastRecvAt = Date.now();
    meta.lastErr = "";
    if(which && meta.sources.hasOwnProperty(which)) meta.sources[which] = true;
  }

  function onErr(err){
    const msg = String(err?.message || err || "");
    meta.lastErr = msg;
    console.warn("[Sim] RTDB listener error", err);

    const low = msg.toLowerCase();
    if(low.includes("permission") || low.includes("denied")){
      window.toast?.("bad", "Firebase", "Không đọc được realtime (permission denied). Hãy bật Anonymous Auth hoặc mở Rules cho các path /latest/*.");
    }else{
      window.toast?.("warn", "Firebase", "Realtime bị lỗi/kết nối chập chờn. Đang chờ tự hồi phục...");
    }
    emit();
  }

  function mergePir(v){
    if(!v || typeof v !== "object") return;
    const m = (v.motion ?? v.movement ?? v.value);
    latest.pir.motion = Number(m) ? 1 : 0;
    // ESP32 firmware uses "occupied". Keep backward compatible with older keys.
    latest.pir.occupancy = !!(v.occupied ?? v.occupancy ?? v.occ);
    latest.pir.ts = normTs(v.ts ?? v.time ?? v.updatedAt) || latest.pir.ts;
  }
  function mergeRfid(v){
    if(!v || typeof v !== "object") return;
    latest.rfid.uid = String(v.uid ?? v.id ?? v.tag ?? latest.rfid.uid);
    // Normalize allow/deny schema:
    // - new: { allowed:true/false }
    // - old: { result:"allow"/"deny" }
    const allowed = (typeof v.allowed === "boolean") ? v.allowed : null;
    const r = String(v.result ?? v.status ?? "").toLowerCase();
    if(r === "allow" || r === "deny") latest.rfid.result = r;
    else if(allowed === true) latest.rfid.result = "allow";
    else if(allowed === false) latest.rfid.result = "deny";
    else if(v.uid) latest.rfid.result = latest.rfid.result || "none";
    latest.rfid.ts = normTs(v.ts ?? v.time ?? v.updatedAt) || latest.rfid.ts;
  }
  function mergeSht(v){
    if(!v || typeof v !== "object") return;
    const t = Number(v.t ?? v.temp ?? v.temperature ?? v.tC);
    const h = Number(v.h ?? v.hum ?? v.humidity ?? v.rh);
    if(Number.isFinite(t)) latest.sht.t = t;
    if(Number.isFinite(h)) latest.sht.h = h;
    latest.sht.ts = normTs(v.ts ?? v.time ?? v.updatedAt) || latest.sht.ts;
  }

  function mergeRoot(obj){
    if(!obj || typeof obj !== "object") return;
    // Supports root objects like {pir:{...}, rfid:{...}, sht:{...}}
    if(obj.pir) mergePir(obj.pir);
    if(obj.rfid) mergeRfid(obj.rfid);
    if(obj.sht) mergeSht(obj.sht);
    // Common alternate key names
    if(obj.sht31) mergeSht(obj.sht31);
    if(obj.sht3x) mergeSht(obj.sht3x);
  }

  async function start(pollMs=2000){
    if(unsubs.length) return;
    // Start UI tick first so pages show something even if Firebase is slow.
    tickMs = Number(pollMs) || 2000;
    if(tickMs < 250) tickMs = 250;
    if(!tickTimer){
      tickTimer = setInterval(()=> emit(), tickMs);
    }
    let FB;
    try{
      FB = await ensureAuth();
    }catch(e){
      console.warn("[Sim] Firebase not available", e);
      emit();
      return;
    }

    console.log(`[Sim] Base path: /${BASE}`);

    // 1) Listen to full /latest object (if rules allow)
    try{
      const rootRef = FB.ref(FB.db, BASE);
      const off = FB.onValue(rootRef, (snap)=>{
        const v = snap.val();
        if(v){
          mergeRoot(v);
          markRecv("root");
        }
        emit();
      }, onErr);
      if(typeof off === "function") unsubs.push(off);
    }catch(e){
      console.warn("[Sim] attach root listener failed", e);
    }

    // 2) Always listen to child nodes (more compatible with strict rules)
    const childPairs = [
      ["pir",  `${BASE}/pir`,  mergePir],
      ["rfid", `${BASE}/rfid`, mergeRfid],
      ["sht",  `${BASE}/sht`,  mergeSht],
      // Alternate SHT keys seen in some firmwares
      ["sht",  `${BASE}/sht31`, mergeSht],
      ["sht",  `${BASE}/sht3x`, mergeSht],
    ];

    for(const [tag, path, fn] of childPairs){
      try{
        const r = FB.ref(FB.db, path);
        const off = FB.onValue(r, (snap)=>{
          const v = snap.val();
          if(v){
            fn(v);
            markRecv(tag);
          }
          emit();
        }, onErr);
        if(typeof off === "function") unsubs.push(off);
      }catch(e){
        console.warn("[Sim] attach child listener failed", path, e);
      }
    }

    // Emit initial snapshot so UI renders placeholders immediately.
    emit();
  }

  function stop(){
    for(const off of unsubs){
      try{ off(); }catch{}
    }
    unsubs = [];

    if(tickTimer){
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function subscribe(fn){
    listeners.add(fn);
    try{ fn({ latest: cloneObj(latest), meta: { ...meta }, now: Date.now() }); }catch{}
    return ()=> listeners.delete(fn);
  }

  window.Sim = { latest, meta, start, stop, subscribe };
})();
