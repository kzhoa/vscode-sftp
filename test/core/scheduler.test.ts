import Scheduler from '../../src/core/scheduler';

const fixture = Symbol('fixture');

const delay = (milliseconds: number) =>
  new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });

const wrapTask = (fn: () => unknown | Promise<unknown>) => ({
  run: fn,
});

describe('scheduler', () => {
  test('.add() starts immediately when concurrency allows', () => {
    let result;
    const queue = new Scheduler();
    queue.add({
      run: () => {
        result = 1;
      },
    });
    queue.add(wrapTask(async () => fixture));

    expect(queue.size).toEqual(0);
    expect(queue.pendingCount).toEqual(2);
    expect(result).toEqual(1);
  });

  test('.add() respects limited concurrency', () => {
    const queue = new Scheduler({ concurrency: 2 });
    queue.add(async () => fixture);
    queue.add(wrapTask(async () => delay(50).then(() => fixture)));
    queue.add(wrapTask(async () => fixture));

    expect(queue.size).toEqual(1);
    expect(queue.pendingCount).toEqual(2);
  });

  test('.add() supports priorities', async () => {
    const result: number[] = [];
    const queue = new Scheduler({ concurrency: 1 });
    queue.add(wrapTask(async () => result.push(0)), { priority: 0 });
    queue.add(wrapTask(async () => result.push(1)), { priority: 1 });
    queue.add(wrapTask(async () => result.push(2)), { priority: 1 });
    queue.add(wrapTask(async () => result.push(3)), { priority: 2 });

    await new Promise<void>(resolve => queue.onIdle(resolve));
    expect(result).toEqual([0, 3, 1, 2]);
  });

  test('onTaskDone surfaces task errors', async () => {
    const queue = new Scheduler({ concurrency: 2 });
    const task = { run: () => Promise.reject(new Error('error')) };

    const result = await new Promise<{ err: Error; task: unknown }>(resolve => {
      queue.onTaskDone((err, completedTask) => {
        resolve({ err: err!, task: completedTask });
      });
      queue.add(task);
    });

    expect(result.err.message).toEqual('error');
    expect(result.task).toBe(task);
  });

  test('autoStart false defers execution until start()', () => {
    const queue = new Scheduler({ concurrency: 2, autoStart: false });

    queue.add(wrapTask(() => delay(100)));
    queue.add(wrapTask(() => delay(100)));
    queue.add(wrapTask(() => delay(100)));

    expect(queue.size).toEqual(3);
    expect(queue.pendingCount).toEqual(0);
    expect(queue.isRunning).toEqual(false);

    queue.start();
    expect(queue.pendingCount).toEqual(2);
    expect(queue.isRunning).toEqual(true);
  });

  test('constructor validates concurrency', () => {
    expect(() => new Scheduler({ concurrency: 0 })).toThrow(TypeError);
    expect(() => new Scheduler({ concurrency: 1 })).not.toThrow();
    expect(() => new Scheduler({ concurrency: Infinity })).not.toThrow();
  });
});
