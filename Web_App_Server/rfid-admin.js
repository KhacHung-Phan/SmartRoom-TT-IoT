/* rfid-admin.js
 * Admin-only RFID allowlist management (Firebase RTDB)
 *
 * Schema:
 *   config/rfid/allow/<UID> = { name, enabled:true, createdAt, updatedAt, createdBy }
 *
 * Bridge (Node.js) listens to config/rfid/allow and publishes retained MQTT:
 *   room1/rfid/allow = { ts, uids:[...] }
 */

(function(){
  const $ = (id)=> document.getElementById(id);

  const wrap = $("rfidAdmin");
  if(!wrap) return;

  const toast = (typeof window.toast === "function") ? window.toast : () => {};

  function normalizeUidKey(uid){
    return String(uid || "")
      .replace(/[^0-9a-fA-F]/g, "")
      .toUpperCase();
  }

  function fmtDateTime(ts){
    const ms = Number(ts);
    if(!Number.isFinite(ms) || ms <= 0) return "-";
    try{
      return new Date(ms).toLocaleString("vi-VN", { hour12:false });
    }catch{ return new Date(ms).toISOString(); }
  }

  function escapeHtml(s){
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  async function main(){
    const me = window.Auth?.currentUser?.();
    const isAdmin = !!me && me.role === "admin";

    if(!isAdmin){
      wrap.style.display = "none";
      return;
    }

    const FB = await (window.FBReady ? window.FBReady : Promise.resolve(window.FB));
    if(!FB?.db){
      toast("bad", "Firebase", "Chưa khởi tạo Firebase RTDB.");
      return;
    }

    // UI refs
    const uidInput = $("rfid_uid");
    const nameInput = $("rfid_name");
    const btnAdd = $("btnRfidAdd");
    const tbody = $("rfidTableBody");
    const statTotal = $("rfidStatTotal");
    const statEnabled = $("rfidStatEnabled");

    const baseRef = FB.ref(FB.db, "config/rfid/allow");

    function render(rows){
      const total = rows.length;
      const enabled = rows.filter(r => r.enabled).length;
      if(statTotal) statTotal.textContent = String(total);
      if(statEnabled) statEnabled.textContent = String(enabled);

      if(!tbody) return;
      if(!rows.length){
        tbody.innerHTML = `<tr><td colspan="5" style="color:var(--muted);padding:18px">Chưa có UID nào.</td></tr>`;
        return;
      }

      tbody.innerHTML = rows.map(r=>{
        const chip = r.enabled
          ? `<span class="chip good"><i class="fa-solid fa-circle-check"></i> enabled</span>`
          : `<span class="chip bad"><i class="fa-solid fa-circle-xmark"></i> disabled</span>`;
        return `
          <tr>
            <td style="white-space:nowrap"><code>${escapeHtml(r.uid)}</code></td>
            <td>${escapeHtml(r.name || "-")}</td>
            <td>${chip}</td>
            <td style="white-space:nowrap">${escapeHtml(fmtDateTime(r.updatedAt || r.createdAt))}</td>
            <td style="white-space:nowrap">
              <button class="btn" data-act="toggle" data-uid="${escapeHtml(r.uid)}">
                <i class="fa-solid fa-power-off"></i> ${r.enabled ? "Disable" : "Enable"}
              </button>
              <button class="btn danger" data-act="del" data-uid="${escapeHtml(r.uid)}">
                <i class="fa-solid fa-trash"></i> Xoá
              </button>
            </td>
          </tr>
        `;
      }).join("");
    }

    // Live list
    FB.onValue(baseRef, (snap)=>{
      const rows = [];
      snap.forEach((child)=>{
        const uid = normalizeUidKey(child.key);
        const v = child.val() || {};
        if(!uid) return;
        const enabled = (v === true) || (v && typeof v === "object" && (v.enabled === true || v.allow === true));
        rows.push({ uid, name: (v && typeof v === "object" ? v.name : ""), enabled, createdAt: v.createdAt || 0, updatedAt: v.updatedAt || 0 });
      });
      rows.sort((a,b)=> a.uid.localeCompare(b.uid));
      render(rows);
    });

    btnAdd?.addEventListener("click", async ()=>{
      const uidRaw = uidInput ? uidInput.value : "";
      const uid = normalizeUidKey(uidRaw);
      const name = String(nameInput ? nameInput.value : "").trim();

      if(!uid){
        toast("warn", "RFID", "Vui lòng nhập UID (hex). Ví dụ: 04ABCDEF12");
        return;
      }
      if(uid.length < 6){
        toast("warn", "RFID", "UID quá ngắn. Hãy nhập đúng UID hex.");
        return;
      }

      const now = Date.now();
      const payload = {
        name,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        createdBy: me?.email || me?.name || "admin",
      };

      try{
        await FB.set(FB.ref(FB.db, `config/rfid/allow/${uid}`), payload);
        toast("good", "RFID", `Đã thêm UID ${uid}`);
        if(uidInput) uidInput.value = "";
        if(nameInput) nameInput.value = "";
        uidInput?.focus();
      }catch(err){
        toast("bad", "RFID", err?.message || String(err));
      }
    });

    tbody?.addEventListener("click", async (e)=>{
      const btn = e.target.closest("button[data-act]");
      if(!btn) return;
      const act = btn.dataset.act;
      const uid = normalizeUidKey(btn.dataset.uid);
      if(!uid) return;

      try{
        if(act === "del"){
          if(!confirm(`Xoá UID ${uid}?`)) return;
          await FB.remove(FB.ref(FB.db, `config/rfid/allow/${uid}`));
          toast("good", "RFID", `Đã xoá UID ${uid}`);
          return;
        }

        if(act === "toggle"){
          const rowRef = FB.ref(FB.db, `config/rfid/allow/${uid}`);
          const snap = await FB.get(rowRef);
          const v = snap.val();
          const current = (v === true) || (v && typeof v === "object" && (v.enabled === true || v.allow === true));

          const now = Date.now();
          const next = {
            ...(v && typeof v === "object" ? v : {}),
            enabled: !current,
            updatedAt: now,
          };
          if(!next.createdAt) next.createdAt = now;

          await FB.set(rowRef, next);
          toast("good", "RFID", `${!current ? "Enable" : "Disable"} ${uid}`);
        }
      }catch(err){
        toast("bad", "RFID", err?.message || String(err));
      }
    });

    // UX: enter key in UID/name inputs
    uidInput?.addEventListener("keydown", (e)=>{
      if(e.key === "Enter") btnAdd?.click();
    });
    nameInput?.addEventListener("keydown", (e)=>{
      if(e.key === "Enter") btnAdd?.click();
    });
  }

  main().catch((e)=>{
    const toast = (typeof window.toast === "function") ? window.toast : () => {};
    toast("bad", "RFID", e?.message || String(e));
  });
})();
