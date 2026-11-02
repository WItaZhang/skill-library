import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
async function start() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const key = fragment.get("local-key");
  if (key) {
    // The launch key never travels in a request URL or Referer.
    history.replaceState(null, "", location.pathname + location.search);
    try {
      await fetch("/api/identity/localLogin", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
    } catch {
      /* The normal sign-in screen provides recovery. */
    }
  }
  createRoot(document.getElementById("root")!).render(<App />);
}
void start();
