// Startup helpers: private directories, the per-user single-instance lock and the running-helper check.
import AppKit
import Foundation

/// <home> and <home>/pc-control (0700, must be a real directory owned by this user).
func prepareControlDirectory(_ c: HelperConfig) throws {
    try FileManager.default.createDirectory(atPath: c.home, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    if mkdir(c.controlDir, 0o700) != 0 && errno != EEXIST { throw PosixError(call: "mkdir \(c.controlDir)", code: errno) }
    try requirePrivateDirectory(c.controlDir)
}

/// The path must be a real directory (not a symlink) owned by this user; tightened to 0700.
func requirePrivateDirectory(_ dir: String) throws {
    var st = stat()
    guard lstat(dir, &st) == 0 else { throw PosixError(call: "lstat \(dir)", code: errno) }
    guard (st.st_mode & S_IFMT) == S_IFDIR else { throw HelperError.failed("\(dir) is not a directory") }
    guard st.st_uid == getuid() else { throw HelperError.failed("\(dir) is not owned by the current user") }
    if (st.st_mode & 0o777) != 0o700, chmod(dir, 0o700) != 0 {
        throw PosixError(call: "chmod \(dir)", code: errno)
    }
}

/// ~/Library/Application Support/com.bruce.comm.pccontrol/instance.lock (home from the password database).
func userInstanceLockPath() -> String {
    let support = (userHomeDirectory() as NSString).appendingPathComponent("Library/Application Support")
    return ((support as NSString).appendingPathComponent(bundleIdentifier) as NSString).appendingPathComponent("instance.lock")
}

enum InstanceLock {
    case acquired(Int32)
    case held
    case failed(String)
}

/// Exclusive, non-blocking flock held for the process lifetime: one helper per macOS user, whatever home it serves.
func acquireInstanceLock(_ path: String) -> InstanceLock {
    let dir = (path as NSString).deletingLastPathComponent
    do {
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try requirePrivateDirectory(dir)
    } catch {
        return .failed("\(error)")
    }
    for _ in 0..<3 {
        let fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { return .failed(String(cString: strerror(errno))) }
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            let e = errno
            close(fd)
            return e == EWOULDBLOCK ? .held : .failed(String(cString: strerror(e)))
        }
        // The file we locked must still be the one at `path` (not unlinked/replaced meanwhile).
        var held = stat()
        var onDisk = stat()
        if fstat(fd, &held) == 0, lstat(path, &onDisk) == 0, held.st_dev == onDisk.st_dev, held.st_ino == onDisk.st_ino {
            return .acquired(fd)
        }
        close(fd)
    }
    return .failed("the lock file keeps changing")
}

// MARK: - Another running helper (independent of the lock file, which a same-user process could delete)

struct HelperProcess: Equatable {
    let pid: pid_t
    let startSec: Int
    let startUsec: Int
}

/// Start time of a process (sysctl KERN_PROC_PID), nil when it does not exist.
func processStartTime(_ pid: pid_t) -> (sec: Int, usec: Int)? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0, size >= MemoryLayout<kinfo_proc>.stride,
          info.kp_proc.p_pid == pid else { return nil }
    let t = info.kp_proc.p_un.__p_starttime
    return (Int(t.tv_sec), Int(t.tv_usec))
}

/// The other helper that keeps running: one that started before `own` (same start: the lower pid). Two helpers
/// started together therefore never both quit; the younger one always does.
func olderHelper(own: HelperProcess, others: [HelperProcess]) -> pid_t? {
    others
        .filter { $0.pid != own.pid && ($0.startSec, $0.startUsec, $0.pid) < (own.startSec, own.startUsec, own.pid) }
        .min { ($0.startSec, $0.startUsec, $0.pid) < ($1.startSec, $1.startUsec, $1.pid) }?
        .pid
}

/// Another process of this app (bundle id, via LaunchServices) that started before this one, or nil.
func olderRunningHelper() -> pid_t? {
    let me = getpid()
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).compactMap { app -> HelperProcess? in
        let pid = app.processIdentifier
        guard pid > 0, pid != me, !app.isTerminated, let t = processStartTime(pid) else { return nil }
        return HelperProcess(pid: pid, startSec: t.sec, startUsec: t.usec)
    }
    guard !others.isEmpty else { return nil }
    guard let mine = processStartTime(me) else { return others.map(\.pid).min() } // cannot compare: the other one wins
    return olderHelper(own: HelperProcess(pid: me, startSec: mine.sec, startUsec: mine.usec), others: others)
}
