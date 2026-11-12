-- Recruiter Bulk Send: "Send from the laptop" (additive). runOn says where a send's messages go
-- out from: 'cloud' (Vercel, the default and every existing send) or 'laptop' (the laptop
-- server's standby runner, saving Vercel's monthly CPU). runOnChangedAt is set when the cloud
-- takes a send over from a laptop that went silent.
ALTER TABLE "RecruiterBlast" ADD COLUMN "runOn" TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE "RecruiterBlast" ADD COLUMN "runOnChangedAt" TIMESTAMP(3);
