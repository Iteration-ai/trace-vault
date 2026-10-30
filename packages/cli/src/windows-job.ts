// The task host joins the job before spawning Node. Every descendant inherits
// it, so ending the task closes the last handle and kills only its own tree.
export const windowsJobDefinition = `
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
public static class IterationProcessJob {
  public static void RunSupervisor(ProcessStartInfo start) {
    start.RedirectStandardError = true;
    using (Process process = Process.Start(start)) {
      Task<string> errors = Task.Run(() => {
        byte[] buffer = new byte[8192], tail = new byte[8192];
        int used = 0;
        try {
          int count;
          while ((count = process.StandardError.BaseStream.Read(buffer, 0, buffer.Length)) != 0) {
            int retained = Math.Min(used, tail.Length - count);
            Buffer.BlockCopy(tail, used - retained, tail, 0, retained);
            Buffer.BlockCopy(buffer, 0, tail, retained, count);
            used = retained + count;
          }
          return Encoding.UTF8.GetString(tail, 0, used);
        } catch {
          if (!process.HasExited) process.Kill();
          throw;
        }
      });
      process.WaitForExit();
      string detail = errors.GetAwaiter().GetResult();
      if (process.ExitCode != 0) {
        throw new InvalidOperationException("Node supervisor exited with code " + process.ExitCode + ": " + detail);
      }
    }
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr information, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static IntPtr OwnProcessTree() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var limits = new ExtendedLimits();
    limits.Basic.Flags = 0x2000;
    int size = Marshal.SizeOf(limits);
    IntPtr information = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(limits, information, false);
      if (!SetInformationJobObject(job, 9, information, (uint)size) || !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle)) {
        int error = Marshal.GetLastWin32Error();
        CloseHandle(job);
        throw new Win32Exception(error);
      }
      return job;
    } finally { Marshal.FreeHGlobal(information); }
  }
}
`;
