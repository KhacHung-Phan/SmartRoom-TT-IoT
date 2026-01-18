/* dashboard.js — MQTT realtime dashboard (room1)
 *
 * Consolidated patch:
 * - Charts keep state when navigating between pages (Dashboard/Sensors)
 * - Optional backfill from Firebase history on first load / reload
 */

(function(){
  const $ = (id)=> document.getElementById(id);

  // Page guard
  if(!$("chartPir") || !$("statusTable")) return;

  const MAX = 24;
  const SERIES_KEY = "room1_charts_v1"; // shared with sensors.js via SeriesStore

  const toEpochMs = (typeof window.toEpochMs === "function")
    ? window.toEpochMs
    : (ts)=>{
        let n = Number(ts);
        if(!Number.isFinite(n) || n <= 0) return Date.now();
        if(n > 1e9 && n < 1e12) n *= 1000;
        n = Math.floor(n);
        const now = Date.now();
        if(n < 1600000000000 || n > now + 24*3600*1000) return now;
        return n;
      };

  function fmtClock(ts){
    try{
      if(typeof window.fmtTime === "function") return window.fmtTime(new Date(ts));
    }catch{}
    return new Date(ts).toLocaleTimeString("vi-VN", { hour12:false });
  }

  function fmtLabel(ts){
    // compact labels for chart points
    return fmtClock(ts);
  }

  function emptyStore(){
    return {
      v: 1,
      updatedAt: 0,
      occupied: false,
      pir: { ts: [], v: [] },
      rfid: { ts: [], v: [], uid: "", result: "" },
      sht: { ts: [], t: [], h: [] },
    };
  }

  function isArr(a){ return Array.isArray(a); }

  function sanitizeStore(s){
    if(!s || typeof s !== "object") return null;
    if(!s.pir || !s.rfid || !s.sht) return null;
    if(!isArr(s.pir.ts) || !isArr(s.pir.v)) return null;
    if(!isArr(s.rfid.ts) || !isArr(s.rfid.v)) return null;
    if(!isArr(s.sht.ts) || !isArr(s.sht.t) || !isArr(s.sht.h)) return null;
    return s;
  }

  let store = sanitizeStore(window.SeriesStore?.load?.(SERIES_KEY, null)) || emptyStore();

  // If too old, clear the time-series (still keep UID/result as a convenience).
  if(store.updatedAt && (Date.now() - Number(store.updatedAt) > 12 * 3600 * 1000)){
    const uid = store.rfid.uid || "";
    const result = store.rfid.result || "";
    store = emptyStore();
    store.rfid.uid = uid;
    store.rfid.result = result;
  }

  // ---------- Latest snapshot ----------
  const latest = {
    pir: {
      motion: (store.pir.v.length ? Number(store.pir.v[store.pir.v.length-1]) : 0) || 0,
      occupancy: !!store.occupied,
      ts: (store.pir.ts.length ? Number(store.pir.ts[store.pir.ts.length-1]) : Date.now())
    },
    rfid: {
      uid: String(store.rfid.uid || ""),
      result: String(store.rfid.result || ""),
      ts: (store.rfid.ts.length ? Number(store.rfid.ts[store.rfid.ts.length-1]) : Date.now())
    },
    sht: {
      t: (store.sht.t.length ? Number(store.sht.t[store.sht.t.length-1]) : 27.5),
      h: (store.sht.h.length ? Number(store.sht.h[store.sht.h.length-1]) : 60.0),
      ts: (store.sht.ts.length ? Number(store.sht.ts[store.sht.ts.length-1]) : Date.now())
    }
  };

  // ---------- Charts ----------
  const baseOpts = {
    responsive:true,
    maintainAspectRatio:false,
    plugins:{ legend:{ labels:{ color:"rgba(255,255,255,.75)" } } },
    scales:{
      x:{ ticks:{ color:"rgba(255,255,255,.55)" }, grid:{ color:"rgba(255,255,255,.08)" } },
      y:{ ticks:{ color:"rgba(255,255,255,.55)" }, grid:{ color:"rgba(255,255,255,.08)" } }
    }
  };

  const chartPir = new Chart($("chartPir"), {
    type:"line",
    data:{
      labels: store.pir.ts.map(fmtLabel),
      datasets:[{ label:"Motion", data: store.pir.v, borderWidth:2, tension:.35, pointRadius:0 }]
    },
    options:{
      ...baseOpts,
      scales:{
        ...baseOpts.scales,
        y:{ ...baseOpts.scales.y, suggestedMin:0, suggestedMax:1, ticks:{...baseOpts.scales.y.ticks, stepSize:1} }
      }
    }
  });

  const chartRfid = new Chart($("chartRfid"), {
    type:"bar",
    data:{
      labels: store.rfid.ts.map(fmtLabel),
      datasets:[{ label:"Swipe", data: store.rfid.v, borderWidth:1 }]
    },
    options:{ ...baseOpts, scales:{ ...baseOpts.scales, y:{ ...baseOpts.scales.y, suggestedMin:0, suggestedMax:6 } } }
  });

  const chartSht = new Chart($("chartSht"), {
    type:"line",
    data:{
      labels: store.sht.ts.map(fmtLabel),
      datasets:[
        { label:"Temp (°C)", data: store.sht.t, borderWidth:2, tension:.35, pointRadius:0 },
        { label:"Hum (%)", data: store.sht.h, borderWidth:2, tension:.35, pointRadius:0 },
      ]
    },
    options:{ ...baseOpts, scales:{ ...baseOpts.scales, y:{ ...baseOpts.scales.y, suggestedMin:0, suggestedMax:100 } } }
  });

  // ---------- Series helpers ----------
  function trim2(tsArr, vArr){
    while(tsArr.length > MAX){ tsArr.shift(); vArr.shift(); }
  }
  function trim3(tsArr, aArr, bArr){
    while(tsArr.length > MAX){ tsArr.shift(); aArr.shift(); bArr.shift(); }
  }

  function upsert1(series, ts, val){
    const A = series.ts;
    const B = series.v;
    if(!Number.isFinite(ts)) return false;

    const lastTs = A.length ? Number(A[A.length-1]) : 0;
    if(A.length && ts === lastTs){
      B[B.length-1] = val;
      return true;
    }
    if(!A.length || ts > lastTs){
      A.push(ts);
      B.push(val);
      trim2(A,B);
      return true;
    }
    return false;
  }

  function upsertSht(ts, tVal, hVal){
    const A = store.sht.ts;
    const T = store.sht.t;
    const H = store.sht.h;

    const lastTs = A.length ? Number(A[A.length-1]) : 0;

    if(A.length && ts === lastTs){
      if(Number.isFinite(tVal)) T[T.length-1] = tVal;
      if(Number.isFinite(hVal)) H[H.length-1] = hVal;
      return true;
    }
    if(!A.length || ts > lastTs){
      const prevT = T.length ? Number(T[T.length-1]) : 27.5;
      const prevH = H.length ? Number(H[H.length-1]) : 60.0;
      A.push(ts);
      T.push(Number.isFinite(tVal) ? tVal : prevT);
      H.push(Number.isFinite(hVal) ? hVal : prevH);
      trim3(A,T,H);
      return true;
    }
    return false;
  }

  function refreshChartLabels(chart, tsArr){
    chart.data.labels = tsArr.map(fmtLabel);
  }

  // ---------- Persist (debounced) ----------
  let _saveTimer = null;
  function scheduleSave(){
    if(_saveTimer) return;
    _saveTimer = setTimeout(()=>{
      _saveTimer = null;
      store.updatedAt = Date.now();
      try{ window.SeriesStore?.save?.(SERIES_KEY, store); }catch{}
    }, 400);
  }

  // ---------- UI render ----------
  function setBadge(selector, on){
    const elb = document.querySelector(selector);
    if(!elb) return;
    elb.textContent = on ? "ON" : "OFF";
    elb.classList.toggle("on", !!on);
    elb.classList.toggle("off", !on);
  }

  function updateLastUpdate(){
    const ts = Math.max(Number(latest.pir.ts||0), Number(latest.rfid.ts||0), Number(latest.sht.ts||0), 0);
    const el = $("lastUpdate");
    if(el) el.textContent = fmtClock(ts || Date.now());
  }

  const qualityFor = (sensor)=>{
    if(sensor === "SHT31"){
      if(latest.sht.t>=35 || latest.sht.h>=85) return {cls:"bad", text:"Nguy hiểm"};
      if(latest.sht.t>=30 || latest.sht.h>=75) return {cls:"warn", text:"Cảnh báo"};
      return {cls:"good", text:"OK"};
    }
    if(sensor === "PIR") return latest.pir.motion ? {cls:"warn", text:"Có chuyển động"} : {cls:"good", text:"Bình thường"};
    if(sensor === "RFID"){
      if(latest.rfid.result === "deny") return {cls:"bad", text:"Từ chối"};
      if(latest.rfid.result === "allow") return {cls:"good", text:"Cho phép"};
      return {cls:"good", text:"Chờ"};
    }
    return {cls:"good", text:"OK"};
  };

  let _query = "";
  window.pageSearchHandler = (v)=>{
    _query = String(v||"").trim().toLowerCase();
    renderTable();
  };

  function renderTable(){
    const rows = [
      {
        name:"PIR (HC-SR501)",
        key:"PIR",
        value:`${latest.pir.motion?"Motion:1":"Motion:0"} • Occupancy: ${latest.pir.occupancy?"Có người":"Không người"}`,
        ts: latest.pir.ts
      },
      {
        name:"RFID (PN532)",
        key:"RFID",
        value:`UID: ${latest.rfid.uid || "-"} • Result: ${String(latest.rfid.result || "chờ").toUpperCase()}`,
        ts: latest.rfid.ts
      },
      {
        name:"SHT31 (I2C)",
        key:"SHT31",
        value:`T: ${Number(latest.sht.t).toFixed(1)} °C • H: ${Number(latest.sht.h).toFixed(1)} %`,
        ts: latest.sht.ts
      }
    ];

    const filtered = !_query ? rows : rows.filter(r => (r.name + " " + r.key + " " + r.value).toLowerCase().includes(_query));
    const tbody = $("statusTable");
    if(!tbody) return;

    tbody.innerHTML = (filtered.map(r=>{
      const st = qualityFor(r.key);
      const icon = st.cls === "good" ? "fa-circle-check" : st.cls === "warn" ? "fa-triangle-exclamation" : "fa-circle-xmark";
      return `
        <tr>
          <td><strong>${r.name}</strong></td>
          <td>${r.value}</td>
          <td><span class="chip ${st.cls}"><i class="fa-solid ${icon}"></i> ${st.text}</span></td>
          <td>${fmtClock(Number(r.ts||Date.now()))}</td>
        </tr>
      `;
    }).join("")) || `<tr><td colspan="4" style="color:var(--muted);padding:18px">Không có kết quả.</td></tr>`;
  }

  // ---------- MQTT handlers ----------
  window.addEventListener("iot:state", (e)=>{
    const st = e.detail || {};

    if(typeof st.occupied !== "undefined"){
      latest.pir.occupancy = !!st.occupied;
      store.occupied = !!st.occupied;
      scheduleSave();
    }

    // mode
    const mode = st.mode || (window.IOT?.MODES ? window.IOT.MODES[(Number(st.modeIdx)||0)%window.IOT.MODES.length] : undefined);
    if(mode){
      const mt = $("modeText"); if(mt) mt.textContent = mode;
      const mp = $("modePill"); if(mp) mp.textContent = mode;
    }

    // relays
    setBadge("#badgeLight", !!st.light);
    setBadge("#badgeFan",   !!st.fan);
    setBadge("#badgeSiren", !!st.siren);

    renderTable();
  });

  window.addEventListener("iot:msg", (e)=>{
    const { topic, text } = e.detail || {};
    if(!topic) return;

    if(topic === "room1/tele"){
      let tele; try{ tele = JSON.parse(text); }catch{ return; }
      const ts = toEpochMs(tele.ts);

      let changedPir = false;
      let changedSht = false;

      if(typeof tele.motion !== "undefined"){
        latest.pir.motion = tele.motion ? 1 : 0;
        latest.pir.ts = ts;
        changedPir = upsert1(store.pir, ts, latest.pir.motion);
        if(changedPir){
          refreshChartLabels(chartPir, store.pir.ts);
          chartPir.update("none");
        }
      }

      const tVal = (typeof tele.t !== "undefined") ? Number(tele.t) : NaN;
      const hVal = (typeof tele.h !== "undefined") ? Number(tele.h) : NaN;

      if(typeof tele.t !== "undefined" || typeof tele.h !== "undefined"){
        if(Number.isFinite(tVal)) latest.sht.t = tVal;
        if(Number.isFinite(hVal)) latest.sht.h = hVal;
        latest.sht.ts = ts;

        changedSht = upsertSht(ts, tVal, hVal);
        if(changedSht){
          refreshChartLabels(chartSht, store.sht.ts);
          chartSht.update("none");
        }
      }

      if(changedPir || changedSht){
        scheduleSave();
      }

      updateLastUpdate();
      renderTable();
      return;
    }

    if(topic.startsWith("room1/event")){
      let ev; try{ ev = JSON.parse(text); }catch{ return; }
      const ts = toEpochMs(ev.ts);

      if(ev.type === "rfid"){
        latest.rfid.uid = ev.uid || "";
        latest.rfid.result = ev.result || "";
        latest.rfid.ts = ts;

        store.rfid.uid = latest.rfid.uid;
        store.rfid.result = latest.rfid.result;

        const v = (latest.rfid.result === "allow") ? 2 : (latest.rfid.result === "deny") ? 1 : 0;
        const changed = upsert1(store.rfid, ts, v);
        if(changed){
          refreshChartLabels(chartRfid, store.rfid.ts);
          chartRfid.update("none");
        }

        scheduleSave();
        updateLastUpdate();
        renderTable();
      }
    }
  });

  // ---------- Controls (MQTT cmd) ----------
  function publishSet(target, value){
    if(window.IOT?.publishCmd){
      return window.IOT.publishCmd({ type:"set", target, value });
    }
    console.warn("[DASH] publishCmd not ready");
    return null;
  }

  function toggleRelay(target){
    const st = window.IOT?.state || {};
    const on = !Boolean(st[target]);
    publishSet(target, on ? 1 : 0);

    // optimistic UI (will be corrected by retained state)
    setBadge(target === "light" ? "#badgeLight" : target === "fan" ? "#badgeFan" : "#badgeSiren", on);
  }

  function cycleMode(){
    const st = window.IOT?.state || {};
    const curr = Number(st.modeIdx)||0;
    const next = (curr + 1) % 3;
    publishSet("modeIdx", next);
  }

  // ---------- Firebase backfill ----------
  function dayKeyNow(){
    const s = new Date().toLocaleDateString("en-CA", { timeZone:"Asia/Ho_Chi_Minh" });
    return s.replaceAll("-", "");
  }

  async function backfillFromFirebase(){
    // Only backfill if series is empty-ish
    if(store.pir.ts.length >= 6 && store.sht.ts.length >= 6) return;

    const FB = await (window.FBReady ? window.FBReady : Promise.resolve(window.FB));
    if(!FB?.db) return;

    const dayKey = dayKeyNow();

    try{
      // Telemetry history
      const teleRef = FB.ref(FB.db, `history/tele/${dayKey}`);
      const teleQ = FB.query(teleRef, FB.orderByKey(), FB.limitToLast(MAX));
      const teleSnap = await FB.get(teleQ);

      if(teleSnap.exists()){
        const teleArr = [];
        teleSnap.forEach(c=>{ const v = c.val(); if(v) teleArr.push(v); });

        for(const rec of teleArr){
          const ts = toEpochMs(rec.ts);

          if(typeof rec.motion !== "undefined"){
            const mv = rec.motion ? 1 : 0;
            upsert1(store.pir, ts, mv);
            latest.pir.motion = mv;
            latest.pir.ts = ts;
          }

          const tVal = (typeof rec.t !== "undefined") ? Number(rec.t) : NaN;
          const hVal = (typeof rec.h !== "undefined") ? Number(rec.h) : NaN;
          if(typeof rec.t !== "undefined" || typeof rec.h !== "undefined"){
            upsertSht(ts, tVal, hVal);
            if(Number.isFinite(tVal)) latest.sht.t = tVal;
            if(Number.isFinite(hVal)) latest.sht.h = hVal;
            latest.sht.ts = ts;
          }
        }
      }

      // RFID events
      const evRef = FB.ref(FB.db, `log/event/${dayKey}`);
      const evQ = FB.query(evRef, FB.orderByKey(), FB.limitToLast(120));
      const evSnap = await FB.get(evQ);
      if(evSnap.exists()){
        const rfidArr = [];
        evSnap.forEach(c=>{
          const v = c.val();
          if(v && v.type === "rfid") rfidArr.push(v);
        });

        for(const ev of rfidArr.slice(-MAX)){
          const ts = toEpochMs(ev.ts);
          const result = ev.result || "";
          const v = (result === "allow") ? 2 : (result === "deny") ? 1 : 0;
          upsert1(store.rfid, ts, v);
          latest.rfid.uid = ev.uid || latest.rfid.uid;
          latest.rfid.result = result;
          latest.rfid.ts = ts;
        }

        store.rfid.uid = latest.rfid.uid;
        store.rfid.result = latest.rfid.result;
      }

      // Refresh charts
      refreshChartLabels(chartPir, store.pir.ts);
      refreshChartLabels(chartRfid, store.rfid.ts);
      refreshChartLabels(chartSht, store.sht.ts);
      chartPir.update("none");
      chartRfid.update("none");
      chartSht.update("none");

      scheduleSave();
      updateLastUpdate();
      renderTable();
    }catch(e){
      console.warn("[DASH] Firebase backfill failed", e?.message || e);
    }
  }

  // ---------- Boot ----------
  document.addEventListener("DOMContentLoaded", ()=>{
    // Wire buttons once
    $("btnLight")?.addEventListener("click", ()=> toggleRelay("light"));
    $("btnFan")?.addEventListener("click",   ()=> toggleRelay("fan"));
    $("btnSiren")?.addEventListener("click", ()=> toggleRelay("siren"));
    $("btnMode")?.addEventListener("click",  ()=> cycleMode());

    // Initial render from retained state (if already present)
    const st = window.IOT?.state;
    if(st){
      setBadge("#badgeLight", !!st.light);
      setBadge("#badgeFan",   !!st.fan);
      setBadge("#badgeSiren", !!st.siren);
      if(typeof st.occupied !== "undefined"){
        latest.pir.occupancy = !!st.occupied;
        store.occupied = !!st.occupied;
      }
      const mode = st.mode || (window.IOT?.MODES ? window.IOT.MODES[(Number(st.modeIdx)||0)%window.IOT.MODES.length] : "HOME");
      const mt = $("modeText"); if(mt) mt.textContent = mode;
      const mp = $("modePill"); if(mp) mp.textContent = mode;
    }

    updateLastUpdate();
    renderTable();

    // Backfill only when needed
    backfillFromFirebase();
  });

})();
