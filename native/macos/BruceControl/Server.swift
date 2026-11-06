// Unix stream socket server: NDJSON requests, one serial queue per connection, peer uid check.
import Darwin
import Foundation

/// Handles one request line (without the newline) and returns exactly one response line (without the newline).
/// `peerPid` is the connecting process (LOCAL_PEERPID), -1 when unknown; it goes into the audit log line.
protocol RequestHandler: AnyObject {
    func handle(line: [UInt8], peerPid: Int32) -> String
}

private func makeSockAddr(_ path: String) throws -> sockaddr_un {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    let capacity = MemoryLayout.size(ofValue: addr.sun_path)
    guard bytes.count < capacity else { throw HelperError.failed("socket path too long (\(bytes.count) bytes): \(path)") }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        raw.copyBytes(from: bytes)
        raw[bytes.count] = 0
    }
    addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    return addr
}

/// Thrown by bindAndListen when a live helper already accepts connections on the path (it is never replaced).
struct SocketInUse: Error, CustomStringConvertible {
    let path: String
    var description: String { "\(path) already accepts connections (another helper serves it)" }
}

/// Only processes of this user may talk to the helper (LOCAL_PEERCRED uid; unknown = refused).
func peerAllowed(_ uid: uid_t?, own: uid_t = getuid()) -> Bool {
    guard let uid else { return false }
    return uid == own
}

/// uid of the connected peer via LOCAL_PEERCRED, nil if unavailable.
func peerUID(_ fd: Int32) -> uid_t? {
    var cred = xucred()
    var len = socklen_t(MemoryLayout<xucred>.size)
    let rc = withUnsafeMutablePointer(to: &cred) { getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, $0, &len) }
    guard rc == 0, cred.cr_version == XUCRED_VERSION else { return nil }
    return cred.cr_uid
}

/// pid of the connected peer via LOCAL_PEERPID, nil if unavailable.
func peerPID(_ fd: Int32) -> pid_t? {
    var pid: pid_t = 0
    var len = socklen_t(MemoryLayout<pid_t>.size)
    let rc = withUnsafeMutablePointer(to: &pid) { getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, $0, &len) }
    guard rc == 0, pid > 0 else { return nil }
    return pid
}

final class SocketServer {
    static let maxConnections = 32

    let path: String
    private var listenFD: Int32 = -1
    private var socketInode: ino_t = 0
    private let slotLock = NSLock()
    private var activeConnections = 0
    private var nextConnectionId = 0

    init(path: String) { self.path = path }

    /// True if a live helper already accepts connections on `path`.
    static func anotherInstanceRunning(path: String) -> Bool {
        guard var addr = try? makeSockAddr(path) else { return false }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        return rc == 0
    }

    /// Removes a stale socket file, binds (0600) and listens. Throws SocketInUse when a live helper answers on the
    /// path: its socket is never unlinked.
    func bindAndListen() throws {
        var addr = try makeSockAddr(path)
        var st = stat()
        if lstat(path, &st) == 0 {
            guard (st.st_mode & S_IFMT) == S_IFSOCK else {
                throw HelperError.failed("\(path) exists and is not a socket; refusing to replace it")
            }
            if Self.anotherInstanceRunning(path: path) { throw SocketInUse(path: path) }
            unlink(path)
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw PosixError(call: "socket", code: errno) }
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        let oldMask = umask(0o177)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        let bindErr = errno
        umask(oldMask)
        guard rc == 0 else {
            close(fd)
            throw PosixError(call: "bind", code: bindErr)
        }
        chmod(path, 0o600)
        if lstat(path, &st) == 0 { socketInode = st.st_ino }
        guard listen(fd, 16) == 0 else {
            let e = errno
            close(fd)
            unlink(path)
            throw PosixError(call: "listen", code: e)
        }
        listenFD = fd
    }

    /// Accept loop on a dedicated background thread.
    func startAccepting(_ handler: RequestHandler) {
        let fd = listenFD
        let thread = Thread { [weak self] in
            while true {
                let cfd = accept(fd, nil, nil)
                if cfd < 0 {
                    let e = errno
                    if e == EINTR || e == ECONNABORTED { continue }
                    if e == EBADF || e == EINVAL { break }
                    logLine("accept failed: \(String(cString: strerror(e)))")
                    usleep(100_000)
                    continue
                }
                guard let self else {
                    close(cfd)
                    break
                }
                self.admit(cfd, handler)
            }
        }
        thread.name = "BruceControl.accept"
        thread.start()
    }

    private func admit(_ cfd: Int32, _ handler: RequestHandler) {
        _ = fcntl(cfd, F_SETFD, FD_CLOEXEC)
        var one: Int32 = 1
        setsockopt(cfd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        let pid = peerPID(cfd) ?? -1
        guard peerAllowed(peerUID(cfd)) else {
            logLine("rejected connection: peer uid does not match (peer_pid=\(pid))")
            close(cfd)
            return
        }
        slotLock.lock()
        if activeConnections >= Self.maxConnections {
            slotLock.unlock()
            logLine("rejected connection: too many open connections (peer_pid=\(pid))")
            close(cfd)
            return
        }
        activeConnections += 1
        nextConnectionId += 1
        let connId = nextConnectionId
        slotLock.unlock()
        let conn = Connection(fd: cfd, id: connId, peerPid: pid, handler: handler) { [weak self] in
            guard let self else { return }
            self.slotLock.lock()
            self.activeConnections -= 1
            self.slotLock.unlock()
        }
        conn.start()
    }

    /// Stops listening and removes the socket file if it is still ours.
    func stop() {
        if listenFD >= 0 {
            close(listenFD)
            listenFD = -1
        }
        var st = stat()
        if socketInode != 0, lstat(path, &st) == 0, st.st_ino == socketInode {
            unlink(path)
        }
    }
}

/// One client connection; requests are answered strictly in order on its own serial queue.
private final class Connection {
    private let fd: Int32
    private let peerPid: Int32
    private let queue: DispatchQueue
    private let handler: RequestHandler
    private let onClose: () -> Void

    init(fd: Int32, id: Int, peerPid: Int32, handler: RequestHandler, onClose: @escaping () -> Void) {
        self.fd = fd
        self.peerPid = peerPid
        self.queue = DispatchQueue(label: "BruceControl.conn.\(id)", qos: .userInitiated)
        self.handler = handler
        self.onClose = onClose
    }

    func start() {
        queue.async { self.run() }
    }

    private func run() {
        defer {
            close(fd)
            onClose()
        }
        var buffer = [UInt8]()
        buffer.reserveCapacity(65536)
        var start = 0 // first unconsumed byte
        var scan = 0 // where the newline search resumes
        var chunk = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n < 0 {
                if errno == EINTR { continue }
                return
            }
            if n == 0 {
                // EOF: answer a final unterminated line, if any.
                if start < buffer.count {
                    let rest = Array(buffer[start...])
                    if rest.count > maxRequestLineBytes { _ = sendLineTooLong(); return }
                    _ = process(rest)
                }
                return
            }
            buffer.append(contentsOf: chunk[0..<n])
            while scan < buffer.count, let nl = buffer[scan...].firstIndex(of: 0x0A) {
                let line = Array(buffer[start..<nl])
                start = nl + 1
                scan = start
                if line.count > maxRequestLineBytes {
                    _ = sendLineTooLong()
                    return
                }
                guard process(line) else { return }
            }
            scan = buffer.count
            if buffer.count - start > maxRequestLineBytes {
                _ = sendLineTooLong()
                return
            }
            if start > 0 {
                buffer.removeSubrange(0..<start)
                scan -= start
                start = 0
            }
        }
    }

    /// Handles one line; returns false when the peer is gone.
    private func process(_ raw: [UInt8]) -> Bool {
        var line = raw
        if line.last == 0x0D { line.removeLast() }
        if line.allSatisfy({ $0 == 0x20 || $0 == 0x09 }) { return true }
        let response = handler.handle(line: line, peerPid: peerPid)
        return send(response)
    }

    private func sendLineTooLong() -> Bool {
        logLine("request line exceeds 1 MiB; closing connection")
        return send("{\"id\":\"\",\"ok\":false,\"error\":{\"code\":\"invalid_argument\",\"message\":\"request line exceeds 1 MiB\"}}")
    }

    private func send(_ response: String) -> Bool {
        var bytes = Array(response.utf8)
        bytes.append(0x0A)
        return bytes.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return true }
            var off = 0
            while off < raw.count {
                let n = write(fd, base + off, raw.count - off)
                if n < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                off += n
            }
            return true
        }
    }
}
