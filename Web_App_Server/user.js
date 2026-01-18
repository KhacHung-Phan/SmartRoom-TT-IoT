(function(){
  const wrap = document.getElementById("usersWrap");
  if(!wrap) return;

  const me = Auth.currentUser();
  const allowed = me && me.role === "admin";

  const notAllowed = document.getElementById("notAllowed");
  const tbody = document.getElementById("usersTableBody");

  const modal = document.getElementById("userModalBackdrop");
  const modalTitle = document.getElementById("userModalTitle");
  const btnAdd = document.getElementById("btnAddUser");
  const btnClose = document.getElementById("btnCloseUserModal");
  const btnSave = document.getElementById("btnSaveUser");

  const fId = document.getElementById("f_id");
  const fName = document.getElementById("f_name");
  const fEmail = document.getElementById("f_email");
  const fPhone = document.getElementById("f_phone");
  const fRole = document.getElementById("f_role");
  const fStatus = document.getElementById("f_status");
  const fPassword = document.getElementById("f_password");

  let query = "";

  const esc = (s)=> String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

  function openModal(mode, user){
    modalTitle.textContent = mode==="add" ? "Thêm người dùng" : "Chỉnh sửa người dùng";
    fId.value = user?.id || "";
    fName.value = user?.name || "";
    fEmail.value = user?.email || "";
    fPhone.value = user?.phone || "";
    fRole.value = user?.role || "user";
    fStatus.value = user?.status || "active";
    fPassword.value = "";
    modal.classList.add("show");
  }
  function closeModal(){ modal.classList.remove("show"); }

  function render(){
    const users = Auth.listUsers();
    const q = query.trim().toLowerCase();
    const list = !q ? users : users.filter(u => (u.name+" "+u.email+" "+u.role+" "+u.status+" "+(u.phone||"")).toLowerCase().includes(q));

    tbody.innerHTML = list.map(u=>{
      const isMe = me && u.id === me.id;
      return `
        <tr>
          <td><strong>${esc(u.name)}</strong></td>
          <td>${esc(u.email)}</td>
          <td>${esc(u.phone||"-")}</td>
          <td><span class="chip ${u.role==="admin"?"warn":"good"}"><i class="fa-solid fa-user-shield"></i> ${esc(u.role)}</span></td>
          <td><span class="chip ${u.status==="active"?"good":"bad"}"><i class="fa-solid ${u.status==="active"?"fa-circle-check":"fa-circle-xmark"}"></i> ${esc(u.status)}</span></td>
          <td style="white-space:nowrap">${esc(u.createdAt||"-")}</td>
          <td style="white-space:nowrap">
            <button class="btn" data-act="edit" data-id="${u.id}"><i class="fa-solid fa-pen"></i> Sửa</button>
            <button class="btn danger" data-act="del" data-id="${u.id}" ${isMe ? "disabled style='opacity:.55;cursor:not-allowed'" : ""}><i class="fa-solid fa-trash"></i> Xoá</button>
          </td>
        </tr>
      `;
    }).join("") || `<tr><td colspan="7" style="color:var(--muted);padding:18px">Không có user phù hợp.</td></tr>`;
  }

  function save(){
    const id = fId.value.trim();
    const payload = {
      name: fName.value.trim(),
      email: fEmail.value.trim(),
      phone: fPhone.value.trim(),
      role: fRole.value,
      status: fStatus.value
    };
    const pw = fPassword.value;

    try{
      if(!payload.name || !payload.email){
        toast("warn","Thiếu thông tin","Vui lòng nhập tên và email.");
        return;
      }
      if(id){
        const patch = {...payload};
        if(pw) patch.password = pw;
        Auth.updateUser(id, patch);
        toast("good","Đã lưu","Cập nhật người dùng thành công.");
      }else{
        Auth.createUser({...payload, password: pw || "123456"});
        toast("good","Đã tạo","Tạo người dùng mới thành công.");
      }
      closeModal();
      render();
    }catch(err){
      toast("bad","Lỗi", err.message || String(err));
    }
  }

  function init(){
    if(!allowed){
      notAllowed.style.display = "block";
      wrap.style.display = "none";
      return;
    }
    notAllowed.style.display = "none";
    wrap.style.display = "block";

    btnAdd.addEventListener("click", ()=> openModal("add", null));
    btnClose.addEventListener("click", closeModal);
    modal.addEventListener("click", (e)=>{ if(e.target === modal) closeModal(); });
    btnSave.addEventListener("click", save);

    tbody.addEventListener("click", (e)=>{
      const btn = e.target.closest("button[data-act]");
      if(!btn) return;
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      const user = Auth.listUsers().find(u => u.id === id);
      if(!user) return;

      if(act==="edit") openModal("edit", user);
      if(act==="del"){
        if(me && user.id===me.id){
          toast("warn","Không thể","Bạn không thể xoá chính bạn.");
          return;
        }
        if(confirm(`Xoá user: ${user.email} ?`)){
          Auth.deleteUser(id);
          toast("good","Đã xoá","Xoá thành công.");
          render();
        }
      }
    });

    window.pageSearchHandler = (v)=>{ query = String(v||""); render(); };
    render();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
