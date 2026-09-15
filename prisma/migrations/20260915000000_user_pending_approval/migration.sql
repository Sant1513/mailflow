-- Add PENDING to UserStatus enum for the new user approval flow.
-- PostgreSQL does not allow removing enum values, so PENDING is permanent once added.
ALTER TYPE "UserStatus" ADD VALUE 'PENDING';
