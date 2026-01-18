(function(){
  const el = (id)=> document.getElementById(id);
  if(!el("btnLight")) return;

  // ===================== Device UI =====================
  function setBadge(id, on){
    const b = el(id);
    if(!b) return;
    b.textContent = on ? "ON" : "OFF";
    b.classList.toggle("on", !!on);
    b.classList.toggle("off", !on);
  }

  function getState(){
    // Prefer MQTT client state, fallback to Device.state
    if(window.IOT?.state) return window.IOT.state;
    if(window.Device?.state) return window.Device.state;
    return { light:false, fan:false, siren:false, modeIdx:0 };
  }

  function modeTextFrom(modeIdx){
    const MODES = window.IOT?.MODES || ["HOME","AWAY","NIGHT"];
    return MODES[(Number(modeIdx)||0) % MODES.length];
  }

  function applyDeviceUI(){
    const st = getState();
    setBadge("badgeLight", !!st.light);
    setBadge("badgeFan",   !!st.fan);
    setBadge("badgeSiren", !!st.siren);

    const m = (typeof st.mode === "string") ? st.mode : modeTextFrom(st.modeIdx);
    if(el("modeText")) el("modeText").textContent = m;
    if(el("modePill")) el("modePill").textContent = m;

    // last update timestamp (from room1/state.ts)
    const tsMs = (typeof window.toEpochMs === "function") ? window.toEpochMs(st.ts) : Number(st.ts);
    if(el("lastUpdate")){
      const d = new Date(Number.isFinite(tsMs) && tsMs > 0 ? tsMs : Date.now());
      el("lastUpdate").textContent = (typeof window.fmtTime === "function") ? window.fmtTime(d) : d.toLocaleTimeString("vi-VN",{hour12:false});
    }
  }

  window.addEventListener("iot:state", ()=> applyDeviceUI());

  // ===================== Send commands =====================
  function publishSet(target, value){
    // Preferred: MQTT command path
    if(window.IOT?.publishCmd){
      return window.IOT.publishCmd({ type:"set", target, value });
    }

    // Fallback: old Device (Firebase write)
    if(window.Device){
      if(target === "light") return window.Device.toggleLight();
      if(target === "fan")   return window.Device.toggleFan();
      if(target === "siren") return window.Device.toggleSiren();
    }
  }

  el("btnLight")?.addEventListener("click", ()=>{
    const st = getState();
    const on = !st.light;
    publishSet("light", on ? 1 : 0);
    window.toast?.("good","Đèn", on ? "Đã gửi lệnh bật đèn." : "Đã gửi lệnh tắt đèn.");
  });

  el("btnFan")?.addEventListener("click", ()=>{
    const st = getState();
    const on = !st.fan;
    publishSet("fan", on ? 1 : 0);
    window.toast?.("good","Quạt", on ? "Đã gửi lệnh bật quạt." : "Đã gửi lệnh tắt quạt.");
  });

  el("btnSiren")?.addEventListener("click", ()=>{
    const st = getState();
    const on = !st.siren;
    publishSet("siren", on ? 1 : 0);
    window.toast?.(on ? "warn" : "good","Siren", on ? "Đã gửi lệnh bật còi!" : "Đã gửi lệnh tắt còi.");
  });

  el("btnMode")?.addEventListener("click", ()=>{
    const st = getState();
    const cur = Number(st.modeIdx)||0;
    const next = (cur + 1) % 3;
    publishSet("modeIdx", next);
    window.toast?.("good","Mode", `Đã gửi lệnh chuyển sang ${modeTextFrom(next)}.`);
  });

  // ===================== Persisted Action Log (Firebase log/raw) =====================
  const wrap = el("actionLog");

  function iconForKind(kind){
    if(kind === "cmd") return { cls:"warn", icon:"fa-bolt" };
    if(kind === "state") return { cls:"good", icon:"fa-circle-check" };
    if(kind === "event") return { cls:"good", icon:"fa-flag" };
    if(kind === "status") return { cls:"warn", icon:"fa-wifi" };
    return { cls:"good", icon:"fa-circle-info" };
  }

  function fmtTs(ts){
    const d = new Date(Number(ts)||Date.now());
    return (typeof window.fmtTime === "function") ? window.fmtTime(d) : d.toLocaleTimeString("vi-VN",{hour12:false});
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

  function renderLog(items){
    if(!wrap) return;
    const filtered = (items || [])
      .filter(it => it && (it.kind === "cmd" || it.kind === "state"))
      .slice(0, 20);

    wrap.innerHTML = filtered.map(it=>{
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
    }).join("") || `<div style="color:var(--muted);padding:12px">Chưa có nhật ký. Hãy thử bật/tắt đèn.</div>`;
  }

  function bindLogStore(){
    if(!window.LogStore) return;
    window.LogStore.on((items)=> renderLog(items));
    window.LogStore.start(50);
  }

  document.addEventListener("DOMContentLoaded", ()=>{
    applyDeviceUI();
    bindLogStore();
  });
})();
