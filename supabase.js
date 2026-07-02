const { createClient } = require("@supabase/supabase-js")
require("dotenv").config()

// Use Service Key if available (bypasses RLS, for backend only)
// Fall back to regular key if Service Key not configured
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY

if (!process.env.SUPABASE_URL) {
  console.error("ERROR: SUPABASE_URL is not set")
}

if (!supabaseKey) {
  console.error("ERROR: Neither SUPABASE_SERVICE_KEY nor SUPABASE_KEY is set")
}

const usingServiceKey = !!process.env.SUPABASE_SERVICE_KEY
console.log(`Supabase client initialized with ${usingServiceKey ? "SERVICE KEY (bypasses RLS)" : "PUBLISHABLE KEY (subject to RLS)"}`)

const supabase = createClient(
  process.env.SUPABASE_URL,
  supabaseKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
)

module.exports = supabase