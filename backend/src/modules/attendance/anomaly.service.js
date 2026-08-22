const pool = require('../../config/db');
const { generateAIResponse } = require('../../services/aiProviderService');
const { send: sendNotification } = require('../notifications/repository');

const WINDOW_DAYS = 30;
const MIN_RECORDS = 10;

function evaluateAttendanceSnapshot(snapshot) {
  const flags = [];
  const attendanceRate = Number(snapshot.attendance_rate);
  const roleRate = Number(snapshot.role_rate);

  if (Number(snapshot.longest_present_streak) >= 7) {
    flags.push({
      type: 'LONG_PRESENT_STREAK',
      reason: `Present on ${snapshot.longest_present_streak} consecutive recorded working days.`,
    });
  }
  if (Number(snapshot.irregular_gap_count) >= 2) {
    flags.push({
      type: 'IRREGULAR_GAPS',
      reason: `${snapshot.irregular_gap_count} gaps longer than three working days in the review window.`,
    });
  }
  if (
    Number(snapshot.record_count) >= MIN_RECORDS &&
    Number.isFinite(attendanceRate) &&
    Number.isFinite(roleRate) &&
    Math.abs(attendanceRate - roleRate) >= 0.25
  ) {
    flags.push({
      type: 'ROLE_DEPARTMENT_DEVIATION',
      reason: `Attendance rate is ${Math.round(attendanceRate * 100)}%, versus ${Math.round(roleRate * 100)}% for the role and department.`,
    });
  }

  return flags;
}

async function getAttendanceAnomalyCandidates(client = pool, windowDays = WINDOW_DAYS) {
  const result = await client.query(
    `WITH eligible AS (
       SELECT a.user_id, a.date, a.status,
              u.full_name, u.manager_id, u.role, u.department_id,
              LAG(a.date) OVER (PARTITION BY a.user_id ORDER BY a.date) AS previous_date
       FROM attendance a
       JOIN users u ON u.id = a.user_id
       WHERE a.deleted_at IS NULL
         AND u.deleted_at IS NULL
         AND a.date >= CURRENT_DATE - ($1::int - 1)
         AND a.date <= CURRENT_DATE
         AND NOT EXISTS (
           SELECT 1 FROM attendance_anomaly_exclusions e
           WHERE e.date = a.date AND (e.user_id = a.user_id OR e.user_id IS NULL)
         )
     ),
     ranked AS (
       SELECT eligible.*,
              date - (ROW_NUMBER() OVER (PARTITION BY user_id, status ORDER BY date))::int AS run_key
       FROM eligible
     ),
     streaks AS (
       SELECT user_id, MAX(run_length)::int AS longest_present_streak
       FROM (
         SELECT user_id, run_key, COUNT(*) AS run_length
         FROM ranked WHERE status = 'PRESENT'
         GROUP BY user_id, run_key
       ) runs
       GROUP BY user_id
     ),
     summaries AS (
      SELECT user_id, MAX(full_name) AS full_name,
        (array_agg(manager_id))[1] AS manager_id,
        (array_agg(role))[1] AS role,
        (array_agg(department_id))[1] AS department_id,
              COUNT(*)::int AS record_count,
              AVG((status = 'PRESENT')::int)::float AS attendance_rate,
              COUNT(*) FILTER (WHERE previous_date IS NOT NULL AND date - previous_date > 3)::int AS irregular_gap_count
       FROM eligible
       GROUP BY user_id
     ),
     norms AS (
       SELECT u.role, u.department_id,
              AVG((a.status = 'PRESENT')::int)::float AS role_rate
       FROM attendance a
       JOIN users u ON u.id = a.user_id
       WHERE a.deleted_at IS NULL AND u.deleted_at IS NULL
         AND a.date >= CURRENT_DATE - ($1::int - 1)
         AND a.date <= CURRENT_DATE
         AND NOT EXISTS (
           SELECT 1 FROM attendance_anomaly_exclusions e
           WHERE e.date = a.date AND (e.user_id = a.user_id OR e.user_id IS NULL)
         )
       GROUP BY u.role, u.department_id
     ),
     intern_summaries AS (
       SELECT * FROM summaries
       WHERE role = 'INTERN' AND manager_id IS NOT NULL
         AND record_count >= $2
     )
     SELECT s.*, COALESCE(st.longest_present_streak, 0)::int AS longest_present_streak,
            COALESCE(n.role_rate, s.attendance_rate)::float AS role_rate,
            manager.full_name AS manager_name
     FROM intern_summaries s
     LEFT JOIN norms n ON n.role = s.role AND n.department_id = s.department_id
     LEFT JOIN streaks st USING (user_id)
     JOIN users manager ON manager.id = s.manager_id AND manager.deleted_at IS NULL
     WHERE s.record_count >= $2`,
    [windowDays, MIN_RECORDS]
  );

  return result.rows.flatMap((snapshot) =>
    evaluateAttendanceSnapshot(snapshot).map((flag) => ({
      ...flag,
      internId: snapshot.user_id,
      internName: snapshot.full_name,
      managerId: snapshot.manager_id,
      managerName: snapshot.manager_name,
      metrics: snapshot,
    }))
  );
}

async function phraseFlag(flag) {
  try {
    const result = await generateAIResponse({
      messages: [
        {
          role: 'system',
          content:
            'Rewrite attendance anomaly evidence as one neutral advisory sentence under  thirty words. Never accuse, infer intent, recommend punishment, or change attendance status.',
        },
        {
          role: 'user',
          content: JSON.stringify({ type: flag.type, evidence: flag.reason }),
        },
      ],
    });
    const text = String(result.content || '').replace(/\s+/g, ' ').trim();
    if (text && text.length <= 240) return text;
  } catch (error) {
    console.warn('[Attendance anomaly AI] unavailable:', error.message);
  }
  return flag.reason;
}

async function runAttendanceAnomalyJob({ client = pool, now = new Date() } = {}) {
  const lock = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [727101]);
  if (!lock.rows[0].locked) return { skipped: true, flags: 0 };

  try {
    const candidates = await getAttendanceAnomalyCandidates(client);
    let sent = 0;
    for (const flag of candidates) {
      const dedupeKey = `${flag.type}:${flag.internId}:${now.toISOString().slice(0, 10)}`;
      const prior = await client.query(
        `SELECT 1 FROM audit_logs
         WHERE action = 'ATTENDANCE_ANOMALY_FLAGGED'
           AND user_id = $1 AND resource_id = $2
           AND details->>'dedupeKey' = $3 LIMIT 1`,
        [flag.managerId, flag.internId, dedupeKey]
      );
      if (prior.rowCount > 0) continue;

      const message = `Attendance advisory for ${flag.internName || 'an intern'}: ${await phraseFlag(flag)} Please review context; no status or penalty was applied.`;
      await sendNotification(flag.managerId, message, client);
      await client.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details, user_agent)
         VALUES ($1, 'ATTENDANCE_ANOMALY_FLAGGED', 'attendance_anomaly', $2, $3, 'InternOpsCron')`,
        [flag.managerId, flag.internId, JSON.stringify({
          dedupeKey,
          flagType: flag.type,
          evidence: flag.reason,
          metrics: flag.metrics,
          advisoryOnly: true,
          createdAt: now.toISOString(),
        })]
      );
      sent++;
    }
    return { skipped: false, flags: sent };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [727101]);
  }
}

module.exports = {
  evaluateAttendanceSnapshot,
  getAttendanceAnomalyCandidates,
  runAttendanceAnomalyJob,
};