"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const record = (id, session = "session001", cycle = 4) => ({ recordId: id, schemaVersion: 2, sessionId: session, cycleSequence: cycle, observationTime: "2026-03-08T01:00:00.000Z", receiptTime: "2026-03-08T01:01:00.000Z", observationTimeStatus: "reported-device-time", rulesRelease: { releaseId: "20260308000000-event-v3-v1" }, triggerReasons: [{ kind: id }], fields: { PumpWatts: { state: "available", value: 0 }, ClockValid: { state: "available", value: false } } });
const catalog = [{ name: "PumpWatts", label: "Pump watts", unit: "W" }, { name: "ClockValid", label: "Clock", unit: null }];
http.createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/.netlify/functions/record-browser") {
    const receipt = url.searchParams.get("view") === "receipt";
    const session = url.searchParams.get("view") === "session";
    const continued = Boolean(url.searchParams.get("cursor"));
    const id = receipt ? (continued ? "receipt-older" : "receipt-row") : session ? (continued ? "session-later" : "session-row") : (continued ? "observation-older" : url.searchParams.has("anchor") ? "observation-anchored" : "observation-row");
    const body = { status: "ok", source: receipt ? "receipt-time-fallback" : undefined, catalog, defaultColumns: ["PumpWatts", "ClockValid"], records: [record(id)], nextCursor: continued ? null : "mock-next", previousCursor: session && continued ? "mock-before" : null };
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); return;
  }
  const files = { "/records.html": "web/records.html", "/records.js": "web/records.js", "/styles.css": "web/styles.css" };
  const file = files[url.pathname] || files["/records.html"];
  response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }); response.end(fs.readFileSync(path.join(root, file)));
}).listen(4173, "127.0.0.1", () => console.log("record browser UI mock listening"));
