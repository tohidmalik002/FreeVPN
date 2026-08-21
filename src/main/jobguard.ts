// Windows "kill-on-exit" guard for child processes.
//
// Any PID passed to guardChildProcess() is placed in a Job Object configured
// with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. We hold the job handle open for the
// app's entire lifetime, so when THIS process dies — for ANY reason, including a
// crash or a Task Manager force-kill — the OS closes the handle, the job closes,
// and every guarded child (the OpenVPN tunnel) is terminated with it.
//
// Implemented with koffi (a prebuilt FFI — no native compilation). If koffi or
// kernel32 is unavailable for any reason, this degrades to a no-op and the
// graceful-shutdown paths (before-quit) still tear the tunnel down.
//
// Linux has no equivalent here: openvpn runs as root there (via pkexec, see
// openvpn.ts), so this unprivileged process cannot signal it by PID even if
// it wanted to. Linux instead guards app-exit paths (before-quit, SIGINT,
// SIGTERM — see main.ts) by asking openvpn to stop over its own management
// interface, which needs no special privilege. guardChildProcess() stays a
// no-op there.

let guard: (pid: number) => boolean = () => false;

if (process.platform === 'win32') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const k32 = koffi.load('kernel32.dll');

    const BASIC = koffi.struct('JOBOBJECT_BASIC_LIMIT_INFORMATION', {
      PerProcessUserTimeLimit: 'int64_t',
      PerJobUserTimeLimit: 'int64_t',
      LimitFlags: 'uint32_t',
      MinimumWorkingSetSize: 'size_t',
      MaximumWorkingSetSize: 'size_t',
      ActiveProcessLimit: 'uint32_t',
      Affinity: 'uintptr_t',
      PriorityClass: 'uint32_t',
      SchedulingClass: 'uint32_t',
    });
    const IO = koffi.struct('IO_COUNTERS', {
      ReadOperationCount: 'uint64_t',
      WriteOperationCount: 'uint64_t',
      OtherOperationCount: 'uint64_t',
      ReadTransferCount: 'uint64_t',
      WriteTransferCount: 'uint64_t',
      OtherTransferCount: 'uint64_t',
    });
    const EXT = koffi.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
      BasicLimitInformation: BASIC,
      IoInfo: IO,
      ProcessMemoryLimit: 'size_t',
      JobMemoryLimit: 'size_t',
      PeakProcessMemoryUsed: 'size_t',
      PeakJobMemoryUsed: 'size_t',
    });

    const CreateJobObjectW = k32.func('CreateJobObjectW', 'void*', ['void*', 'void*']);
    const SetInformationJobObject = k32.func('SetInformationJobObject', 'bool', [
      'void*',
      'int',
      koffi.pointer(EXT),
      'uint32',
    ]);
    const OpenProcess = k32.func('OpenProcess', 'void*', ['uint32', 'bool', 'uint32']);
    const AssignProcessToJobObject = k32.func('AssignProcessToJobObject', 'bool', [
      'void*',
      'void*',
    ]);
    const CloseHandle = k32.func('CloseHandle', 'bool', ['void*']);

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const JobObjectExtendedLimitInformation = 9;
    const PROCESS_TERMINATE = 0x0001;
    const PROCESS_SET_QUOTA = 0x0100;

    const hJob = CreateJobObjectW(null, null);
    if (hJob) {
      const info = {
        BasicLimitInformation: {
          PerProcessUserTimeLimit: 0n,
          PerJobUserTimeLimit: 0n,
          LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
          MinimumWorkingSetSize: 0,
          MaximumWorkingSetSize: 0,
          ActiveProcessLimit: 0,
          Affinity: 0,
          PriorityClass: 0,
          SchedulingClass: 0,
        },
        IoInfo: {
          ReadOperationCount: 0n,
          WriteOperationCount: 0n,
          OtherOperationCount: 0n,
          ReadTransferCount: 0n,
          WriteTransferCount: 0n,
          OtherTransferCount: 0n,
        },
        ProcessMemoryLimit: 0,
        JobMemoryLimit: 0,
        PeakProcessMemoryUsed: 0,
        PeakJobMemoryUsed: 0,
      };
      const ok = SetInformationJobObject(
        hJob,
        JobObjectExtendedLimitInformation,
        info,
        koffi.sizeof(EXT),
      );
      if (ok) {
        guard = (pid: number): boolean => {
          const h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
          if (!h) return false;
          const assigned = AssignProcessToJobObject(hJob, h);
          CloseHandle(h);
          return !!assigned;
        };
        // Intentionally never CloseHandle(hJob): keeping it open for the whole
        // app lifetime is exactly what arms kill-on-close.
      }
    }
  } catch {
    // koffi/kernel32 unavailable → guard stays a no-op.
  }
}

/** Tie a child PID's lifetime to this process. Returns true if the guard armed. */
export function guardChildProcess(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    return guard(pid);
  } catch {
    return false;
  }
}
