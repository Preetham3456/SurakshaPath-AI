// SurakshaPath AI — Member 4 API Server
// Run: node server.js
// Requires: npm install express @supabase/supabase-js dotenv cors

import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

// ─── Startup env check ───────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

console.log("SUPABASE_URL present:", !!SUPABASE_URL);
console.log("SUPABASE_ANON_KEY present:", !!SUPABASE_ANON_KEY);

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("ERROR: Missing Supabase env vars. Check Railway Variables tab.");
  process.exit(1);
}

// ─── Supabase client ────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "SurakshaPath M4 API is running" });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /driver/:driver_id/score?month=4&year=2026
//
// Smart hybrid: recalculates score only if there are completed jobs more recent
// than the last recorded score. Otherwise returns the cached score immediately.
// Consumed by: Member 2 (driver portal score tab)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/driver/:driver_id/score", async (req, res) => {
  const { driver_id } = req.params;
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year) || new Date().getFullYear();

  try {
    // Check if a score record already exists for this driver/month/year
    const { data: existing } = await supabase
      .from("scores")
      .select("*")
      .eq("driver_id", driver_id)
      .eq("month", month)
      .eq("year", year)
      .single();

    // Check if driver has any completed jobs more recent than the score record
    let needsRecalc = true;
    if (existing) {
      const { data: newJobs } = await supabase
        .from("jobs")
        .select("job_id")
        .eq("driver_id", driver_id)
        .eq("status", "Completed")
        .gt("created_at", existing.created_at)
        .limit(1);

      needsRecalc = newJobs && newJobs.length > 0;
    }

    // Recalculate only when necessary
    if (needsRecalc) {
      const { error: calcError } = await supabase.rpc("calculate_driver_score", {
        p_driver_id: driver_id,
        p_month: month,
        p_year: year,
      });
      if (calcError) throw calcError;
    }

    // Fetch the (now up-to-date) score record
    const { data: score, error: fetchError } = await supabase
      .from("scores")
      .select("*")
      .eq("driver_id", driver_id)
      .eq("month", month)
      .eq("year", year)
      .single();

    if (fetchError) throw fetchError;
    if (!score) return res.status(404).json({ error: "No score found for this driver" });

    res.json({ recalculated: needsRecalc, score });
  } catch (err) {
    console.error("Score error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /leaderboard?zone=Bengaluru North&month=4&year=2026
//
// Returns all drivers in a zone ranked by monthly score.
// Consumed by: Member 2 (driver portal leaderboard tab)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/leaderboard", async (req, res) => {
  const zone = req.query.zone;
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year) || new Date().getFullYear();

  if (!zone) {
    return res.status(400).json({ error: "zone query param is required" });
  }

  try {
    const { data, error } = await supabase.rpc("get_zone_leaderboard", {
      p_zone: zone,
      p_month: month,
      p_year: year,
    });

    if (error) throw error;
    res.json({ zone, month, year, leaderboard: data });
  } catch (err) {
    console.error("Leaderboard error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /driver/:driver_id/badge
//
// Returns the driver's current streak badge based on their last 10 jobs.
// Consumed by: Member 2 (driver card, score tab)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/driver/:driver_id/badge", async (req, res) => {
  const { driver_id } = req.params;

  try {
    const { data, error } = await supabase.rpc("update_badge_streak", {
      p_driver_id: driver_id,
    });

    if (error) throw error;
    res.json({ driver_id, badge: data });
  } catch (err) {
    console.error("Badge error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /penalties/skip
//
// Called by Member 3 when a driver ignores an alert past the 12-second window.
// Body: { driver_id, job_id }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/penalties/skip", async (req, res) => {
  const { driver_id, job_id } = req.body;

  if (!driver_id || !job_id) {
    return res.status(400).json({ error: "driver_id and job_id are required" });
  }

  try {
    const { data, error } = await supabase.rpc("handle_skip_penalty", {
      p_driver_id: driver_id,
      p_job_id: job_id,
    });

    if (error) throw error;

    // The function returns a plain text result string
    const wentOffline = data && data.startsWith("OFFLINE");
    res.json({ result: data, driver_offline: wentOffline });
  } catch (err) {
    console.error("Skip penalty error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /zone-stats/update
//
// Recalculates and stores daily stats for a zone.
// Called by a daily cron job (see cron.js).
// Body: { zone, date }   e.g. { "zone": "Bengaluru North", "date": "2026-04-08" }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/zone-stats/update", async (req, res) => {
  const { zone, date } = req.body;

  if (!zone || !date) {
    return res.status(400).json({ error: "zone and date are required" });
  }

  try {
    const { error } = await supabase.rpc("update_zone_stats", {
      p_zone: zone,
      p_date: date,
    });

    if (error) throw error;
    res.json({ success: true, zone, date });
  } catch (err) {
    console.error("Zone stats error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /hospital/prealert
//
// Called by Member 3 the moment a job is dispatched to a driver.
// Body: { job_id, hospital_name, emergency_type, eta_minutes }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/hospital/prealert", async (req, res) => {
  const { job_id, hospital_name, emergency_type, eta_minutes } = req.body;

  if (!job_id || !hospital_name || !emergency_type || eta_minutes == null) {
    return res.status(400).json({
      error: "job_id, hospital_name, emergency_type, and eta_minutes are all required",
    });
  }

  try {
    const { data, error } = await supabase.rpc("send_hospital_prealert", {
      p_job_id: job_id,
      p_hospital_name: hospital_name,
      p_emergency_type: emergency_type,
      p_eta_minutes: eta_minutes,
    });

    if (error) throw error;

    // data is the formatted pre-alert message string
    res.json({ success: true, alert_message: data });
  } catch (err) {
    console.error("Hospital pre-alert error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /gov/zones?month=4&year=2026
//
// Returns aggregated zone_stats for the government dashboard.
// Optional: filter by a specific zone with ?zone=Bengaluru North
// Consumed by: government dashboard (Member 4 owns this UI too)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/gov/zones", async (req, res) => {
  const { zone, month, year } = req.query;

  try {
    let query = supabase
      .from("zone_stats")
      .select("*")
      .order("date", { ascending: false });

    if (zone) query = query.eq("zone", zone);

    if (month && year) {
      // Filter to a specific month using date range
      const start = `${year}-${String(month).padStart(2, "0")}-01`;
      const endDate = new Date(year, month, 0); // last day of month
      const end = endDate.toISOString().split("T")[0];
      query = query.gte("date", start).lte("date", end);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ zones: data });
  } catch (err) {
    console.error("Gov zones error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SurakshaPath M4 API running on port ${PORT}`);
});
