#!/usr/bin/env python3
"""Transactional remote push helper. Python 3.8 stdlib only.

The caller supplies one canonical-base64 encoded JSON object as argv[1].  The
workspace, archive and manifest are uploaded by the transport; this program is
the only component allowed to mutate the target home.
"""

import base64
import errno
import fcntl
import gzip
import hashlib
import hmac
import json
import os
import select
import signal
import stat
import subprocess
import sys
import tarfile
import time

VERSION = 1
SAFE_NAME = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+@-")
TERMINAL = ("committed", "aborted", "cancelled")
ACTIVE_WORKSPACE_FD = None
ACTIVE_CHILD = None
BACKUP_KEEP = 5
MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024
MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024
MAX_MEMBER_BYTES = 1024 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 100000
MAX_PATH_DEPTH = 64
MAX_PATH_BYTES = 4096
MAX_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_STATE_BYTES = 64 * 1024 * 1024
MAX_ACTIONS = 100000
MAX_TAR_STREAM_BYTES = MAX_DECOMPRESSED_BYTES + 64 * 1024 * 1024
MAX_TAR_METADATA_BYTES = 64 * 1024 * 1024
MAX_PLUGIN_COMMAND_BYTES = 512 * 1024 * 1024
MAX_PLUGIN_LIST_BYTES = 4 * 1024 * 1024
PLUGIN_LIST_TIMEOUT_SECONDS = 15
PLUGIN_PIPE_DRAIN_SECONDS = 1


class Blocked(Exception):
    pass


class Cancelled(Exception):
    pass


class BoundedStream:
    def __init__(self, source, limit, metadata_limit):
        self.source = source
        self.limit = limit
        self.metadata_limit = metadata_limit
        self.total = 0
        self.metadata = True
        self.metadata_total = 0

    def read(self, size=-1):
        check_cancelled()
        maximum = self.limit - self.total + 1
        if size < 0 or size > maximum:
            size = maximum
        data = self.source.read(size)
        self.total += len(data)
        if self.metadata:
            self.metadata_total += len(data)
        if self.total > self.limit:
            fail("raw decompressed tar stream exceeds limit")
        if self.metadata_total > self.metadata_limit:
            fail("tar metadata exceeds limit")
        return data


def bounded_members(tf, stream):
    iterator = iter(tf)
    while True:
        stream.metadata = True
        try:
            member = next(iterator)
        except StopIteration:
            return
        finally:
            stream.metadata = False
        yield member


def terminate_plugin(process):
    process_group = process.pid
    try:
        os.killpg(process_group, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            os.killpg(process_group, 0)
        except (ProcessLookupError, PermissionError):
            break
        time.sleep(0.05)
    else:
        try:
            os.killpg(process_group, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    process.wait()


def signal_handler(signum, _frame):
    if ACTIVE_CHILD is not None:
        terminate_plugin(ACTIVE_CHILD)
    raise Cancelled("helper interrupted by signal %d" % signum)


def start_plugin(argv, stdout=None):
    global ACTIVE_CHILD
    options = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL if stdout is None else stdout,
               "stderr": subprocess.DEVNULL, "start_new_session": True}
    process = subprocess.Popen(argv, **options)
    ACTIVE_CHILD = process
    return process


def wait_plugin(process, cancellable=True):
    global ACTIVE_CHILD
    try:
        while process.poll() is None:
            if cancellable:
                try:
                    check_cancelled()
                except Cancelled:
                    terminate_plugin(process)
                    raise
            time.sleep(0.05)
        process.wait()
    finally:
        if process.poll() is None:
            terminate_plugin(process)
        ACTIVE_CHILD = None


def wait_plugin_output(process, limit):
    global ACTIVE_CHILD
    chunks = []
    size = 0
    stream = process.stdout
    if stream is None:
        fail("plugin output pipe is absent")
    fd = stream.fileno()
    os.set_blocking(fd, False)
    deadline = time.monotonic() + PLUGIN_LIST_TIMEOUT_SECONDS
    exited_at = None
    try:
        while True:
            if time.monotonic() > deadline:
                terminate_plugin(process)
                fail("Codex plugin reconciliation timed out")
            ready, _, _ = select.select([fd], [], [], 0.05)
            if ready:
                while True:
                    try:
                        chunk = os.read(fd, 1024 * 1024)
                    except BlockingIOError:
                        break
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > limit:
                        terminate_plugin(process)
                        fail("Codex plugin reconciliation output exceeds limit")
                    chunks.append(chunk)
            if process.poll() is not None:
                if exited_at is None:
                    exited_at = time.monotonic()
                while True:
                    try:
                        chunk = os.read(fd, 1024 * 1024)
                    except BlockingIOError:
                        break
                    if not chunk:
                        process.wait()
                        return b"".join(chunks)
                    size += len(chunk)
                    if size > limit:
                        fail("Codex plugin reconciliation output exceeds limit")
                    chunks.append(chunk)
                if time.monotonic() - exited_at > PLUGIN_PIPE_DRAIN_SECONDS:
                    terminate_plugin(process)
                    fail("Codex plugin reconciliation pipe remained open")
    finally:
        if process.poll() is None:
            terminate_plugin(process)
        stream.close()
        ACTIVE_CHILD = None


def check_cancelled():
    if ACTIVE_WORKSPACE_FD is not None:
        try:
            marker = os.stat("cancel", dir_fd=ACTIVE_WORKSPACE_FD, follow_symlinks=False)
            if not stat.S_ISREG(marker.st_mode):
                fail("unsafe cancel marker")
            raise Cancelled("transaction cancelled")
        except FileNotFoundError:
            pass


def fail(message):
    raise Blocked(message)


def decode_request(value):
    try:
        if not value or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=" for c in value):
            fail("invalid request encoding")
        raw = base64.b64decode(value, validate=True)
        if base64.b64encode(raw).decode("ascii") != value:
            fail("request encoding is not canonical base64")
        obj = json.loads(raw.decode("utf-8"))
        if not isinstance(obj, dict) or raw != canonical(obj):
            fail("request is not canonical JSON")
        return obj
    except (ValueError, UnicodeError, json.JSONDecodeError):
        fail("invalid request")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def same_object(first, second):
    return first.st_dev == second.st_dev and first.st_ino == second.st_ino


def absolute_parts(path, label):
    if not isinstance(path, str) or not path.startswith("/") or "//" in path or "\x00" in path:
        fail("invalid %s" % label)
    parts = path.split("/")[1:]
    if not parts or any(not safe_component(part) for part in parts):
        fail("invalid %s" % label)
    if len(parts) > MAX_PATH_DEPTH or len(path.encode("utf-8")) > MAX_PATH_BYTES:
        fail("%s exceeds path limits" % label)
    return parts


def open_absolute_directory(path, label, private=False):
    parts = absolute_parts(path, label)
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0))
    try:
        for index, name in enumerate(parts):
            before = os.stat(name, dir_fd=fd, follow_symlinks=False)
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=fd)
            after = os.fstat(child)
            if not same_object(before, after) or not stat.S_ISDIR(after.st_mode):
                os.close(child)
                fail("%s ancestry changed" % label)
            if after.st_uid not in (0, os.geteuid()):
                os.close(child)
                fail("unsafe %s owner" % label)
            writable = stat.S_IMODE(after.st_mode) & 0o022
            if writable and not (after.st_mode & stat.S_ISVTX):
                os.close(child)
                fail("unsafe %s ancestry mode" % label)
            os.close(fd)
            fd = child
            if index == len(parts) - 1:
                if after.st_uid != os.geteuid():
                    fail("unsafe %s owner" % label)
                if private and stat.S_IMODE(after.st_mode) & 0o077:
                    fail("unsafe %s mode" % label)
        return fd
    except Exception:
        os.close(fd)
        raise


def hash_fd(fd, limit):
    value = hashlib.sha256()
    size = 0
    while True:
        check_cancelled()
        chunk = os.read(fd, min(1024 * 1024, limit + 1 - size))
        if not chunk:
            return value.hexdigest()
        size += len(chunk)
        if size > limit:
            fail("file exceeds limit")
        value.update(chunk)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify_runtime(req):
    expected = req.get("helperSha256")
    python_path = req.get("pythonPath")
    if not isinstance(expected, str) or len(expected) != 64:
        fail("missing helper checksum")
    if not isinstance(python_path, str) or python_path != sys.executable:
        fail("unexpected Python interpreter")
    helper_path = os.path.abspath(__file__)
    parent_fd = open_absolute_directory(os.path.dirname(helper_path), "helper parent")
    try:
        name = os.path.basename(helper_path)
        before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        fd = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd)
        try:
            if (not same_object(before, os.fstat(fd)) or
                    not hmac.compare_digest(hash_fd(fd, 1024 * 1024), expected)):
                fail("helper checksum mismatch")
        finally:
            os.close(fd)
    finally:
        os.close(parent_fd)


def open_executable(path):
    # The adapter must seal the resolved command path. Symlink traversal here
    # would reintroduce a path-swap race between observation and pinning.
    parts = absolute_parts(path, "plugin command")
    try:
        parent_fd = (open_absolute_directory("/" + "/".join(parts[:-1]), "plugin command parent")
                     if parts[:-1] else os.open("/", os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)))
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            fail("Codex command must be a resolved executable regular file")
        raise
    try:
        before = os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False)
        try:
            fd = os.open(parts[-1], os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd)
        except OSError as error:
            if error.errno in (errno.ELOOP, errno.ENOTDIR):
                fail("Codex command must be a resolved executable regular file")
            raise
        try:
            current = os.fstat(fd)
            if (not same_object(before, current) or not stat.S_ISREG(current.st_mode) or
                    not current.st_mode & 0o111):
                fail("Codex command must be a resolved executable regular file")
            if current.st_size > MAX_PLUGIN_COMMAND_BYTES:
                fail("Codex command exceeds pinning limit")
            return fd
        except Exception:
            os.close(fd)
            raise
    finally:
        os.close(parent_fd)


def pin_executable(home_fd, token, index, path):
    source = open_executable(path)
    state_fd = descend(home_fd, [transaction_state_name(token)])
    name = "plugin-%06d" % index
    output = None
    try:
        output = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                         0o700, dir_fd=state_fd)
        value = hashlib.sha256()
        size = 0
        while True:
            check_cancelled()
            chunk = os.read(source, 1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_PLUGIN_COMMAND_BYTES:
                fail("Codex command exceeds pinning limit")
            value.update(chunk)
            write_all(output, chunk)
        os.fchmod(output, 0o700)
        os.fsync(output)
        os.close(output)
        output = None
        os.fsync(state_fd)
        return {"pinned": name, "sha256": value.hexdigest()}
    finally:
        if output is not None:
            os.close(output)
        os.close(source)
        os.close(state_fd)


def start_pinned_plugin(home_fd, token, record, arguments, stdout=None):
    # The pinned path lives in a helper-created 0700 HOME directory and its
    # bytes are reverified immediately before exec. Workspace-only attackers
    # cannot replace it; same-UID hostile processes are explicitly out of
    # scope because no filesystem protocol can isolate peers with equal UID.
    state_fd = descend(home_fd, [transaction_state_name(token)])
    try:
        fd = os.open(record["pinned"], os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=state_fd)
        try:
            current = os.fstat(fd)
            if (not stat.S_ISREG(current.st_mode) or not current.st_mode & 0o111 or
                    not hmac.compare_digest(hash_fd(fd, MAX_PLUGIN_COMMAND_BYTES), record["sha256"])):
                fail("pinned Codex command changed")
            return start_plugin([record["pinnedPath"]] + arguments, stdout=stdout)
        finally:
            os.close(fd)
    finally:
        os.close(state_fd)


def plugin_is_installed(home_fd, token, record, plugin_id):
    process = start_pinned_plugin(home_fd, token, record,
                                  ["plugin", "list", "--available", "--json"],
                                  stdout=subprocess.PIPE)
    try:
        raw = wait_plugin_output(process, MAX_PLUGIN_LIST_BYTES)
        if process.returncode:
            fail("Codex plugin reconciliation failed; retained backups preserved")
        try:
            parsed = json.loads(raw.decode("utf-8"))
            if not isinstance(parsed, dict) or set(parsed) != set(("installed", "available")):
                raise ValueError("invalid plugin list object")
            ids_by_status = {}
            for field, expected_installed in (("installed", True), ("available", False)):
                items = parsed[field]
                if not isinstance(items, list):
                    raise ValueError("invalid plugin list array")
                ids = []
                for item in items:
                    plugin = item.get("pluginId") if isinstance(item, dict) else None
                    installed_flag = item.get("installed") if isinstance(item, dict) else None
                    if (not isinstance(plugin, str) or not plugin or len(plugin.encode("utf-8")) > 512 or
                            any(ord(char) < 32 or ord(char) == 127 for char in plugin) or
                            not isinstance(installed_flag, bool) or installed_flag is not expected_installed):
                        raise ValueError("invalid plugin list entry")
                    ids.append(plugin)
                if len(ids) != len(set(ids)):
                    raise ValueError("duplicate plugin list entry")
                ids_by_status[field] = set(ids)
            if ids_by_status["installed"] & ids_by_status["available"]:
                raise ValueError("plugin list statuses overlap")
        except (KeyError, ValueError, UnicodeError, json.JSONDecodeError):
            fail("invalid Codex plugin reconciliation output")
        return plugin_id in ids_by_status["installed"]
    finally:
        if process.poll() is None:
            terminate_plugin(process)


def safe_component(name):
    return bool(name) and name not in (".", "..") and len(name.encode()) <= 255 and all(c in SAFE_NAME for c in name)


def logical_parts(logical):
    if not isinstance(logical, str):
        fail("invalid logical path")
    parts = logical.split("/")
    if len(parts) < 2 or parts[0] not in ("claude", "codex", "shared") or not all(safe_component(x) for x in parts):
        fail("invalid logical path")
    if parts[0] == "shared" and (len(parts) < 3 or parts[1] != "agents"):
        fail("invalid shared path")
    return parts


def live_parts(logical):
    parts = logical_parts(logical)
    if parts[0] == "claude":
        return [".claude"] + parts[1:]
    if parts[0] == "codex":
        return [".codex"] + parts[1:]
    return [".agents"] + parts[2:]


def open_home(home):
    return open_absolute_directory(home, "HOME")


def descend(root_fd, parts, create=False):
    fd = os.dup(root_fd)
    try:
        for name in parts:
            if not safe_component(name):
                fail("unsafe path component")
            try:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(name, 0o700, dir_fd=fd)
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except Exception:
        os.close(fd)
        raise


def atomic_write(parent_fd, name, data, mode=0o600):
    if not safe_component(name):
        fail("unsafe filename")
    token = hashlib.sha256(os.urandom(32)).hexdigest()[:16]
    temp = ".ccm-" + token
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode, dir_fd=parent_fd)
    try:
        write_all(fd, data)
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        try:
            st = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISREG(st.st_mode):
                fail("destination has incompatible type")
        except FileNotFoundError:
            pass
        os.replace(temp, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        os.fsync(parent_fd)
    except Exception:
        try:
            os.unlink(temp, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        raise


def state_mac(state, secret):
    return hmac.new(secret, canonical(state), hashlib.sha256).hexdigest()


def load_state(workspace_fd):
    raw = read_fd_file(workspace_fd, "state.json", MAX_STATE_BYTES)
    envelope = json.loads(raw.decode())
    if canonical(envelope) != raw:
        fail("transaction state is not canonical")
    if not isinstance(envelope, dict) or set(envelope) != set(("payload", "sha256")):
        fail("invalid transaction state envelope")
    value = envelope.get("payload")
    if not isinstance(value, dict) or value.get("version") != VERSION or not isinstance(envelope.get("sha256"), str):
        fail("invalid transaction state")
    return value, envelope["sha256"]


def save_state(workspace_fd, state, secret):
    encoded = canonical({"payload": state, "sha256": state_mac(state, secret)})
    if len(encoded) > MAX_STATE_BYTES:
        fail("transaction state exceeds limit")
    atomic_write(workspace_fd, "state.json", encoded)


def validate_workspace(path):
    return open_absolute_directory(path, "workspace", private=True)


def transaction_state_name(token):
    return ".ccm-push-state-" + token


def retired_transaction_state_name(token):
    return ".ccm-push-state-retired-" + token


def create_transaction_state(home_fd, token):
    name = transaction_state_name(token)
    try:
        os.stat(retired_transaction_state_name(token), dir_fd=home_fd, follow_symlinks=False)
        fail("retired transaction state already exists")
    except FileNotFoundError:
        pass
    os.mkdir(name, 0o700, dir_fd=home_fd)
    state_fd = descend(home_fd, [name])
    secret = os.urandom(32)
    try:
        atomic_write(state_fd, "secret", secret)
        os.fsync(state_fd)
    finally:
        os.close(state_fd)
    os.fsync(home_fd)
    return secret


def transaction_secret(home_fd, token):
    state_fd = descend(home_fd, [transaction_state_name(token)])
    try:
        secret = read_fd_file(state_fd, "secret", 32)
        if len(secret) != 32:
            fail("invalid transaction authentication secret")
        return secret
    finally:
        os.close(state_fd)


def remove_transaction_state(home_fd, token):
    remove_tree_at(home_fd, transaction_state_name(token), cancellable=False)
    os.fsync(home_fd)


def cleanup_tombstone(home_fd, token, workspace, workspace_identity, secret):
    state_fd = descend(home_fd, [transaction_state_name(token)])
    payload = {"token": token, "workspace": workspace, "workspaceIdentity": workspace_identity}
    try:
        atomic_write(state_fd, "cleanup.json",
                     canonical({"payload": payload, "sha256": hmac.new(secret, canonical(payload), hashlib.sha256).hexdigest()}))
    finally:
        os.close(state_fd)


def retire_transaction_state(home_fd, token):
    active = transaction_state_name(token)
    retired = retired_transaction_state_name(token)
    try:
        os.rename(active, retired, src_dir_fd=home_fd, dst_dir_fd=home_fd)
        os.fsync(home_fd)
    except FileNotFoundError:
        pass
    remove_tree_at(home_fd, retired, cancellable=False)
    os.fsync(home_fd)


def read_cleanup_tombstone(home_fd, token, workspace):
    secret = transaction_secret(home_fd, token)
    state_fd = descend(home_fd, [transaction_state_name(token)])
    try:
        raw = read_fd_file(state_fd, "cleanup.json", 4096)
    finally:
        os.close(state_fd)
    envelope = json.loads(raw.decode("utf-8"))
    if not isinstance(envelope, dict) or set(envelope) != set(("payload", "sha256")):
        fail("invalid cleanup tombstone")
    payload = envelope["payload"]
    expected = hmac.new(secret, canonical(payload), hashlib.sha256).hexdigest() if isinstance(payload, dict) else ""
    if (canonical(envelope) != raw or not isinstance(envelope["sha256"], str) or
            not hmac.compare_digest(envelope["sha256"], expected) or
            not isinstance(payload, dict) or payload.get("token") != token or
            payload.get("workspace") != workspace):
        fail("invalid cleanup tombstone")
    return payload


def remove_workspace(workspace, workspace_fd):
    parent_fd = open_absolute_directory(os.path.dirname(workspace), "workspace parent")
    try:
        current = os.stat(os.path.basename(workspace), dir_fd=parent_fd, follow_symlinks=False)
        if not same_object(current, os.fstat(workspace_fd)):
            fail("workspace changed before cleanup")
        remove_tree_at(parent_fd, os.path.basename(workspace))
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def cleanup_missing_workspace(req):
    token = req.get("token")
    home = req.get("home")
    workspace = req.get("workspace")
    if not isinstance(token, str) or not isinstance(workspace, str):
        fail("invalid cleanup retry")
    home_fd = open_home(home)
    try:
        retired = retired_transaction_state_name(token)
        try:
            os.stat(retired, dir_fd=home_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            remove_tree_at(home_fd, retired, cancellable=False)
            os.fsync(home_fd)
            return {"status": "cleaned"}
        try:
            active_fd = descend(home_fd, [transaction_state_name(token)])
        except FileNotFoundError:
            return {"status": "cleaned"}
        else:
            os.close(active_fd)
        try:
            read_cleanup_tombstone(home_fd, token, workspace)
        except FileNotFoundError:
            fail("incomplete cleanup authentication state")
        retire_transaction_state(home_fd, token)
        return {"status": "cleaned"}
    finally:
        os.close(home_fd)


def cleanup_partial_workspace(req, workspace_fd):
    token = req.get("token")
    home = req.get("home")
    workspace = req.get("workspace")
    home_fd = open_home(home)
    try:
        payload = read_cleanup_tombstone(home_fd, token, workspace)
        current = os.fstat(workspace_fd)
        if payload.get("workspaceIdentity") != [current.st_dev, current.st_ino]:
            fail("cleanup workspace identity changed")
        try:
            os.unlink("cancel", dir_fd=workspace_fd)
        except FileNotFoundError:
            pass
        release_lock(home_fd, token)
        remove_workspace(workspace, workspace_fd)
        retire_transaction_state(home_fd, token)
        return {"status": "cleaned"}
    finally:
        os.close(home_fd)


def acquire_lock(home_fd, token):
    staged = ".ccm-lock-" + hashlib.sha256(os.urandom(32)).hexdigest()[:16]
    try:
        fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=home_fd)
        try:
            write_all(fd, token.encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.link(staged, ".ccm-push.lock", src_dir_fd=home_fd, dst_dir_fd=home_fd, follow_symlinks=False)
        except FileExistsError:
            fail("another push transaction holds the lock")
        os.unlink(staged, dir_fd=home_fd)
        os.fsync(home_fd)
    except Exception:
        try:
            os.unlink(staged, dir_fd=home_fd)
        except FileNotFoundError:
            pass
        raise


def assert_lock(home_fd, token, allow_absent=False):
    try:
        current = read_fd_file(home_fd, ".ccm-push.lock", 1024)
    except FileNotFoundError:
        if allow_absent:
            return False
        fail("transaction lock is absent")
    if current != token.encode():
        fail("transaction does not own lock")
    return True


def release_lock(home_fd, token):
    try:
        current = read_fd_file(home_fd, ".ccm-push.lock", 1024)
    except FileNotFoundError:
        return
    if current != token.encode():
        fail("transaction does not own lock")
    os.unlink(".ccm-push.lock", dir_fd=home_fd)
    os.fsync(home_fd)


def read_fd_file(parent, name, limit=64 * 1024 * 1024):
    fd = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            fail("expected bounded regular file")
        if st.st_size > limit:
            fail("file exceeds limit")
        return read_open_fd(fd, limit)
    finally:
        os.close(fd)


def read_open_fd(fd, limit):
    data = b""
    while len(data) <= limit:
        chunk = os.read(fd, min(1024 * 1024, limit + 1 - len(data)))
        if not chunk:
            return data
        data += chunk
    fail("file exceeds limit")


def write_all(fd, data):
    view = memoryview(data)
    while view:
        count = os.write(fd, view)
        if count <= 0:
            fail("short write")
        view = view[count:]


def copy_typed_at(source_parent, source_name, target_parent, target_name, kind):
    """Copy a snapshot without resolving either tree through ambient paths."""
    if not safe_component(source_name) or not safe_component(target_name):
        fail("unsafe snapshot name")
    source_stat = os.stat(source_name, dir_fd=source_parent, follow_symlinks=False)
    if kind == "file" and stat.S_ISREG(source_stat.st_mode):
        source = os.open(source_name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=source_parent)
        target = os.open(target_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), stat.S_IMODE(source_stat.st_mode), dir_fd=target_parent)
        try:
            if not same_object(source_stat, os.fstat(source)):
                fail("snapshot changed while opening")
            while True:
                check_cancelled()
                chunk = os.read(source, 1024 * 1024)
                if not chunk:
                    break
                write_all(target, chunk)
            os.fchmod(target, stat.S_IMODE(source_stat.st_mode))
            os.fsync(target)
        finally:
            os.close(source)
            os.close(target)
    elif kind == "symlink" and stat.S_ISLNK(source_stat.st_mode):
        target_value = os.readlink(source_name, dir_fd=source_parent)
        if not same_object(source_stat, os.stat(source_name, dir_fd=source_parent, follow_symlinks=False)):
            fail("snapshot changed while opening")
        os.symlink(target_value, target_name, dir_fd=target_parent)
    elif kind == "directory" and stat.S_ISDIR(source_stat.st_mode):
        os.mkdir(target_name, stat.S_IMODE(source_stat.st_mode), dir_fd=target_parent)
        source = os.open(source_name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=source_parent)
        target = os.open(target_name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=target_parent)
        try:
            if not same_object(source_stat, os.fstat(source)):
                fail("snapshot changed while opening")
            for name in sorted(os.listdir(source)):
                check_cancelled()
                if not safe_component(name):
                    fail("unsafe snapshot entry")
                entry = os.stat(name, dir_fd=source, follow_symlinks=False)
                entry_kind = "symlink" if stat.S_ISLNK(entry.st_mode) else "directory" if stat.S_ISDIR(entry.st_mode) else "file" if stat.S_ISREG(entry.st_mode) else None
                if entry_kind is None:
                    fail("unsupported snapshot entry type")
                copy_typed_at(source, name, target, name, entry_kind)
            os.fchmod(target, stat.S_IMODE(source_stat.st_mode))
            os.fsync(target)
        finally:
            os.close(source)
            os.close(target)
    else:
        fail("snapshot type changed")
    os.fsync(target_parent)


def install_retained_backup(home_fd, parts, backups_fd, source_name, kind):
    if kind == "missing":
        return None
    parent = descend(home_fd, parts[:-1]) if parts[:-1] else os.dup(home_fd)
    try:
        base = parts[-1]
        initial = time.time_ns()
        for counter in range(10000):
            suffix = initial + counter
            name = "%s.backup-%d" % (base, suffix)
            if not safe_component(name):
                fail("retained backup name is too long")
            try:
                copy_typed_at(backups_fd, source_name, parent, name, kind)
                return {"name": name, "type": kind}
            except FileExistsError:
                continue
            except Exception:
                try:
                    remove_tree_at(parent, name, cancellable=False)
                    os.fsync(parent)
                except Exception:
                    pass
                raise
        fail("could not allocate retained backup")
    finally:
        os.close(parent)


def type_matches(st_mode, kind):
    return ((kind == "file" and stat.S_ISREG(st_mode)) or
            (kind == "directory" and stat.S_ISDIR(st_mode)) or
            (kind == "symlink" and stat.S_ISLNK(st_mode)))


def remove_retained(home_fd, record):
    retained = record.get("retained")
    if not retained:
        return
    parent = descend(home_fd, record["parts"][:-1]) if record["parts"][:-1] else os.dup(home_fd)
    try:
        try:
            current = os.stat(retained["name"], dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return
        if not type_matches(current.st_mode, retained["type"]):
            fail("owned retained backup changed type")
        remove_tree_at(parent, retained["name"])
        os.fsync(parent)
    finally:
        os.close(parent)


def prune_retained(home_fd, record):
    retained = record.get("retained")
    if not retained:
        return
    parts = record["parts"]
    parent = descend(home_fd, parts[:-1]) if parts[:-1] else os.dup(home_fd)
    try:
        prefix = parts[-1] + ".backup-"
        candidates = []
        for name in os.listdir(parent):
            if not name.startswith(prefix):
                continue
            suffix = name[len(prefix):]
            if not suffix.isdigit() or not safe_component(name):
                continue
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if type_matches(current.st_mode, retained["type"]):
                candidates.append((int(suffix), name))
        for _, name in sorted(candidates, reverse=True)[BACKUP_KEEP:]:
            remove_tree_at(parent, name)
        os.fsync(parent)
    finally:
        os.close(parent)


def extract_archive(workspace_fd, expected):
    before = os.stat("archive.tar.gz", dir_fd=workspace_fd, follow_symlinks=False)
    archive_fd = os.open("archive.tar.gz", os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=workspace_fd)
    try:
        current = os.fstat(archive_fd)
        if not same_object(before, current) or not stat.S_ISREG(current.st_mode):
            fail("archive changed while opening")
        if not isinstance(expected, str) or not hmac.compare_digest(hash_fd(archive_fd, MAX_ARCHIVE_BYTES), expected):
            fail("archive checksum mismatch")
        os.lseek(archive_fd, 0, os.SEEK_SET)
        os.mkdir("extract", 0o700, dir_fd=workspace_fd)
        extract_fd = descend(workspace_fd, ["extract"])
        inventory = []
        seen = set()
        count = 0
        total = 0
        try:
            with os.fdopen(os.dup(archive_fd), "rb") as archive_file:
                with gzip.GzipFile(fileobj=archive_file, mode="rb") as expanded:
                    bounded = BoundedStream(expanded, MAX_TAR_STREAM_BYTES, MAX_TAR_METADATA_BYTES)
                    with tarfile.open(fileobj=bounded, mode="r|") as tf:
                        for member in bounded_members(tf, bounded):
                            check_cancelled()
                            count += 1
                            if count > MAX_ARCHIVE_MEMBERS:
                                fail("archive member count exceeds limit")
                            raw_name = member.name.rstrip("/")
                            parts = raw_name.split("/")
                            if (not raw_name or member.name.startswith("/") or len(parts) > MAX_PATH_DEPTH or
                                    len(raw_name.encode("utf-8")) > MAX_PATH_BYTES or not all(safe_component(p) for p in parts)):
                                fail("unsafe archive member")
                            logical = "/".join(parts)
                            if logical in seen:
                                fail("duplicate archive member")
                            seen.add(logical)
                            parent = descend(extract_fd, parts[:-1], create=True)
                            try:
                                if member.isdir():
                                    try:
                                        os.mkdir(parts[-1], 0o700, dir_fd=parent)
                                    except FileExistsError:
                                        existing = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                                        if not stat.S_ISDIR(existing.st_mode):
                                            fail("archive member type collision")
                                    child = descend(parent, [parts[-1]])
                                    os.fchmod(child, 0o700)
                                    os.fsync(child)
                                    os.close(child)
                                    inventory.append({"mode": 0o700, "path": logical, "type": "directory"})
                                elif member.isfile():
                                    if member.size < 0 or member.size > MAX_MEMBER_BYTES:
                                        fail("archive member exceeds limit")
                                    total += member.size
                                    if total > MAX_DECOMPRESSED_BYTES:
                                        fail("decompressed archive exceeds limit")
                                    source = tf.extractfile(member)
                                    if source is None:
                                        fail("unreadable archive member")
                                    mode = 0o755 if member.mode & 0o111 else 0o644
                                    output = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=parent)
                                    value = hashlib.sha256()
                                    actual = 0
                                    try:
                                        while True:
                                            check_cancelled()
                                            chunk = source.read(min(1024 * 1024, member.size - actual + 1))
                                            if not chunk:
                                                break
                                            actual += len(chunk)
                                            if actual > member.size or actual > MAX_MEMBER_BYTES:
                                                fail("archive member size mismatch")
                                            write_all(output, chunk)
                                            value.update(chunk)
                                        if actual != member.size:
                                            fail("archive member size mismatch")
                                        os.fchmod(output, mode)
                                        os.fsync(output)
                                    finally:
                                        os.close(output)
                                    inventory.append({"mode": mode, "path": logical, "sha256": value.hexdigest(), "size": actual, "type": "file"})
                                else:
                                    fail("archive contains unsupported entry type")
                                os.fsync(parent)
                            finally:
                                os.close(parent)
            os.fsync(extract_fd)
        finally:
            os.close(extract_fd)
        return sorted(inventory, key=lambda item: item["path"])
    finally:
        os.close(archive_fd)


def snapshot(home_fd, parts, backups_fd, backup_name):
    try:
        parent = descend(home_fd, parts[:-1]) if parts[:-1] else os.dup(home_fd)
    except FileNotFoundError:
        return "missing"
    try:
        try:
            st = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return "missing"
        if stat.S_ISREG(st.st_mode):
            source = os.open(parts[-1], os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent)
            try:
                if not same_object(st, os.fstat(source)):
                    fail("live file changed while snapshotting")
                output = os.open(backup_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=backups_fd)
                try:
                    while True:
                        check_cancelled()
                        chunk = os.read(source, 1024 * 1024)
                        if not chunk: break
                        write_all(output, chunk)
                    os.fchmod(output, stat.S_IMODE(st.st_mode))
                    os.fsync(output)
                finally: os.close(output)
            finally: os.close(source)
            return "file"
        if stat.S_ISDIR(st.st_mode):
            os.mkdir(backup_name, 0o700, dir_fd=backups_fd)
            source = os.open(parts[-1], os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent)
            destination = descend(backups_fd, [backup_name])
            try:
                if not same_object(st, os.fstat(source)):
                    fail("live directory changed while snapshotting")
                snapshot_directory(source, destination)
                os.fchmod(destination, stat.S_IMODE(st.st_mode))
                os.fsync(destination)
            finally:
                os.close(source)
                os.close(destination)
            os.fsync(backups_fd)
            return "directory"
        if stat.S_ISLNK(st.st_mode):
            target = os.readlink(parts[-1], dir_fd=parent)
            after = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            if not same_object(st, after):
                fail("live symlink changed while snapshotting")
            os.symlink(target, backup_name, dir_fd=backups_fd)
            os.fsync(backups_fd)
            return "symlink"
        fail("unsupported live target type")
    finally:
        os.close(parent)


def snapshot_directory(source_fd, destination_fd):
    for name in sorted(os.listdir(source_fd)):
        check_cancelled()
        if not safe_component(name): fail("unsafe live entry")
        st = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        if stat.S_ISLNK(st.st_mode):
            target = os.readlink(name, dir_fd=source_fd)
            if not same_object(st, os.stat(name, dir_fd=source_fd, follow_symlinks=False)):
                fail("live symlink changed while snapshotting")
            os.symlink(target, name, dir_fd=destination_fd)
        elif stat.S_ISDIR(st.st_mode):
            os.mkdir(name, 0o700, dir_fd=destination_fd)
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=source_fd)
            output = descend(destination_fd, [name])
            try:
                if not same_object(st, os.fstat(child)):
                    fail("live directory changed while snapshotting")
                snapshot_directory(child, output)
                os.fchmod(output, stat.S_IMODE(st.st_mode))
                os.fsync(output)
            finally:
                os.close(child)
                os.close(output)
        elif stat.S_ISREG(st.st_mode):
            source = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=source_fd)
            if not same_object(st, os.fstat(source)):
                os.close(source)
                fail("live file changed while snapshotting")
            output = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=destination_fd)
            try:
                while True:
                    check_cancelled()
                    chunk = os.read(source, 1024 * 1024)
                    if not chunk: break
                    write_all(output, chunk)
                os.fchmod(output, stat.S_IMODE(st.st_mode))
                os.fsync(output)
            finally:
                os.close(source); os.close(output)
        else: fail("unsupported live entry type")
        os.fsync(destination_fd)


def sealed_kind(inventory, logical):
    entry = inventory.get(logical)
    if entry is not None:
        return entry["type"]
    prefix = logical + "/"
    if any(path.startswith(prefix) for path in inventory):
        return "directory"
    fail("extracted source is outside sealed inventory")


def atomic_copy_sealed(source_parent, source_name, target_parent, target_name, expected):
    before = os.stat(source_name, dir_fd=source_parent, follow_symlinks=False)
    source = os.open(source_name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=source_parent)
    token = ".ccm-" + hashlib.sha256(os.urandom(32)).hexdigest()[:16]
    output = None
    try:
        current = os.fstat(source)
        if (not same_object(before, current) or not stat.S_ISREG(current.st_mode) or
                stat.S_IMODE(current.st_mode) != expected["mode"] or current.st_size != expected["size"]):
            fail("sealed extracted file changed")
        output = os.open(token, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=target_parent)
        value = hashlib.sha256()
        size = 0
        while True:
            check_cancelled()
            chunk = os.read(source, 1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > expected["size"]:
                fail("sealed extracted file changed")
            value.update(chunk)
            write_all(output, chunk)
        if size != expected["size"] or value.hexdigest() != expected["sha256"]:
            fail("sealed extracted file changed")
        os.fchmod(output, expected["mode"])
        os.fsync(output)
        os.close(output)
        output = None
        try:
            target = os.stat(target_name, dir_fd=target_parent, follow_symlinks=False)
            if not stat.S_ISREG(target.st_mode):
                fail("destination has incompatible type")
        except FileNotFoundError:
            pass
        os.replace(token, target_name, src_dir_fd=target_parent, dst_dir_fd=target_parent)
        os.fsync(target_parent)
    except Exception:
        if output is not None:
            os.close(output)
        try:
            os.unlink(token, dir_fd=target_parent)
        except FileNotFoundError:
            pass
        raise
    finally:
        os.close(source)


def overlay_sealed_at(source_parent, source_name, logical, home_fd, target_parts, inventory):
    check_cancelled()
    kind = sealed_kind(inventory, logical)
    source_stat = os.stat(source_name, dir_fd=source_parent, follow_symlinks=False)
    target_parent = descend(home_fd, target_parts[:-1], create=True)
    try:
        if kind == "file":
            if not stat.S_ISREG(source_stat.st_mode):
                fail("sealed extracted entry changed type")
            atomic_copy_sealed(source_parent, source_name, target_parent, target_parts[-1], inventory[logical])
            return
        if kind != "directory" or not stat.S_ISDIR(source_stat.st_mode):
            fail("sealed extracted entry changed type")
        expected = inventory.get(logical)
        if expected is not None and stat.S_IMODE(source_stat.st_mode) != expected["mode"]:
            fail("sealed extracted directory changed mode")
        try:
            current = os.stat(target_parts[-1], dir_fd=target_parent, follow_symlinks=False)
            if not stat.S_ISDIR(current.st_mode):
                fail("destination has incompatible type")
        except FileNotFoundError:
            os.mkdir(target_parts[-1], 0o700, dir_fd=target_parent)
        source = os.open(source_name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=source_parent)
        target = descend(target_parent, [target_parts[-1]])
        try:
            if not same_object(source_stat, os.fstat(source)):
                fail("sealed extracted directory changed")
            names = sorted(os.listdir(source))
            prefix = logical + "/"
            expected_names = {path[len(prefix):].split("/", 1)[0]
                              for path in inventory if path.startswith(prefix)}
            if set(names) != expected_names:
                fail("sealed extracted directory changed")
            for name in names:
                if not safe_component(name):
                    fail("unsafe extracted entry")
                child_logical = logical + "/" + name
                sealed_kind(inventory, child_logical)
                overlay_sealed_at(source, name, child_logical, target, [name], inventory)
        finally:
            os.close(source)
            os.close(target)
    finally:
        os.close(target_parent)


def overlay_sealed(extract_fd, source_parts, home_fd, target_parts, inventory_list):
    inventory = {entry["path"]: entry for entry in inventory_list}
    parent = descend(extract_fd, source_parts[:-1]) if source_parts[:-1] else os.dup(extract_fd)
    try:
        overlay_sealed_at(parent, source_parts[-1], "/".join(source_parts), home_fd, target_parts, inventory)
    finally:
        os.close(parent)


def remove_tree_at(parent, name, cancellable=True):
    if cancellable:
        check_cancelled()
    try:
        st = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    if stat.S_ISDIR(st.st_mode):
        child = descend(parent, [name])
        try:
            if not same_object(st, os.fstat(child)):
                fail("directory changed while removing")
            for entry in os.listdir(child):
                remove_tree_at(child, entry, cancellable=cancellable)
        finally:
            os.close(child)
        os.rmdir(name, dir_fd=parent)
    else:
        os.unlink(name, dir_fd=parent)


def restore_snapshot(home_fd, parts, backups_fd, backup_name, kind):
    parent = descend(home_fd, parts[:-1], create=True)
    try:
        remove_tree_at(parent, parts[-1])
        if kind == "missing":
            return
        copy_typed_at(backups_fd, backup_name, parent, parts[-1], kind)
    finally:
        os.close(parent)


def prepare(req, workspace_fd):
    global ACTIVE_WORKSPACE_FD
    manifest_bytes = read_fd_file(workspace_fd, "manifest.json", MAX_MANIFEST_BYTES)
    if digest(manifest_bytes) != req.get("manifestSha256"):
        fail("manifest checksum mismatch")
    manifest = json.loads(manifest_bytes.decode())
    actions = manifest.get("actions") if isinstance(manifest, dict) else None
    if (canonical(manifest) != manifest_bytes or not isinstance(actions, list) or
            len(actions) > MAX_ACTIONS):
        fail("invalid transaction manifest")
    token = manifest.get("token")
    home = manifest.get("home")
    if not isinstance(token, str) or len(token) != 64 or any(c not in "0123456789abcdef" for c in token):
        fail("invalid transaction token")
    if req.get("home") != home:
        fail("transaction HOME mismatch")
    home_fd = open_home(home)
    home_stat = os.fstat(home_fd)
    workspace_stat = os.fstat(workspace_fd)
    records = []
    backups_fd = None
    lock_acquired = False
    transaction_state_created = False
    secret = None
    try:
        acquire_lock(home_fd, token)
        lock_acquired = True
        secret = create_transaction_state(home_fd, token)
        transaction_state_created = True
        extract_inventory = extract_archive(workspace_fd, manifest.get("archiveSha256"))
        os.mkdir("backups", 0o700, dir_fd=workspace_fd)
        backups_fd = descend(workspace_fd, ["backups"])
        seen = set()
        target_keys = set()
        pinned_commands = {}
        for index, action in enumerate(actions):
            action_id = action.get("id") if isinstance(action, dict) else None
            if (not isinstance(action, dict) or not isinstance(action_id, str) or not action_id or
                    len(action_id.encode("utf-8")) > 1024 or action_id in seen):
                fail("invalid or duplicate action")
            seen.add(action_id)
            logical = action.get("logicalGroup")
            if action.get("kind") == "write-claude-mcp":
                parts = [".claude.json"]
            elif action.get("kind") in ("overlay-group", "symlink-view"):
                parts = live_parts(logical)
            elif action.get("kind") == "plugin-add":
                parts = []
            else:
                fail("invalid action kind")
            if parts:
                key = tuple(parts)
                if key in target_keys:
                    fail("duplicate live action target")
                target_keys.add(key)
                source_name = "%06d" % index
                records.append({"parts": parts, "source": source_name, "type": snapshot(home_fd, parts, backups_fd, source_name), "retained": None})
            else:
                plugin = action.get("pluginId")
                command = action.get("codexCommand")
                if not isinstance(plugin, str) or not plugin or "\x00" in plugin:
                    fail("invalid plugin id")
                if not isinstance(command, str) or not command.startswith("/"):
                    fail("invalid Codex command")
                pinned = pinned_commands.get(command)
                if pinned is None:
                    pinned = pin_executable(home_fd, token, index, command)
                    pinned_commands[command] = pinned
                records.append({"parts": [], "source": "", "type": "plugin", "retained": None,
                                "original": command, "pinned": pinned["pinned"],
                                "pinnedPath": home + "/" + transaction_state_name(token) + "/" + pinned["pinned"],
                                "sha256": pinned["sha256"]})
        for record in records:
            if record["parts"]:
                record["retained"] = install_retained_backup(home_fd, record["parts"], backups_fd, record["source"], record["type"])
        state = {"version": VERSION, "status": "prepared", "token": token, "home": home,
                 "homeIdentity": [home_stat.st_dev, home_stat.st_ino],
                 "workspaceIdentity": [workspace_stat.st_dev, workspace_stat.st_ino],
                 "helperSha256": req["helperSha256"], "pythonPath": req["pythonPath"],
                 "manifest": manifest, "extractInventory": extract_inventory, "records": records,
                 "next": 0, "inflight": None, "plugins": []}
        save_state(workspace_fd, state, secret)
    except Exception:
        old_active_fd = ACTIVE_WORKSPACE_FD
        ACTIVE_WORKSPACE_FD = None
        for record in reversed(records):
            try:
                remove_retained(home_fd, record)
            except Exception:
                pass
        ACTIVE_WORKSPACE_FD = old_active_fd
        if transaction_state_created:
            try:
                remove_transaction_state(home_fd, token)
            except Exception:
                pass
        if lock_acquired:
            try:
                release_lock(home_fd, token)
            except Exception:
                pass
        raise
    finally:
        if backups_fd is not None:
            os.close(backups_fd)
        os.close(home_fd)
    return {"status": "prepared", "token": token}


def assert_session(req, workspace_fd):
    state, stored_mac = load_state(workspace_fd)
    if req.get("token") != state["token"]:
        fail("transaction token mismatch")
    if req.get("home") != state.get("home"):
        fail("transaction HOME mismatch")
    home_fd = open_home(req["home"])
    try:
        secret = transaction_secret(home_fd, req["token"])
        if not hmac.compare_digest(stored_mac, state_mac(state, secret)):
            fail("invalid transaction state")
    finally:
        os.close(home_fd)
    if req.get("helperSha256") != state["helperSha256"] or req.get("pythonPath") != state["pythonPath"]:
        fail("transaction runtime mismatch")
    current_workspace = os.fstat(workspace_fd)
    if [current_workspace.st_dev, current_workspace.st_ino] != state["workspaceIdentity"]:
        fail("transaction workspace changed")
    home_fd = open_home(state["home"])
    try:
        current_home = os.fstat(home_fd)
        if [current_home.st_dev, current_home.st_ino] != state["homeIdentity"]:
            fail("transaction HOME changed")
        assert_lock(home_fd, state["token"], allow_absent=state["status"] in TERMINAL)
    finally:
        os.close(home_fd)
    return state, secret


def apply(req, workspace_fd):
    state, secret = assert_session(req, workspace_fd)
    if state["status"] != "prepared":
        fail("transaction is not prepared")
    index = state["next"]
    actions = state["manifest"]["actions"]
    if index >= len(actions):
        fail("all actions already applied")
    action = actions[index]
    if req.get("actionId") != action["id"]:
        fail("action is out of order")
    if state.get("inflight") is not None:
        fail("transaction has an interrupted action; abort is required")
    state["inflight"] = action["id"]
    save_state(workspace_fd, state, secret)
    home_fd = open_home(state["home"])
    assert_lock(home_fd, state["token"])
    try:
        kind = action["kind"]
        if kind == "overlay-group":
            logical = action["logicalGroup"]
            extract_fd = descend(workspace_fd, ["extract"])
            try:
                overlay_sealed(extract_fd, logical_parts(logical), home_fd, live_parts(logical), state["extractInventory"])
            finally:
                os.close(extract_fd)
        elif kind == "write-claude-mcp":
            member = action.get("archiveMember")
            extract_fd = descend(workspace_fd, ["extract"])
            try:
                overlay_sealed(extract_fd, logical_parts(member), home_fd, [".claude.json"], state["extractInventory"])
            finally:
                os.close(extract_fd)
        elif kind == "symlink-view":
            names = action.get("names")
            if not isinstance(names, list) or len(names) != len(set(names)):
                fail("invalid symlink names")
            target = descend(home_fd, [".claude", "skills"], create=True)
            try:
                for name in names:
                    if not safe_component(name):
                        fail("invalid symlink name")
                    try:
                        source_fd = descend(home_fd, [".agents", "skills", name])
                    except (FileNotFoundError, NotADirectoryError):
                        fail("shared skill source is not a directory")
                    else:
                        os.close(source_fd)
                    source = state["home"] + "/.agents/skills/" + name
                    try:
                        existing = os.stat(name, dir_fd=target, follow_symlinks=False)
                        if not stat.S_ISLNK(existing.st_mode):
                            fail("shared skill view has incompatible type")
                    except FileNotFoundError:
                        existing = None
                    staged = ".ccm-link-" + hashlib.sha256(os.urandom(32)).hexdigest()[:16]
                    os.symlink(source, staged, dir_fd=target)
                    try:
                        if existing is None:
                            # rename is atomic, and the destination was just observed absent.
                            os.rename(staged, name, src_dir_fd=target, dst_dir_fd=target)
                        else:
                            os.replace(staged, name, src_dir_fd=target, dst_dir_fd=target)
                    except Exception:
                        try: os.unlink(staged, dir_fd=target)
                        except FileNotFoundError: pass
                        raise
            finally:
                os.close(target)
        elif kind == "plugin-add":
            plugin = action.get("pluginId")
            if not isinstance(plugin, str) or not plugin or "\x00" in plugin:
                fail("invalid Codex command")
            # Record compensating work before starting the external mutation.
            # A failed/terminated add is allowed to make remove a no-op.
            plugin_record = {**state["records"][index], "id": plugin, "remove": "pending"}
            state["plugins"].append(plugin_record)
            save_state(workspace_fd, state, secret)
            process = start_pinned_plugin(home_fd, state["token"], plugin_record,
                                          ["plugin", "add", plugin, "--json"])
            wait_plugin(process)
            if process.returncode:
                fail("Codex plugin add failed")
        state["next"] = index + 1
        state["inflight"] = None
        save_state(workspace_fd, state, secret)
    finally:
        os.close(home_fd)
    return {"status": "prepared", "applied": state["next"]}


def rollback(workspace_fd, state, secret, status):
    home_fd = open_home(state["home"])
    assert_lock(home_fd, state["token"])
    try:
        for plugin in reversed(state["plugins"]):
            if plugin.get("remove") == "complete":
                continue
            if not plugin_is_installed(home_fd, state["token"], plugin, plugin["id"]):
                plugin["remove"] = "complete"
                save_state(workspace_fd, state, secret)
                continue
            plugin["remove"] = "removing"
            save_state(workspace_fd, state, secret)
            process = start_pinned_plugin(home_fd, state["token"], plugin,
                                          ["plugin", "remove", plugin["id"], "--json"])
            wait_plugin(process, cancellable=False)
            if plugin_is_installed(home_fd, state["token"], plugin, plugin["id"]):
                fail("Codex plugin remove failed; retained backups preserved")
            plugin["remove"] = "complete"
            save_state(workspace_fd, state, secret)
        count = state["next"] + (1 if state.get("inflight") is not None else 0)
        backups_fd = descend(workspace_fd, ["backups"])
        try:
            for record in reversed(state["records"][:count]):
                if record["parts"]:
                    restore_snapshot(home_fd, record["parts"], backups_fd, record["source"], record["type"])
        finally:
            os.close(backups_fd)
        for record in reversed(state["records"]):
            remove_retained(home_fd, record)
        state["status"] = status
        save_state(workspace_fd, state, secret)
        release_lock(home_fd, state["token"])
    finally:
        os.close(home_fd)
    return {"status": status}


def finish(req, op, workspace_fd):
    state, secret = assert_session(req, workspace_fd)
    if state["status"] in TERMINAL:
        try:
            os.unlink("cancel", dir_fd=workspace_fd)
            os.fsync(workspace_fd)
        except FileNotFoundError:
            pass
        home_fd = open_home(state["home"])
        try:
            release_lock(home_fd, state["token"])
        finally:
            os.close(home_fd)
        return {"status": state["status"]}
    if op == "commit":
        if state["next"] != len(state["manifest"]["actions"]):
            fail("cannot commit incomplete transaction")
        home_fd = open_home(state["home"])
        try:
            for record in state["records"]:
                prune_retained(home_fd, record)
            state["status"] = "committed"
            save_state(workspace_fd, state, secret)
            release_lock(home_fd, state["token"])
        finally:
            os.close(home_fd)
        return {"status": "committed"}
    if op == "cancel":
        try: os.unlink("cancel", dir_fd=workspace_fd)
        except FileNotFoundError: pass
    return rollback(workspace_fd, state, secret, "cancelled" if op == "cancel" else "aborted")


def cleanup(req, workspace_fd):
    workspace = req.get("workspace")
    state, _secret = assert_session(req, workspace_fd)
    if state["status"] not in TERMINAL:
        fail("cleanup requires a terminal transaction")
    home_fd = open_home(state["home"])
    try:
        cleanup_tombstone(home_fd, state["token"], workspace, state["workspaceIdentity"], _secret)
        release_lock(home_fd, state["token"])
        remove_workspace(workspace, workspace_fd)
        retire_transaction_state(home_fd, state["token"])
    finally:
        os.close(home_fd)
    return {"status": "cleaned"}


def main():
    global ACTIVE_WORKSPACE_FD
    os.umask(0o077)
    if len(sys.argv) != 2:
        fail("expected one request argument")
    req = decode_request(sys.argv[1])
    verify_runtime(req)
    op = req.get("op")
    workspace = req.get("workspace")
    try:
        workspace_fd = validate_workspace(workspace)
    except FileNotFoundError:
        if op != "cleanup":
            raise
        result = cleanup_missing_workspace(req)
        sys.stdout.buffer.write(canonical(result) + b"\n")
        return
    ACTIVE_WORKSPACE_FD = os.dup(workspace_fd)
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)
    if op == "cleanup":
        try:
            os.stat("state.json", dir_fd=workspace_fd, follow_symlinks=False)
        except FileNotFoundError:
            try:
                result = cleanup_partial_workspace(req, workspace_fd)
            finally:
                os.close(ACTIVE_WORKSPACE_FD)
                ACTIVE_WORKSPACE_FD = None
                os.close(workspace_fd)
            sys.stdout.buffer.write(canonical(result) + b"\n")
            return
    if op == "cancel":
        try:
            marker = os.open("cancel", os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=workspace_fd)
            os.close(marker)
            os.fsync(workspace_fd)
        except FileExistsError:
            marker_stat = os.stat("cancel", dir_fd=workspace_fd, follow_symlinks=False)
            if not stat.S_ISREG(marker_stat.st_mode):
                fail("unsafe cancel marker")
    lock_fd = os.open(".operation-lock", os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=workspace_fd)
    try:
        lock_stat = os.fstat(lock_fd)
        if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_uid != os.geteuid() or stat.S_IMODE(lock_stat.st_mode) & 0o077:
            fail("unsafe operation lock")
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        if op == "prepare": result = prepare(req, workspace_fd)
        elif op == "apply": result = apply(req, workspace_fd)
        elif op in ("commit", "cancel", "abort"): result = finish(req, op, workspace_fd)
        elif op == "cleanup": result = cleanup(req, workspace_fd)
        elif op == "status":
            state, _secret = assert_session(req, workspace_fd)
            result = {"status": state["status"], "applied": state["next"]}
        else: fail("unknown operation")
    finally:
        os.close(lock_fd)
        os.close(ACTIVE_WORKSPACE_FD)
        ACTIVE_WORKSPACE_FD = None
        os.close(workspace_fd)
    sys.stdout.buffer.write(canonical(result) + b"\n")


if __name__ == "__main__":
    try:
        main()
    except Blocked as error:
        sys.stdout.buffer.write(canonical({"error": "blocked", "message": str(error)}) + b"\n")
        sys.exit(64)
    except Cancelled as error:
        sys.stdout.buffer.write(canonical({"error": "cancelled", "message": str(error)}) + b"\n")
        sys.exit(70)
    except Exception as error:
        sys.stdout.buffer.write(canonical({"error": "execution", "message": str(error)}) + b"\n")
        sys.exit(70)
