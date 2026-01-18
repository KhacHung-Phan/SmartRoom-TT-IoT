// firebase-init.js (ES Module)
// Firebase modular SDK (v9+):
// - Initializes Firebase App + RTDB + Auth
// - Exposes RTDB helpers to window.FB for classic scripts (common.js, dashboard.js, realtime.js, ...)
// - Exposes window.FBReady Promise to avoid race conditions.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import {
  getDatabase,
  ref,
  set,
  update,
  push,
  remove,
  get,
  child,
  onValue,
  onChildAdded,
  off,
  query,
  orderByKey,
  orderByChild,
  limitToLast,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-database.js";

import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";

// ===================== CONFIG =====================
const firebaseConfig = {
  apiKey: "AIzaSyDvWdBB0xCFWWdDOttXQuyFbgZat1SJH3w",
  authDomain: "smartroom-562e0.firebaseapp.com",
  databaseURL: "https://smartroom-562e0-default-rtdb.firebaseio.com",
  projectId: "smartroom-562e0",
  storageBucket: "smartroom-562e0.firebasestorage.app",
  messagingSenderId: "937685328540",
  appId: "1:937685328540:web:855783f7b54416c69a4359",
  measurementId: "G-91SYN852S3",
};

// Allow overriding via window.__FB_CONFIG__ (optional)
const cfg = window.__FB_CONFIG__ || firebaseConfig;

// ===================== INIT =====================
const app = initializeApp(cfg);
const db = getDatabase(app);
const auth = getAuth(app);

// Expose a single namespace to classic scripts
window.FB = {
  app,
  db,
  auth,
  // RTDB API
  ref,
  set,
  update,
  push,
  remove,
  get,
  child,
  onValue,
  onChildAdded,
  off,
  query,
  orderByKey,
  orderByChild,
  limitToLast,
};

// --------------------- Auth bootstrap ---------------------
function getStoredCreds() {
  const email = localStorage.getItem("fb_email") || "";
  const pass = localStorage.getItem("fb_pass") || "";
  return { email, pass };
}

window.FBReady = (async () => {
  await new Promise((r) => setTimeout(r, 0));

  if (auth.currentUser) return window.FB;

  onAuthStateChanged(auth, (u) => {
    window.dispatchEvent(
      new CustomEvent("fb:auth", {
        detail: {
          ok: !!u,
          user: u
            ? { uid: u.uid, email: u.email || null, isAnonymous: u.isAnonymous }
            : null,
        },
      })
    );
  });

  // 1) Try anonymous
  try {
    await signInAnonymously(auth);
    console.log("[Firebase] Signed in anonymously.");
    return window.FB;
  } catch (eAnon) {
    console.warn(
      "[Firebase] signInAnonymously failed (maybe disabled).",
      eAnon?.message || eAnon
    );
  }

  // 2) Try email/password if provided
  const { email, pass } = getStoredCreds();
  if (email && pass) {
    try {
      await signInWithEmailAndPassword(auth, email, pass);
      console.log("[Firebase] Signed in with Email/Password:", email);
      return window.FB;
    } catch (eEmail) {
      console.warn(
        "[Firebase] signInWithEmailAndPassword failed.",
        eEmail?.message || eEmail
      );
    }
  }

  return window.FB;
})();
