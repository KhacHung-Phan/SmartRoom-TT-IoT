(function(){
  const USERS_KEY = "iot_users";
  const SESSION_KEY = "iot_session";

  const uid = (p="u") => `${p}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  const nowISO = () => new Date().toISOString();

  const load = (k, fb) => {
    try{ const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : fb; }catch{ return fb; }
  };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  const Auth = {
    seed(){
      const existing = load(USERS_KEY, null);
      if(Array.isArray(existing) && existing.length) return;

      const users = [
        { id: uid("admin"), name:"Admin", email:"khachung@gmail.com", phone:"", role:"admin", status:"active", password:"@123456", createdAt: nowISO(), lastLoginAt:null },
        { id: uid("u"), name:"Gia An", email:"phamgiaan912@gmail.com", phone:"", role:"user", status:"active", password:"123456", createdAt: nowISO(), lastLoginAt:null },
      ];
      save(USERS_KEY, users);
    },

    listUsers(){ return load(USERS_KEY, []); },
    getUserById(id){ return this.listUsers().find(u => u.id === id) || null; },
    getSession(){ return load(SESSION_KEY, null); },

    currentUser(){
      const sess = this.getSession();
      if(!sess?.userId) return null;
      return this.getUserById(sess.userId);
    },

    login(email, password){
      const users = this.listUsers();
      const user = users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
      if(!user) throw new Error("Email không tồn tại.");
      if(user.status !== "active") throw new Error("Tài khoản đang bị khoá.");
      if(user.password !== password) throw new Error("Sai mật khẩu.");

      user.lastLoginAt = nowISO();
      save(USERS_KEY, users);
      save(SESSION_KEY, { userId: user.id, createdAt: nowISO() });
      return user;
    },

    register({name, email, phone, password}){
      const users = this.listUsers();
      if(users.some(u => u.email.toLowerCase() === String(email).toLowerCase())){
        throw new Error("Email đã được đăng ký.");
      }
      const user = {
        id: uid("u"),
        name: String(name||"").trim() || "User",
        email: String(email||"").trim(),
        phone: String(phone||"").trim(),
        role: "user",
        status: "active",
        password: String(password||""),
        createdAt: nowISO(),
        lastLoginAt: null
      };
      users.unshift(user);
      save(USERS_KEY, users);
      save(SESSION_KEY, { userId: user.id, createdAt: nowISO() });
      return user;
    },

    logout(){ localStorage.removeItem(SESSION_KEY); },

    updateUser(id, patch){
      const users = this.listUsers();
      const idx = users.findIndex(u => u.id === id);
      if(idx === -1) throw new Error("Không tìm thấy user.");
      users[idx] = { ...users[idx], ...patch };
      save(USERS_KEY, users);
      return users[idx];
    },

    createUser(payload){
      const users = this.listUsers();
      const email = String(payload.email||"").trim();
      if(!email) throw new Error("Email bắt buộc.");
      if(users.some(u => u.email.toLowerCase() === email.toLowerCase())){
        throw new Error("Email đã tồn tại.");
      }
      const user = {
        id: uid(payload.role === "admin" ? "admin" : "u"),
        name: String(payload.name||"").trim() || "User",
        email,
        phone: String(payload.phone||"").trim(),
        role: payload.role === "admin" ? "admin" : "user",
        status: payload.status === "disabled" ? "disabled" : "active",
        password: String(payload.password || "123456"),
        createdAt: nowISO(),
        lastLoginAt: null
      };
      users.unshift(user);
      save(USERS_KEY, users);
      return user;
    },

    deleteUser(id){
      const users = this.listUsers().filter(u => u.id !== id);
      save(USERS_KEY, users);
    },

    requireAuth(){
      const user = this.currentUser();
      if(!user){
        location.href = "login.html";
        return false;
      }
      return true;
    },

    renderUserUI(){
      const user = this.currentUser();
      const nameEl = document.getElementById("userName");
      const roleEl = document.getElementById("userRole");
      const emailEl = document.getElementById("userEmail");
      if(nameEl) nameEl.textContent = user ? user.name : "Khách";
      if(roleEl) roleEl.textContent = user ? user.role.toUpperCase() : "GUEST";
      if(emailEl) emailEl.textContent = user ? user.email : "-";
    }
  };

  window.Auth = Auth;
})();
