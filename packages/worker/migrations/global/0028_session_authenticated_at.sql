-- Record when a cookie session's holder last authenticated interactively.
-- NULL for rows created before this migration; readers fall back to created_at.
-- Step-up reauthentication (#102) compares this value against a maximum age
-- before allowing high-impact membership and credential mutations.
ALTER TABLE _sessions ADD COLUMN authenticated_at INTEGER;
