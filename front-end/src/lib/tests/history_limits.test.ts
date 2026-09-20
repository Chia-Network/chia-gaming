import {
  appendDiagnosticEntry,
  DIAGNOSTIC_LOG_UTF8_BYTE_LIMIT,
  diagnosticLogUtf8Bytes,
  recentDiagnosticEntries,
} from '../session/historyLimits';

describe('diagnostic history byte budget', () => {
  it('retains the newest complete UTF-8 entries through append', () => {
    const older = `older:${'😀'.repeat(20_000)}`;
    const newer = `newer:${'界'.repeat(70_000)}`;

    const bounded = appendDiagnosticEntry([older], newer);

    expect(bounded).toEqual([newer]);
    expect(diagnosticLogUtf8Bytes(bounded)).toBeLessThanOrEqual(DIAGNOSTIC_LOG_UTF8_BYTE_LIMIT);
  });

  it('drops a single oversized incident without splitting it', () => {
    const oversized = '😀'.repeat(DIAGNOSTIC_LOG_UTF8_BYTE_LIMIT);

    expect(recentDiagnosticEntries([oversized])).toEqual([]);
    expect(appendDiagnosticEntry(['retained'], oversized)).toEqual(['retained']);
  });
});
