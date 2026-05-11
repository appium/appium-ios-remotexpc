import { expect } from 'chai';
import esmock from 'esmock';
import { EventEmitter } from 'node:events';

interface KillCall {
  pid: number;
  sig: NodeJS.Signals | number | undefined;
}

interface SpawnCall {
  cmd: string;
  args: string[];
}

describe('RemotedController', function () {
  const originalPlatform = process.platform;
  const originalKill = process.kill;

  let killCalls: KillCall[];
  let spawnCalls: SpawnCall[];
  let killImpl:
    | ((pid: number, sig: NodeJS.Signals | number | undefined) => boolean)
    | null;

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
  }

  beforeEach(function () {
    killCalls = [];
    spawnCalls = [];
    killImpl = null;
    process.kill = ((pid: number, sig: NodeJS.Signals | number | undefined) => {
      killCalls.push({ pid, sig });
      if (killImpl) {
        return killImpl(pid, sig);
      }
      return true;
    }) as typeof process.kill;
  });

  afterEach(function () {
    process.kill = originalKill;
    setPlatform(originalPlatform);
  });

  function makeFakeSpawn(stdoutText: string) {
    return (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      const stdout = new EventEmitter();
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
      };
      child.stdout = stdout;
      setImmediate(() => {
        if (stdoutText) {
          stdout.emit('data', Buffer.from(stdoutText));
        }
        child.emit('exit', 0);
      });
      return child;
    };
  }

  async function loadController(stdoutText: string) {
    return esmock<
      typeof import('../../../src/lib/apple-tv/tunnel/remoted-controller.js')
    >('../../../src/lib/apple-tv/tunnel/remoted-controller.js', {
      'node:child_process': { spawn: makeFakeSpawn(stdoutText) },
    });
  }

  it('is a no-op on non-darwin platforms', async function () {
    setPlatform('linux');
    const { RemotedController } = await loadController('1234\n');
    const controller = new RemotedController();
    await controller.suspendIfRequired();
    expect(killCalls).to.have.lengthOf(0);
    expect(spawnCalls).to.have.lengthOf(0);
  });

  it('looks up `remoted` via `pgrep -x remoted`', async function () {
    setPlatform('darwin');
    const { RemotedController } = await loadController('5678\n');
    const controller = new RemotedController();
    await controller.suspendIfRequired();
    expect(spawnCalls).to.deep.equal([
      { cmd: 'pgrep', args: ['-x', 'remoted'] },
    ]);
  });

  it('skips suspend when remoted is not running', async function () {
    setPlatform('darwin');
    const { RemotedController } = await loadController('');
    const controller = new RemotedController();
    await controller.suspendIfRequired();
    expect(killCalls).to.have.lengthOf(0);
  });

  it('SIGSTOPs remoted on darwin when running', async function () {
    setPlatform('darwin');
    const { RemotedController } = await loadController('5678\n');
    const controller = new RemotedController();
    await controller.suspendIfRequired();
    expect(killCalls).to.deep.equal([{ pid: 5678, sig: 'SIGSTOP' }]);
  });

  it('SIGCONTs remoted on resume after a successful suspend', async function () {
    setPlatform('darwin');
    const { RemotedController } = await loadController('5678\n');
    const controller = new RemotedController();
    await controller.suspendIfRequired();
    controller.resumeIfRequired();
    expect(killCalls).to.deep.equal([
      { pid: 5678, sig: 'SIGSTOP' },
      { pid: 5678, sig: 'SIGCONT' },
    ]);
  });

  it('does not record a suspended pid when SIGSTOP throws EPERM', async function () {
    setPlatform('darwin');
    const { RemotedController } = await loadController('5678\n');
    killImpl = () => {
      const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    };
    const controller = new RemotedController();
    await controller.suspendIfRequired();
    expect(killCalls).to.deep.equal([{ pid: 5678, sig: 'SIGSTOP' }]);
    controller.resumeIfRequired();
    expect(killCalls).to.deep.equal([{ pid: 5678, sig: 'SIGSTOP' }]);
  });

  it('suspendIfRequired is idempotent', async function () {
    setPlatform('darwin');
    const { RemotedController } = await loadController('5678\n');
    const controller = new RemotedController();
    await controller.suspendIfRequired();
    await controller.suspendIfRequired();
    expect(killCalls).to.deep.equal([{ pid: 5678, sig: 'SIGSTOP' }]);
    expect(spawnCalls).to.have.lengthOf(1);
  });

  it('resumeIfRequired is safe to call multiple times', async function () {
    setPlatform('darwin');
    const { RemotedController } = await loadController('5678\n');
    const controller = new RemotedController();
    await controller.suspendIfRequired();
    controller.resumeIfRequired();
    controller.resumeIfRequired();
    controller.resumeIfRequired();
    expect(killCalls).to.deep.equal([
      { pid: 5678, sig: 'SIGSTOP' },
      { pid: 5678, sig: 'SIGCONT' },
    ]);
  });

  it('parses the first numeric line of pgrep output', async function () {
    setPlatform('darwin');
    const { RemotedController } = await loadController('9999\n42\n');
    const controller = new RemotedController();
    await controller.suspendIfRequired();
    expect(killCalls).to.deep.equal([{ pid: 9999, sig: 'SIGSTOP' }]);
  });

  it('treats non-numeric pgrep output as "not running"', async function () {
    setPlatform('darwin');
    const { RemotedController } = await loadController('not-a-pid\n');
    const controller = new RemotedController();
    await controller.suspendIfRequired();
    expect(killCalls).to.have.lengthOf(0);
  });
});
