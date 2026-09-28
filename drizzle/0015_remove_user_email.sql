-- Accounts are identified by username alone. Email was optional, was never
-- verified, and was not used to sign in, so it only added a place to leak from.
ALTER TABLE "user" DROP COLUMN IF EXISTS "email";
