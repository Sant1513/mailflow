-- Free-plan watch (additive): when the 15-minute dispatch last ran, so the laptop can warn
-- when the timer that drives sending has stopped.
ALTER TABLE "SystemState" ADD COLUMN "lastDispatchAt" TIMESTAMP(3);
