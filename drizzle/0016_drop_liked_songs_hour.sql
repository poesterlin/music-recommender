-- `hour` was a lossy integer duplicate of the hour already carried by
-- `liked_at`: on every row that had both, EXTRACT(HOUR FROM liked_at) = hour
-- (7 of 7, no disagreements), and only 7 of 83 rows ever had it set at all.
-- `liked_at` is fully populated and is the timestamp to read instead.
--
-- Nothing was branching on this column, so removing it loses no information.
ALTER TABLE "liked_songs" DROP COLUMN IF EXISTS "hour";
