import { vi } from 'vitest';

const { reportErrorMock, loggerMock } = vi.hoisted(() => ({
  reportErrorMock: vi.fn(),
  loggerMock: {
    trace: vi.fn(),
  },
}));

vi.mock('../../src/helper', () => ({
  reportError: reportErrorMock,
}));

vi.mock('../../src/logger', () => ({
  default: loggerMock,
}));

import { createCommand } from '../../src/commands/abstract/createCommand';

describe('createCommand', () => {
  beforeEach(() => {
    reportErrorMock.mockReset();
    loggerMock.trace.mockReset();
  });

  test('returns async command failures to Command.run for centralized error handling', async () => {
    const failure = new Error('async command failed');
    const CommandCtor = createCommand({
      id: 'test.command',
      name: 'Test Command',
      handleCommand: async () => {
        throw failure;
      },
    });
    const command = new CommandCtor();

    await command.run();

    expect(reportErrorMock).toHaveBeenCalledWith(failure);
  });
});
