-- Add optional job fields used by the router (run in Supabase SQL Editor)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cache_warm   BOOLEAN DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS decode_worker TEXT;
