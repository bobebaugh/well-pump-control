const healthRow = document.querySelector("#health-cloud");
const healthDot = healthRow.querySelector(".health-dot");
const healthText = healthRow.querySelector("small");
const checkTime = document.querySelector("#api-check-time");

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(date);
}

async function checkApi() {
  const checkedAt = new Date();

  try {
    const response = await fetch("/.netlify/functions/health", {
      headers: { "Accept": "application/json" },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();
    healthDot.className = "health-dot online";
    healthText.textContent = result.status === "ok" ? "Online" : "Unexpected response";
    checkTime.textContent = `API checked ${formatTime(checkedAt)}`;
  } catch (error) {
    healthDot.className = "health-dot offline";
    healthText.textContent = "Unavailable";
    checkTime.textContent = `API check failed ${formatTime(checkedAt)}`;
  }
}

checkApi();
setInterval(checkApi, 30000);
