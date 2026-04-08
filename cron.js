// SurakshaPath AI — Daily Cron Job (Member 4)
// Calls POST /zone-stats/update for every active zone at midnight.
//
// Run standalone: node cron.js
// Or schedule it with a cron tool (e.g. node-cron, GitHub Actions, Railway cron)

import dotenv from "dotenv";
dotenv.config();

// All zones currently active on the platform
// Add new zones here as the platform expands beyond Bengaluru
const ZONES = [
  "Bengaluru North",
  "Bengaluru South",
  "Bengaluru East",
  "Bengaluru West",
  "Bengaluru Central",
];

const API_BASE = process.env.API_BASE_URL || "http://localhost:3000";

async function updateAllZones() {
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  console.log(`[CRON] Running zone stats update for ${today}`);

  for (const zone of ZONES) {
    try {
      const res = await fetch(`${API_BASE}/zone-stats/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zone, date: today }),
      });
      const data = await res.json();
      console.log(`[CRON] ${zone}: ${data.success ? "OK" : data.error}`);
    } catch (err) {
      console.error(`[CRON] ${zone}: FAILED — ${err.message}`);
    }
  }

  console.log("[CRON] Done.");
}

updateAllZones();
