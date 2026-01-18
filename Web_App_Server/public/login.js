(function(){
  const $ = (s)=> document.querySelector(s);
  const $$ = (s)=> Array.from(document.querySelectorAll(s));

  function switchTab(name){
    $$(".tab").forEach(t => t.classList.toggle("active", t.id === (name==="login"?"tabLogin":"tabRegister")));
    $("#loginForm").classList.toggle("active", name==="login");
    $("#registerForm").classList.toggle("active", name==="register");
  }

  document.addEventListener("DOMContentLoaded", ()=>{
    Auth.seed();
    if(Auth.currentUser()){
      location.href = "dashboard.html";
      return;
    }

    $("#tabLogin").addEventListener("click", ()=> switchTab("login"));
    $("#tabRegister").addEventListener("click", ()=> switchTab("register"));

    $("#loginForm").addEventListener("submit", (e)=>{
      e.preventDefault();
      try{
        Auth.login($("#login_email").value.trim(), $("#login_password").value);
        toast("good","Đăng nhập","Đăng nhập thành công.");
        setTimeout(()=> location.href="dashboard.html", 160);
      }catch(err){
        toast("bad","Đăng nhập thất bại", err.message || String(err));
      }
    });

    $("#registerForm").addEventListener("submit", (e)=>{
      e.preventDefault();
      const pw = $("#reg_password").value;
      const pw2 = $("#reg_password2").value;
      if(pw !== pw2){
        toast("warn","Mật khẩu","Mật khẩu nhập lại không khớp.");
        return;
      }
      try{
        Auth.register({
          name: $("#reg_name").value.trim(),
          email: $("#reg_email").value.trim(),
          phone: $("#reg_phone").value.trim(),
          password: pw
        });
        toast("good","Đăng ký","Tạo tài khoản thành công.");
        setTimeout(()=> location.href="dashboard.html", 160);
      }catch(err){
        toast("bad","Đăng ký thất bại", err.message || String(err));
      }
    });

    switchTab("login");
  });
})();
