/* realtime.js — Realtime page (persist + realtime)
 * - Table: latest from Firebase (latest/tele, latest/rfid, device/state) + realtime MQTT updates if available
 * - Event stream: from Firebase log/raw (persist across page transitions)
 */
(function(){
  const el = (id)=> document.getElementById(id);
  if(!el("statusTable") || !el("eventStream")) return;

  function toEpochMs(ts){
    let n = Number(ts);
    if(!Number.isFinite(n) || n <= 0) return Date.now();
    if(n > 1e9 && n < 1e12) n *= 1000; // seconds -> ms
    return Math.floor(n);
  }
  function fmtTs(ts){
    const d = new Date(Number(ts)||Date.now());
    return (typeof window.fmtTime === "function") ? window.fmtTime(d) : d.toLocaleTimeString("vi-VN", {hour12:false});
  }

  const latest = {
    pir:  { motion:0, occupancy:false, ts: Date.now() },
    rfid: { uid:"", result:"", ts: Date.now() },
    sht:  { t:0, h:0, ts: Date.now() },
    mode: "HOME"
  };

  let q = "";
  window.pageSearchHandler = (v)=>{
    q = String(v||"").trim().toLowerCase();
    renderTable();
    renderStream();
  };

  function qualityFor(sensor){
    if(sensor==="SHT31"){
      if(Number(latest.sht.t)>=35 || Number(latest.sht.h)>=85) return {cls:"bad", text:"Nguy hiểm"};
      if(Number(latest.sht.t)>=30 || Number(latest.sht.h)>=75) return {cls:"warn", text:"Cảnh báo"};
      return {cls:"good", text:"OK"};
    }
    if(sensor==="PIR"){
      return latest.pir.motion ? {cls:"warn", text:"Có chuyển động"} : {cls:"good", text:"Bình thường"};
    }
    if(sensor==="RFID"){
      if(latest.rfid.result==="deny") return {cls:"bad", text:"Từ chối"};
      if(latest.rfid.result==="allow") return {cls:"good", text:"Cho phép"};
      return {cls:"good", text:"Chờ"};
    }
    return {cls:"good", text:"OK"};
  }

  function updateLastUpdate(ts){
    const lu = el("lastUpdate");
    if(lu) lu.textContent = fmtTs(ts);
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
    tbody.innerHTML = filtered.map(r=>{
      const st = qualityFor(r.key);
      const icon = st.cls==="good" ? "fa-circle-check" : st.cls==="warn" ? "fa-triangle-exclamation" : "fa-circle-xmark";
      return `
        <tr>
          <td><strong>${r.name}</strong></td>
          <td>${r.value}</td>
          <td><span class="chip ${st.cls}"><i class="fa-solid ${icon}"></i> ${st.text}</span></td>
          <td>${fmtTs(r.ts)}</td>
        </tr>
      `;
    }).join("") || `<tr><td colspan="4" style="color:var(--muted);padding:18px">Không có kết quả.</td></tr>`;
  }

  // -------- persisted stream (from LogStore / Firebase log/raw) --------
  let streamItems = [];

  function iconForKind(kind){
    if(kind === "cmd") return { cls:"warn", icon:"fa-bolt" };
    if(kind === "state") return { cls:"good", icon:"fa-circle-check" };
    if(kind === "event") return { cls:"good", icon:"fa-flag" };
    if(kind === "status") return { cls:"warn", icon:"fa-wifi" };
    return { cls:"good", icon:"fa-circle-info" };
  }

  function summarize(item){
    const k = item.kind || "";
    const data = item.data || {};
    if(k === "cmd"){
      const tgt = data.target || "?";
      const val = (typeof data.value !== "undefined") ? data.value : "?";
      const src = data.source || "web";
      return { title:"CMD", msg:`${src} set <b>${tgt}</b> = <b>${val}</b>` };
    }
    if(k === "state"){
      const lc = data.lastCmd || {};
      const tgt = lc.target || "?";
      const val = (typeof lc.value !== "undefined") ? lc.value : "?";
      return { title:"ACK", msg:`State cập nhật • <b>${tgt}</b> = <b>${val}</b>` };
    }
    if(k === "event"){
      if(data.type === "rfid"){
        return { title:"RFID", msg:`UID <b>${data.uid||"-"}</b> • ${String(data.result||"").toUpperCase()}` };
      }
      if(data.type === "alarm"){
        return { title:"ALARM", msg:`${data.from||"-"} → <b>${data.to||"-"}</b> • ${data.reason||""}` };
      }
      if(data.type === "mode"){
        return { title:"MODE", msg:`${data.from} → <b>${data.to}</b> • ${data.reason||""}` };
      }
      return { title:"EVENT", msg:`${data.type || "event"}` };
    }
    if(k === "status"){
      return { title:"STATUS", msg:`Device: <b>${String(data)}</b>` };
    }
    return { title:"LOG", msg:`${item.topic || ""}` };
  }

  function renderStream(){
    const wrap = el("eventStream");
    const list = !q ? streamItems : streamItems.filter(it => {
      const s = summarize(it);
      return (s.title + " " + s.msg + " " + (it.topic||"")).toLowerCase().includes(q);
    });

    wrap.innerHTML = list.map(it=>{
      const ui = iconForKind(it.kind);
      const s = summarize(it);
      return `
        <div class="card" style="padding:12px;display:flex;gap:10px;align-items:flex-start">
          <span class="chip ${ui.cls}"><i class="fa-solid ${ui.icon}"></i></span>
          <div style="min-width:0;flex:1">
            <div style="display:flex;justify-content:space-between;gap:12px">
              <div style="font-weight:800">${s.title}</div>
              <div style="color:var(--muted);font-weight:700;white-space:nowrap">${fmtTs(it.ts)}</div>
            </div>
            <div style="color:rgba(255,255,255,.88);margin-top:4px">${s.msg}</div>
            <div style="margin-top:6px;color:var(--muted);font-size:12px">${it.topic || ""}</div>
          </div>
        </div>
      `;
    }).join("") || `<div style="color:var(--muted);padding:12px">Chưa có event. Hãy quẹt thẻ RFID hoặc đổi mode.</div>`;
  }

  function bindLogStore(){
    if(!window.LogStore) return;
    window.LogStore.on((items)=>{
      streamItems = (items || []).slice(0, 25);
      renderStream();
    });
    window.LogStore.start(50);
  }

  async function bindFirebaseLatest(){
    const FB = await (window.FBReady ? window.FBReady : Promise.resolve(window.FB));
    if(!FB?.db) return;

    FB.onValue(FB.ref(FB.db, "latest/tele"), (snap)=>{
      const v = snap.val();
      if(!v) return;
      const ts = toEpochMs(v.ts);

      if(typeof v.motion !== "undefined"){
        latest.pir.motion = v.motion ? 1 : 0;
        latest.pir.ts = ts;
      }
      if(typeof v.t !== "undefined"){ latest.sht.t = Number(v.t); latest.sht.ts = ts; }
      if(typeof v.h !== "undefined"){ latest.sht.h = Number(v.h); latest.sht.ts = ts; }

      updateLastUpdate(ts);
      renderTable();
    });

    FB.onValue(FB.ref(FB.db, "device/state"), (snap)=>{
      const v = snap.val();
      if(!v) return;

      if(typeof v.occupied !== "undefined") latest.pir.occupancy = !!v.occupied;

      if(typeof v.modeIdx !== "undefined" && window.IOT?.MODES){
        latest.mode = window.IOT.MODES[(Number(v.modeIdx)||0) % window.IOT.MODES.length];
      } else if(typeof v.modeIdx !== "undefined"){
        latest.mode = ["HOME","AWAY","NIGHT"][(Number(v.modeIdx)||0) % 3];
      }

      const mt = el("modeText");
      if(mt) mt.textContent = latest.mode;

      if(v.ts) updateLastUpdate(toEpochMs(v.ts));
      renderTable();
    });

    FB.onValue(FB.ref(FB.db, "latest/rfid"), (snap)=>{
      const v = snap.val();
      if(!v) return;

      const ts = toEpochMs(v.ts);
      latest.rfid.uid = v.uid || "";
      latest.rfid.result = v.result || "";
      latest.rfid.ts = ts;

      updateLastUpdate(ts);
      renderTable();
    });
  }

  // Optional: MQTT updates if your mqtt-client.js emits iot:msg/iot:state
  window.addEventListener("iot:state", (e)=>{
    const st = e.detail || {};
    if(typeof st.occupied !== "undefined") latest.pir.occupancy = !!st.occupied;
    if(typeof st.mode === "string") latest.mode = st.mode;

    const mt = el("modeText");
    if(mt) mt.textContent = latest.mode;

    if(st.ts) updateLastUpdate(toEpochMs(st.ts));
    renderTable();
  });

  window.addEventListener("iot:msg", (e)=>{
    const { topic, text } = e.detail || {};
    if(topic !== "room1/tele") return;
    try{
      const v = JSON.parse(text);
      const ts = toEpochMs(v.ts);

      latest.pir.motion = v.motion ? 1 : 0;
      latest.pir.ts = ts;
      if(typeof v.t !== "undefined"){ latest.sht.t = Number(v.t); latest.sht.ts = ts; }
      if(typeof v.h !== "undefined"){ latest.sht.h = Number(v.h); latest.sht.ts = ts; }

      updateLastUpdate(ts);
      renderTable();
    }catch{}
  });

  document.addEventListener("DOMContentLoaded", ()=>{
    bindLogStore();
    bindFirebaseLatest();
    renderTable();
    renderStream();
  });
})();
