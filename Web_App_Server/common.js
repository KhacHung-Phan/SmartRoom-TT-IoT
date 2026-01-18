(function(){
  const $ = (s, el=document) => el.querySelector(s);
  const $$ = (s, el=document) => Array.from(el.querySelectorAll(s));

  function toast(type, title, msg){
    const wrap = $("#toasts");
    if(!wrap) return;
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    const icon = type === "good" ? "fa-circle-check" : type === "warn" ? "fa-triangle-exclamation" : "fa-circle-xmark";
    el.innerHTML = `
      <i class="fa-solid ${icon}"></i>
      <div class="t"><strong>${title}</strong><span>${msg}</span></div>
    `;
    wrap.appendChild(el);
    requestAnimationFrame(()=> el.classList.add("show"));
    setTimeout(()=>{
      el.classList.remove("show");
      setTimeout(()=> el.remove(), 250);
    }, 3200);
  }
  window.toast = toast;

  function fmtTime(d){
    try{
      return d.toLocaleTimeString("vi-VN",{hour12:false});
    }catch{
      return "--:--:--";
    }
  }
  window.fmtTime = fmtTime;

  // Normalize timestamps to epoch milliseconds.
  // Accepts ms or seconds and fixes common wrong ranges.
  function toEpochMs(ts){
    let n = Number(ts);
    if(!Number.isFinite(n) || n <= 0) return Date.now();
    // seconds -> ms
    if(n > 1e9 && n < 1e12) n = n * 1000;
    n = Math.floor(n);
    const now = Date.now();
    // sanity window: ignore too old / too far in future
    if(n < 1600000000000 || n > now + 24*3600*1000) return now;
    return n;
  }
  window.toEpochMs = toEpochMs;

  // Shared localStorage store for chart series/state across pages.
  window.SeriesStore = (function(){
    const PREFIX = "iot_series_";
    function load(key, fallback=null){
      try{
        const raw = localStorage.getItem(PREFIX + key);
        if(!raw) return fallback;
        return JSON.parse(raw);
      }catch{ return fallback; }
    }
    function save(key, value){
      try{ localStorage.setItem(PREFIX + key, JSON.stringify(value)); }catch{}
    }
    function clear(key){
      try{ localStorage.removeItem(PREFIX + key); }catch{}
    }
    return { load, save, clear };
  })();

  function setActiveNav(){
    const path = location.pathname.split("/").pop() || "index.html";
    $$(".nav a, .side-menu a").forEach(a=>{
      const href = (a.getAttribute("href")||"").split("/").pop();
      a.classList.toggle("active", href === path);
    });
  }

  function setupUserMenu(){
    const menu = $("#userMenu");
    const btn = $("#userBtn");
    if(!menu || !btn) return;
    btn.addEventListener("click", ()=>{
      menu.classList.toggle("open");
    });
    document.addEventListener("click", (e)=>{
      if(!menu.contains(e.target)) menu.classList.remove("open");
    });
  }

  function setupSearch(){
    const input = $("#searchInput");
    const clear = $("#btnClearSearch");
    if(!input) return;

    const fire = ()=>{
      const v = input.value;
      window.pageSearchHandler?.(v);
    };

    input.addEventListener("input", fire);
    clear?.addEventListener("click", ()=>{
      input.value = "";
      fire();
      input.focus();
    });
  }

  function setupConnection(){
    const dot = $("#connDot");
    const text = $("#connText");
    function set(ok, label){
      if(dot){
        dot.classList.toggle("ok", !!ok);
        dot.classList.toggle("bad", !ok);
      }
      if(text) text.textContent = label || (ok ? "Online" : "Offline");
    }
    set(true,"Online");
    window.addEventListener("iot:status", (e)=>{
      const d = e.detail || {};
      if(d.ok) set(true, "Online");
      else set(false, d.label || "Offline");
    });
  }

  function setupSlider(){
    const slides = $("#slides");
    const dots = $("#dots");
    const prev = $("#prevSlide");
    const next = $("#nextSlide");
    if(!slides || !dots) return;

    const items = $$(".slide", slides);
    let idx = 0;

    const renderDots = ()=>{
      dots.innerHTML = items.map((_,i)=> `<button class="dot ${i===idx?"active":""}" aria-label="Slide ${i+1}"></button>`).join("");
      $$(".dot", dots).forEach((b,i)=> b.addEventListener("click", ()=>go(i)));
    };

    const go = (i)=>{
      idx = (i + items.length) % items.length;
      slides.style.transform = `translateX(-${idx*100}%)`;
      renderDots();
    };

    prev?.addEventListener("click", ()=>go(idx-1));
    next?.addEventListener("click", ()=>go(idx+1));

    renderDots();
    setInterval(()=>go(idx+1), 6000);
  }

  function setupSidebar(){
    const app = $("#app");
    const btn = $("#btnSidebar");
    const btnSmall = $("#btnSidebarSmall");
    const chev = $("#sidebarChevron");

    if(!app) return;

    const mq = window.matchMedia("(max-width: 980px)");
    const KEY = "sidebar_collapsed_v1";
    const KEY_MOBILE = "sidebar_mobile_open_v1";

    // Overlay for mobile drawer
    let overlay = document.getElementById("sidebarOverlay");
    if(!overlay){
      overlay = document.createElement("div");
      overlay.id = "sidebarOverlay";
      overlay.className = "sidebar-overlay";
      document.body.appendChild(overlay);
    }

    const isMobile = ()=> mq.matches;

    function updateOverlay(){
      const open = isMobile() && app.classList.contains("mobile-open");
      overlay.classList.toggle("show", open);
    }

    function setCollapsed(val){
      app.classList.toggle("sidebar-collapsed", !!val);
      localStorage.setItem(KEY, val ? "1" : "0");
      if(chev) chev.classList.toggle("flip", !!val);
    }

    function setMobileOpen(val){
      app.classList.toggle("mobile-open", !!val);
      localStorage.setItem(KEY_MOBILE, val ? "1" : "0");
      updateOverlay();
    }

    // init
    const saved = localStorage.getItem(KEY);
    if(saved === "1") setCollapsed(true);

    // mobile init
    const savedMobile = localStorage.getItem(KEY_MOBILE);
    if(isMobile() && savedMobile === "1") setMobileOpen(true);

    function toggle(){
      if(isMobile()){
        setMobileOpen(!app.classList.contains("mobile-open"));
      }else{
        setCollapsed(!app.classList.contains("sidebar-collapsed"));
      }
    }

    btn?.addEventListener("click", toggle);
    btnSmall?.addEventListener("click", toggle);

    overlay.addEventListener("click", ()=> setMobileOpen(false));

    // Alt+S shortcut
    document.addEventListener("keydown", (e)=>{
      if(e.altKey && (e.key === "s" || e.key === "S")){
        e.preventDefault();
        toggle();
      }
    });

    mq.addEventListener?.("change", ()=>{
      // close mobile drawer when leaving mobile
      if(!isMobile()){
        setMobileOpen(false);
      }
      updateOverlay();
    });

    updateOverlay();
  }

  function setupPageTransitions(){
    const DURATION = 180;

    function isModified(e){
      return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
    }

    document.addEventListener("click", (e)=>{
      const a = e.target.closest("a");
      if(!a) return;
      if(isModified(e)) return;
      if(a.target && a.target !== "_self") return;
      if(a.hasAttribute("download")) return;

      const href = a.getAttribute("href");
      if(!href || href.startsWith("#")) return;
      if(href.startsWith("mailto:") || href.startsWith("tel:")) return;

      let url;
      try{ url = new URL(href, location.href); }catch(_){ return; }
      if(url.origin !== location.origin) return;
      if(url.pathname === location.pathname && url.search === location.search) return;

      e.preventDefault();

      document.documentElement.classList.add("page-leave");
      setTimeout(()=>{ location.href = href; }, DURATION);
    });
  }

  function setYear(){
    const y = document.getElementById("year");
    if(y) y.textContent = new Date().getFullYear();
  }

  function setupAuth(){
    if(!window.Auth) return true;

    try{ window.Auth.seed?.(); }catch{}

    const mode = (document.body && document.body.dataset && document.body.dataset.auth) ? document.body.dataset.auth : "protected";
    if(mode === "protected"){
      const ok = window.Auth.requireAuth?.();
      if(ok === false) return false; // already redirected
      try{ window.Auth.renderUserUI?.(); }catch{}
    }

    const doLogout = ()=>{
      try{ window.IOT?.client?.end?.(true); }catch{}
      try{ window.Auth.logout?.(); }catch{}
      location.href = "login.html";
    };

    document.getElementById("logoutBtn")?.addEventListener("click", doLogout);
    document.getElementById("sidebarLogoutBtn")?.addEventListener("click", doLogout);
    return true;
  }

  // ===================== Firebase LogStore (persist logs across pages) =====================
  // Reads from RTDB: log/raw (limit last 50)
  // Each page can render "nhật ký" by subscribing to LogStore.on(...)
  window.LogStore = (function(){
    const store = {
      items: [], // newest first
      ready: false,
      _unsub: null,
      _listeners: new Set(),
      on(fn){
        store._listeners.add(fn);
        try{ fn(store.items.slice()); }catch{}
        return ()=> store._listeners.delete(fn);
      },
      _emit(){
        const snap = store.items.slice();
        store._listeners.forEach(fn=>{ try{ fn(snap); }catch{} });
        window.dispatchEvent(new CustomEvent("log:updated", { detail: { items: snap } }));
      },
      async start(limit=50){
        if(store._unsub) return; // already started
        const FB = await (window.FBReady ? window.FBReady : Promise.resolve(window.FB));
        if(!FB?.db) return;

        const baseRef = FB.ref(FB.db, "log/raw");
        const q = FB.query(baseRef, FB.limitToLast(limit));

        const handler = (snap)=>{
          const arr = [];
          snap.forEach((childSnap)=>{
            const v = childSnap.val();
            if(v) arr.push({ key: childSnap.key, ...v });
          });

          arr.sort((a,b)=> (Number(b.ts||0) - Number(a.ts||0)) || String(b.key).localeCompare(String(a.key)));
          store.items = arr;
          store.ready = true;
          store._emit();
        };

        FB.onValue(q, handler);

        store._unsub = ()=> {
          try{ FB.off(q, "value", handler); }catch{}
          store._unsub = null;
        };
      },
      stop(){
        if(store._unsub) store._unsub();
      }
    };
    return store;
  })();

  document.addEventListener("DOMContentLoaded", ()=>{
    if(setupAuth() === false) return;
    setActiveNav();
    setupSidebar();
    setupUserMenu();
    setupSearch();
    setupConnection();
    setupSlider();
    setupPageTransitions();
    setYear();

    // start shared LogStore once per page load
    window.LogStore?.start?.(50);
  });
})();



if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("/service-worker.js");
    } catch (e) {
      console.warn("SW register failed", e);
    }
  });
}
