-- Approved leave and holidays must be excluded from advisory attendance analysis.
-- This feature never infers an exception from attendance data or changes status.
CREATE TABLE IF NOT EXISTS attendance_anomaly_exclusions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  kind VARCHAR(30) NOT NULL CHECK (kind IN ('HOLIDAY', 'APPROVED_LEAVE')),
  reason TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, date, kind)
);

CREATE INDEX IF NOT EXISTS idx_attendance_anomaly_exclusions_date
  ON attendance_anomaly_exclusions(date, user_id);