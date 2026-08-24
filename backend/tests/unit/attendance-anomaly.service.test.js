const { evaluateAttendanceSnapshot } = require('../../src/modules/attendance/anomaly.service');

describe('attendance anomaly advisory rules', () => {
  test('flags supported statistical patterns only', () => {
    const flags = evaluateAttendanceSnapshot({
      record_count: 20,
      longest_present_streak: 8,
      irregular_gap_count: 2,
      attendance_rate: 0.95,
      role_rate: 0.55,
    });

    expect(flags.map((flag) => flag.type)).toEqual([
      'LONG_PRESENT_STREAK',
      'IRREGULAR_GAPS',
      'ROLE_DEPARTMENT_DEVIATION',
    ]);
  });

  test('does not flag insufficient or ambiguous evidence', () => {
    expect(
      evaluateAttendanceSnapshot({
        record_count: 9,
        longest_present_streak: 20,
        irregular_gap_count: 4,
        attendance_rate: 1,
        role_rate: 0,
      })
    ).toEqual([
      {
        type: 'LONG_PRESENT_STREAK',
        reason: 'Present on 20 consecutive recorded working days.',
      },
      {
        type: 'IRREGULAR_GAPS',
        reason: '4 gaps longer than three working days in the review window.',
      },
    ]);
  });
});