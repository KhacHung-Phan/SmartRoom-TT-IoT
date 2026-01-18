(function(){
  // Device state synced with Firebase RTDB: /device/state
  // Keeps existing API used across pages (toggleLight/toggleFan/toggleSiren/cycleMode).

  const MODES = ["HOME","AWAY","NIGHT"];
  const state = { light:false, fan:false, siren:false, modeIdx:0 };
  const listeners = new Set();

  const notify = ()=>{
    const snap = { ...state };
    listeners.forEach(fn=>{ try{ fn(snap); }catch{} });
  };

  const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
  async function getFB(){
    // Prefer FBReady to avoid race with module loading.
    if(window.FBReady) return await window.FBReady;
    // Fallback wait up to ~4s.
    for(let i=0;i<80;i++){
      if(window.FB?.db) return window.FB;
      await sleep(50);
    }
    throw new Error("Firebase not loaded");
  }

  async function ensureAnon(){
    const FB = await getFB();
    try{
      if(!FB.auth.currentUser) await FB.signInAnonymously(FB.auth);
    }catch(e){
      // Keep going; read may still work if rules are public.
      console.warn("[Device] Anonymous sign-in failed", e);
    }
    return FB;
  }

  let inited = false;
  let lastSentUpdatedAt = 0;
  async function init(){
    if(inited) return;
    inited = true;

    let FB;
    try{
      FB = await ensureAnon();
    }catch(e){
      console.warn("[Device] Firebase init failed", e);
      return;
    }

    const stRef = FB.ref(FB.db, "device/state");
    FB.onValue(stRef, (snap)=>{
      const v = snap.val();
      if(!v){
        // Create defaults once so you see something in RTDB immediately.
        FB.set(stRef, { ...state, updatedAt: Date.now() }).catch(()=>{});
        return;
      }

      state.light = !!v.light;
      state.fan = !!v.fan;
      state.siren = !!v.siren;
      const idx = Number(v.modeIdx);
      state.modeIdx = Number.isFinite(idx) ? (idx % MODES.length) : 0;
      notify();
    }, (err)=>{
      console.warn("[Device] RTDB onValue error", err);
    });
  }

  async function writePatch(patch){
    const FB = await ensureAnon();
    const stRef = FB.ref(FB.db, "device/state");
    // Always include a timestamp so ESP32 can detect new commands.
    // Make it monotonic to avoid duplicated ms when user clicks fast.
    let ts = Date.now();
    if(ts <= lastSentUpdatedAt) ts = lastSentUpdatedAt + 1;
    lastSentUpdatedAt = ts;

    const u = FB?.auth?.currentUser;
    const by = u ? (u.isAnonymous ? `web:anon:${String(u.uid).slice(0,6)}` : `web:${u.email || u.uid}`) : "web";

    await FB.update(stRef, { ...patch, updatedAt: ts, updatedBy: by });
  }

  function mode(){
    return MODES[state.modeIdx % MODES.length];
  }

  function optimisticToggle(key){
    // Keep the old synchronous return style, but write to Firebase in background.
    const prev = state[key];
    const next = !prev;
    state[key] = next;
    notify();

    writePatch({ [key]: next }).catch((e)=>{
      // Revert if write fails.
      state[key] = prev;
      notify();
      window.toast?.("bad", "Firebase", "Không ghi được lệnh lên Firebase (check mạng/rules).");
      console.warn("[Device] writePatch failed", e);
    });
    return next;
  }

  function optimisticModeNext(){
    const prev = state.modeIdx;
    const nextIdx = (prev + 1) % MODES.length;
    state.modeIdx = nextIdx;
    notify();

    writePatch({ modeIdx: nextIdx }).catch((e)=>{
      state.modeIdx = prev;
      notify();
      window.toast?.("bad", "Firebase", "Không ghi được mode lên Firebase (check mạng/rules).");
      console.warn("[Device] writePatch failed", e);
    });
    return mode();
  }

  // Expose API
  window.Device = {
    state,
    MODES,
    init,
    onChange(fn){ listeners.add(fn); try{ fn({ ...state }); }catch{} return ()=>listeners.delete(fn); },
    mode,
    toggleLight(){ return optimisticToggle("light"); },
    toggleFan(){ return optimisticToggle("fan"); },
    toggleSiren(){ return optimisticToggle("siren"); },
    cycleMode(){ return optimisticModeNext(); },
  };

  // Auto-init on load so the UI stays in sync across tabs.
  init().catch(()=>{});
})();
