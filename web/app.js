const healthRow = document.querySelector("#health-cloud");
const firestoreRow = document.querySelector("#health-firestore");
const checkTime = document.querySelector("#api-check-time");

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(date);
}

function setHealth(row, state, text) {
  row.querySelector(".health-dot").className = `health-dot ${state}`;
  row.querySelector("small").textContent = text;
}

async function fetchStatus(path) {
  const response = await fetch(path, {
    headers: { "Accept": "application/json" },
    cache: "no-store"
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.body = body;
    throw error;
  }

  return body;
}

async function checkServices() {
  const checkedAt = new Date();

  const [apiResult, firestoreResult] = await Promise.allSettled([
    fetchStatus("/.netlify/functions/health"),
    fetchStatus("/.netlify/functions/firebase-status")
  ]);

  if (apiResult.status === "fulfilled" && apiResult.value.status === "ok") {
    setHealth(healthRow, "online", "Online");
  } else {
    setHealth(healthRow, "offline", "Unavailable");
  }

  if (firestoreResult.status === "fulfilled" && firestoreResult.value.status === "ok") {
    const marker = firestoreResult.value.markerExists ? "Connected · marker found" : "Connected · empty";
    setHealth(firestoreRow, "online", marker);
  } else {
    const code = firestoreResult.reason?.body?.code;
    const text = code === "configuration_missing" ? "Credentials not configured" : "Unavailable";
    setHealth(firestoreRow, code === "configuration_missing" ? "checking" : "offline", text);
  }

  checkTime.textContent = `Services checked ${formatTime(checkedAt)}`;
}

checkServices();
setInterval(checkServices, 30000);
