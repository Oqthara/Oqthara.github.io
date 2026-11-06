// Firebase Web SDK configuration for the public content mirror.
//
// This is the PUBLIC web configuration. It is not an administrative credential: it identifies
// the `oqthara` project to the browser SDK and is safe to ship. Anything that can write needs
// the Admin SDK, which lives only in `scripts/sync-firestore.mjs` and never under `src/`.
//
// The deployed site must work with no extra configuration, so every key falls back to the
// public defaults below. `firebaseConfigStatus()` still reports exactly which required keys
// are missing, and `VITE_FIREBASE_DISABLE_DEFAULTS=1` turns the fallback off so a misconfigured
// environment fails loudly instead of silently pointing at the production project.
//
// Nothing here initializes Firebase at import time. The site is prerendered in Node, where
// `initializeApp` must not run; `getFirebaseApp()` is a lazy, idempotent singleton.

import { getApps, initializeApp } from "firebase/app";

/** The public web config for the `oqthara` Firebase project. Safe to expose. */
export const PUBLIC_FIREBASE_CONFIG = Object.freeze({
  apiKey: "AIzaSyA6GUE_5lbaadRxGZZi1_pvj7RMB8BFuDc",
  authDomain: "oqthara.firebaseapp.com",
  projectId: "oqthara",
  storageBucket: "oqthara.firebasestorage.app",
  messagingSenderId: "788054550913",
  appId: "1:788054550913:web:6b02c5a3889337e1c8e080",
  measurementId: "G-KDW7QD0CMZ",
});

/** Keys without which the SDK cannot reach the project. */
export const REQUIRED_FIREBASE_KEYS = Object.freeze(["apiKey", "authDomain", "projectId", "appId"]);

/** Environment variable for each config key. */
export const FIREBASE_ENV_KEYS = Object.freeze({
  apiKey: "VITE_FIREBASE_API_KEY",
  authDomain: "VITE_FIREBASE_AUTH_DOMAIN",
  projectId: "VITE_FIREBASE_PROJECT_ID",
  storageBucket: "VITE_FIREBASE_STORAGE_BUCKET",
  messagingSenderId: "VITE_FIREBASE_MESSAGING_SENDER_ID",
  appId: "VITE_FIREBASE_APP_ID",
  measurementId: "VITE_FIREBASE_MEASUREMENT_ID",
});

/**
 * Variable that points the SDK at the local Firestore emulator, e.g. `127.0.0.1:8080`.
 *
 * This exists so the read path and the security rules can be proven end to end in a real
 * browser without touching the production project or holding an administrative credential.
 * It is empty in every normal build: when unset nothing connects anywhere new.
 */
export const FIREBASE_EMULATOR_ENV_KEY = "VITE_FIREBASE_EMULATOR_HOST";

/** The emulator `host:port` from an env object, or `null` when it is unset or empty. */
export function readEmulatorHost(env = import.meta.env ?? {}) {
  return nonEmpty(env?.[FIREBASE_EMULATOR_ENV_KEY]) || null;
}

/** A configuration failure the caller can explain without leaking values. */
export class FirebaseConfigError extends Error {
  constructor(message, { missing = [] } = {}) {
    super(message);
    this.name = "FirebaseConfigError";
    this.code = "firebase/config";
    this.missing = Object.freeze([...missing]);
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

/**
 * Reads the Vite-exposed Firebase variables from an env object.
 *
 * Vite only exposes `VITE_`-prefixed variables to client code. Passing the env explicitly is
 * what makes this testable in plain Node, where `import.meta.env` is undefined.
 */
export function readFirebaseEnv(env = import.meta.env ?? {}) {
  const source = env && typeof env === "object" ? env : {};
  const values = {};
  for (const [key, variable] of Object.entries(FIREBASE_ENV_KEYS)) {
    values[key] = nonEmpty(source[variable]);
  }
  return values;
}

/** True when the runtime has a browser document. Prerendering runs without one. */
export function isBrowserRuntime() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * Resolves the effective config, reporting what is missing.
 *
 * `useDefaults: false` (or `VITE_FIREBASE_DISABLE_DEFAULTS=1`) disables the public fallback,
 * which is the only situation in which a required key can be reported missing.
 */
export function resolveFirebaseConfig(env = import.meta.env ?? {}, options = {}) {
  const source = readFirebaseEnv(env);
  const useDefaults =
    options.useDefaults ?? nonEmpty(env?.VITE_FIREBASE_DISABLE_DEFAULTS) !== "1";
  const config = {};
  let usingDefaults = false;

  for (const key of Object.keys(PUBLIC_FIREBASE_CONFIG)) {
    const provided = source[key];
    if (provided) {
      config[key] = provided;
    } else if (useDefaults) {
      config[key] = PUBLIC_FIREBASE_CONFIG[key];
      usingDefaults = true;
    } else {
      config[key] = "";
    }
  }

  const missing = REQUIRED_FIREBASE_KEYS.filter((key) => !config[key]);
  return {
    config,
    missing,
    configured: missing.length === 0,
    usingDefaults,
    useDefaults,
  };
}

/**
 * The status a page or diagnostic can show: which required keys are missing and whether the
 * public defaults were used. Never contains an administrative credential.
 */
export function firebaseConfigStatus(env = import.meta.env ?? {}, options = {}) {
  const { config, missing, configured, usingDefaults, useDefaults } = resolveFirebaseConfig(env, options);
  return Object.freeze({
    configured,
    missing: Object.freeze([...missing]),
    usingDefaults,
    useDefaults,
    projectId: config.projectId || "",
  });
}

/**
 * The exact object handed to `initializeApp`.
 *
 * Kept separate from `firebaseConfigStatus()` because the status is a diagnostic shape
 * (which keys are missing, which project) while this is the full config. Passing the status
 * to `initializeApp` yields `app/no-options` at runtime, which fails every read.
 */
export function firebaseAppConfig(env = import.meta.env ?? {}, options = {}) {
  const resolved = resolveFirebaseConfig(env, options);
  assertFirebaseConfig(resolved);
  return resolved.config;
}

/** Throws a descriptive error listing the missing keys. No credential values are printed. */
export function assertFirebaseConfig(status) {
  if (status?.configured) return status;
  const missing = status?.missing ?? [...REQUIRED_FIREBASE_KEYS];
  const variables = missing.map((key) => FIREBASE_ENV_KEYS[key]).join(", ");
  throw new FirebaseConfigError(
    `Firebase configuration is incomplete. Missing required key${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. ` +
      `Set ${variables} or leave the public defaults enabled.`,
    { missing },
  );
}

let appInstance = null;

/**
 * The Firebase app singleton.
 *
 * Returns the already-initialized app if another module initialized one first, so importing
 * this module twice cannot throw `app/duplicate-app`. Outside a browser (the Node prerender)
 * this throws instead of touching the network, and callers such as `isFirebaseAvailable()`
 * check that condition first.
 */
export function getFirebaseApp() {
  if (appInstance) return appInstance;

  if (!isBrowserRuntime()) {
    throw new FirebaseConfigError(
      "Firebase can only be initialized in the browser; the site is currently prerendering in Node.",
    );
  }

  const status = firebaseConfigStatus();
  assertFirebaseConfig(status);

  const existing = getApps()[0];
  appInstance = existing ?? initializeApp(firebaseAppConfig());
  return appInstance;
}

/** Test seam: forget the singleton without touching the real Firebase registry. */
export function __resetFirebaseAppForTests() {
  appInstance = null;
}
