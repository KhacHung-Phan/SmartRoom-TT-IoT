/* sensors.js — Sensors page (room1)
 *
 * Consolidated patch:
 * - Charts keep state when navigating between pages (Dashboard/Sensors) via localStorage
 * - Optional backfill from Firebase history on first load / reload
 */

(function(){
  const el = (id)=> document.getElementById(id);

  // Page guard
  if(!el("sChartPir")) return;

  const MAX = 24;
  const SERIES_KEY = "room1_charts_v1"; // shared with dashboard.js via SeriesStore

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

  function fmtLabel(ts){ return fmtClock(ts); }

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

  const chartPir = new Chart(el("sChartPir"), {
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

  const chartRfid = new Chart(el("sChartRfid"), {
    type:"bar",
    data:{
      labels: store.rfid.ts.map(fmtLabel),
      datasets:[{ label:"Swipe", data: store.rfid.v, borderWidth:1 }]
    },
    options:{ ...baseOpts, scales:{ ...baseOpts.scales, y:{ ...baseOpts.scales.y, suggestedMin:0, suggestedMax:6 } } }
  });

  const chartSht = new Chart(el("sChartSht"), {
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

  function trim2(a,b){ while(a.length > MAX){ a.shift(); b.shift(); } }
  function trim3(a,b,c){ while(a.length > MAX){ a.shift(); b.shift(); c.shift(); } }

  function upsert1(series, ts, val){
    ts = Number(ts);
    if(!Number.isFinite(ts) || ts <= 0) return false;

    const A = series.ts;
    const B = series.v;
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

  function upsertSht(series, ts, tVal, hVal){
    ts = Number(ts);
    if(!Number.isFinite(ts) || ts <= 0) return false;

    const A = series.ts;
    const T = series.t;
    const H = series.h;

    const lastTs = A.length ? Number(A[A.length-1]) : 0;
    const prevT = T.length ? Number(T[T.length-1]) : 27.5;
    const prevH = H.length ? Number(H[H.length-1]) : 60.0;

    const nextT = Number.isFinite(Number(tVal)) ? Number(tVal) : prevT;
    const nextH = Number.isFinite(Number(hVal)) ? Number(hVal) : prevH;

    if(A.length && ts === lastTs){
      T[T.length-1] = nextT;
      H[H.length-1] = nextH;
      return true;
    }

    if(!A.length || ts > lastTs){
      A.push(ts);
      T.push(nextT);
      H.push(nextH);
      trim3(A,T,H);
      return true;
    }

    return false;
  }

  let saveTimer = null;
  function saveNow(){
    try{ window.SeriesStore?.save?.(SERIES_KEY, store); }catch{}
  }
  function scheduleSave(){
    if(saveTimer) return;
    saveTimer = setTimeout(()=>{
      saveTimer = null;
      store.updatedAt = Date.now();
      saveNow();
    }, 400);
  }

  function updateCards(){
    const m1 = el("pirMotionVal"); if(m1) m1.textContent = String(latest.pir.motion);
    const m2 = el("pirOccVal");    if(m2) m2.textContent = latest.pir.occupancy ? "Có" : "Không";

    const u = el("rfidUidVal"); if(u) u.textContent = latest.rfid.uid || "-";
    const r = el("rfidResVal"); if(r) r.textContent = String(latest.rfid.result || "chờ").toUpperCase();

    const tt = el("shtTVal"); if(tt) tt.textContent = Number(latest.sht.t).toFixed(1);
    const hh = el("shtHVal"); if(hh) hh.textContent = Number(latest.sht.h).toFixed(1);

    const luTs = Math.max(latest.pir.ts||0, latest.rfid.ts||0, latest.sht.ts||0, Date.now());
    const lu = el("lastUpdate"); if(lu) lu.textContent = fmtClock(luTs);
  }

  const qualityFor = (sensor)=>{
    if(sensor==="SHT31"){
      if(latest.sht.t>=35 || latest.sht.h>=85) return {cls:"bad", text:"Nguy hiểm"};
      if(latest.sht.t>=30 || latest.sht.h>=75) return {cls:"warn", text:"Cảnh báo"};
      return {cls:"good", text:"OK"};
    }
    if(sensor==="PIR") return latest.pir.motion ? {cls:"warn", text:"Có chuyển động"} : {cls:"good", text:"Bình thường"};
    if(sensor==="RFID"){
      if(latest.rfid.result==="deny") return {cls:"bad", text:"Từ chối"};
      if(latest.rfid.result==="allow") return {cls:"good", text:"Cho phép"};
      return {cls:"good", text:"Chờ"};
    }
    return {cls:"good", text:"OK"};
  };

  let q = "";
  window.pageSearchHandler = (v)=>{
    q = String(v||"").trim().toLowerCase();
    renderTable();
    filterCards(q);
  };

  function filterCards(query){
    const wrap = el("sensorCards");
    if(!wrap) return;
    const cards = Array.from(wrap.querySelectorAll(".card[data-key]"));
    if(!query){
      cards.forEach(c=> c.style.display = "");
      return;
    }
    cards.forEach(c=>{
      const txt = (c.textContent||"").toLowerCase();
      c.style.display = txt.includes(query) ? "" : "none";
    });
  }

  function renderTable(){
    const rows = [
      { name:"PIR (HC-SR501)", key:"PIR",
        value:`${latest.pir.motion?"Motion:1":"Motion:0"} • Occupancy: ${latest.pir.occupancy?"Có người":"Không người"}`,
        ts: latest.pir.ts },
      { name:"RFID (PN532)", key:"RFID",
        value:`UID: ${latest.rfid.uid || "-"} • Result: ${String(latest.rfid.result || "chờ").toUpperCase()}`,
        ts: latest.rfid.ts },
      { name:"SHT31 (I2C)", key:"SHT31",
        value:`T: ${Number(latest.sht.t).toFixed(1)} °C • H: ${Number(latest.sht.h).toFixed(1)} %`,
        ts: latest.sht.ts },
    ];

    const filtered = !q ? rows : rows.filter(r => (r.name+" "+r.key+" "+r.value).toLowerCase().includes(q));
    const tbody = el("statusTable");
    if(!tbody) return;

    tbody.innerHTML = (filtered.map(r=>{
      const st = qualityFor(r.key);
      const icon = st.cls==="good" ? "fa-circle-check" : st.cls==="warn" ? "fa-triangle-exclamation" : "fa-circle-xmark";
      return `
        <tr>
          <td><strong>${r.name}</strong></td>
          <td>${r.value}</td>
          <td><span class="chip ${st.cls}"><i class="fa-solid ${icon}"></i> ${st.text}</span></td>
          <td>${fmtClock(r.ts)}</td>
        </tr>
      `;
    }).join("")) || `<tr><td colspan="4" style="color:var(--muted);padding:18px">Không có kết quả.</td></tr>`;
  }

  // ---------- MQTT listeners ----------
  window.addEventListener("iot:state", (e)=>{
    const st = e.detail || {};
    if(typeof st.occupied !== "undefined"){
      latest.pir.occupancy = !!st.occupied;
      store.occupied = latest.pir.occupancy;
      scheduleSave();
    }
    renderTable();
    updateCards();
  });

  window.addEventListener("iot:msg", (e)=>{
    const { topic, text } = e.detail || {};
    if(!topic) return;

    if(topic === "room1/tele"){
      let tele;
      try{ tele = JSON.parse(text); }catch{ return; }

      const ts = toEpochMs(tele.ts);

      if(typeof tele.motion !== "undefined"){
        latest.pir.motion = tele.motion ? 1 : 0;
        latest.pir.ts = ts;
        if(upsert1(store.pir, ts, latest.pir.motion)){
          chartPir.data.labels = store.pir.ts.map(fmtLabel);
          chartPir.update("none");
        }
      }

      if(typeof tele.t !== "undefined" || typeof tele.h !== "undefined"){
        if(typeof tele.t !== "undefined") latest.sht.t = Number(tele.t);
        if(typeof tele.h !== "undefined") latest.sht.h = Number(tele.h);
        latest.sht.ts = ts;

        if(upsertSht(store.sht, ts, latest.sht.t, latest.sht.h)){
          chartSht.data.labels = store.sht.ts.map(fmtLabel);
          chartSht.update("none");
        }
      }

      updateCards();
      renderTable();
      scheduleSave();
      return;
    }

    if(topic.startsWith("room1/event")){
      let ev;
      try{ ev = JSON.parse(text); }catch{ return; }

      if(ev.type === "rfid"){
        const ts = toEpochMs(ev.ts);
        latest.rfid.uid = ev.uid || "";
        latest.rfid.result = ev.result || "";
        latest.rfid.ts = ts;

        store.rfid.uid = latest.rfid.uid;
        store.rfid.result = latest.rfid.result;

        const v = latest.rfid.result === "allow" ? 2 : latest.rfid.result === "deny" ? 1 : 0;
        if(upsert1(store.rfid, ts, v)){
          chartRfid.data.labels = store.rfid.ts.map(fmtLabel);
          chartRfid.update("none");
        }

        updateCards();
        renderTable();
        scheduleSave();
      }
    }
  });

  // ---------- Firebase backfill (optional) ----------
  function dayKeyNow(){
    const s = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }); // YYYY-MM-DD
    return s.replaceAll("-", "");
  }

  async function tryBackfillFromFirebase(){
    // Only backfill if store is empty (fresh browser) or too short.
    if(store.pir.ts.length >= 6 && store.sht.ts.length >= 6) return;

    const FB = await (window.FBReady ? window.FBReady : Promise.resolve(window.FB));
    if(!FB?.db || !FB.get) return;

    const dayKey = dayKeyNow();

    try{
      // Tele history
      const teleRef = FB.ref(FB.db, `history/tele/${dayKey}`);
      const teleQ = FB.query(teleRef, FB.orderByKey(), FB.limitToLast(Math.max(MAX, 48)));
      const teleSnap = await FB.get(teleQ);
      const teleArr = [];
      if(teleSnap.exists()) teleSnap.forEach((c)=> teleArr.push(c.val()));

      teleArr.forEach((tele)=>{
        if(!tele) return;
        const ts = toEpochMs(tele.ts);
        if(typeof tele.motion !== "undefined"){
          latest.pir.motion = tele.motion ? 1 : 0;
          latest.pir.ts = ts;
          upsert1(store.pir, ts, latest.pir.motion);
        }
        if(typeof tele.t !== "undefined" || typeof tele.h !== "undefined"){
          if(typeof tele.t !== "undefined") latest.sht.t = Number(tele.t);
          if(typeof tele.h !== "undefined") latest.sht.h = Number(tele.h);
          latest.sht.ts = ts;
          upsertSht(store.sht, ts, latest.sht.t, latest.sht.h);
        }
      });

      // RFID events
      const evRef = FB.ref(FB.db, `log/event/${dayKey}`);
      const evQ = FB.query(evRef, FB.orderByKey(), FB.limitToLast(120));
      const evSnap = await FB.get(evQ);
      const evArr = [];
      if(evSnap.exists()){
        evSnap.forEach((c)=>{
          const ev = c.val();
          if(ev && ev.type === "rfid") evArr.push(ev);
        });
      }

      evArr.slice(-MAX).forEach((ev)=>{
        const ts = toEpochMs(ev.ts);
        latest.rfid.uid = ev.uid || latest.rfid.uid;
        latest.rfid.result = ev.result || latest.rfid.result;
        latest.rfid.ts = ts;
        store.rfid.uid = latest.rfid.uid;
        store.rfid.result = latest.rfid.result;
        const v = latest.rfid.result === "allow" ? 2 : latest.rfid.result === "deny" ? 1 : 0;
        upsert1(store.rfid, ts, v);
      });

      chartPir.data.labels = store.pir.ts.map(fmtLabel);
      chartPir.update("none");

      chartRfid.data.labels = store.rfid.ts.map(fmtLabel);
      chartRfid.update("none");

      chartSht.data.labels = store.sht.ts.map(fmtLabel);
      chartSht.update("none");

      updateCards();
      renderTable();

      store.updatedAt = Date.now();
      saveNow();
    }catch(err){
      console.warn("[SENSORS] backfill Firebase failed", err?.message || err);
    }
  }

  // ---------- Boot ----------
  document.addEventListener("DOMContentLoaded", ()=>{
    // Optional filter event from common search (if any page emits it)
    window.addEventListener("iot:search", (e)=>{
      const query = String(e.detail || "").trim().toLowerCase();
      filterCards(query);
    });

    updateCards();
    renderTable();
    tryBackfillFromFirebase();
  });
})();
