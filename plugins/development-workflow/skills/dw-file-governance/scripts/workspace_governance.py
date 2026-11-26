#!/usr/bin/env python3
"""Cross-project workspace file governance CLI for the dw-file-governance skill.

Pure Python 3.9+ stdlib CLI enforcing 7 deterministic workspace governance rules:
  1. check-path     - Boundary, reserved-name, root-clutter, reparse, and temp-tier validation
  2. alloc-temp     - Scoped OS/repo temp allocation with atomic TempLease1 lease metadata
  3. reclaim-temp   - PID-liveness + start-token reuse guard + junction-safe temp reclamation
  4. audit          - ProtectedSet + inode-deduplicated accounting + --check hygiene gate
  5. dehydrate      - 6 fail-closed gates + atomic bundle/verify/unlink/receipt dehydration
  6. verify-bundles - Full SHA-256 verification for dw-dehydrated-bundle & mph-dehydrated-bundle
  7. archive-index  - Immutable cold-archive sealing (ARCHIVE-MANIFEST.json + SHA256SUMS) & verify
"""

from __future__ import annotations

import argparse
import csv
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import fnmatch
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any

# Ensure UTF-8 safe stdout/stderr across Windows and POSIX locales
for _stream_name in ("stdout", "stderr"):
    _stream = getattr(sys, _stream_name, None)
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

TEMP_LEASE_FILENAME = ".dw-temp-lease.json"
TEMP_LEASE_SCHEMA = "dw-temp-lease-v1"
DW_BUNDLE_FILENAME = "dw-dehydrated-bundle.json"
DW_BUNDLE_SCHEMA = "dw-dehydrated-bundle-v1"
MPH_BUNDLE_FILENAME = "mph-dehydrated-bundle.json"
MPH_BUNDLE_SCHEMA = "mph-dehydrated-bundle/v1"
ARCHIVE_MANIFEST_FILENAME = "ARCHIVE-MANIFEST.json"
ARCHIVE_MANIFEST_SCHEMA = "dw-archive-manifest-v1"
DEHYDRATION_RECEIPT_FILENAME = "DEHYDRATION-RECEIPT.json"
DEHYDRATION_RECEIPT_SCHEMA = "dw-dehydration-receipt-v1"

SKIP_WALK_DIRS: frozenset[str] = frozenset({".git", ".worktrees", "node_modules", "__pycache__"})
HEX64_RE = re.compile(r"^[0-9a-fA-F]{64}$")
SHA_LINE_RE = re.compile(r"^([0-9a-fA-F]{64})(?:\s+\*?(?:(\d+)\s+)?(.+))?$")

WINDOWS_RESERVED_NAMES: frozenset[str] = frozenset(
    {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }
)

ROOT_CLUTTER_EXTS: tuple[str, ...] = (
    ".tmp",
    ".bak",
    ".log",
    ".out",
    ".mph",
    ".pt",
    ".ckpt",
    ".npz",
)

ROOT_CLUTTER_PREFIXES: tuple[str, ...] = (
    ".tmp",
    "_scratch",
    "tmp_",
)

ADHOC_DRIVE_TEMP_RE = re.compile(
    r"^[A-Za-z]:[/\\](?:temp|tmp|tmp_[^/\\]*|scratch[^/\\]*)(?:[/\\]|$)",
    re.IGNORECASE,
)
ADHOC_POSIX_TEMP_RE = re.compile(
    r"^/(?:tmp_[^/]+|temp|scratch[^/]*)(?:/|$)",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Core Utilities
# ---------------------------------------------------------------------------


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def canonical_json_bytes(obj: Any) -> bytes:
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def compute_canonical_sha256(obj: dict[str, Any], exclude_key: str) -> str:
    filtered = {k: v for k, v in obj.items() if k != exclude_key}
    return hashlib.sha256(canonical_json_bytes(filtered)).hexdigest()


def sha256_file(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    total = 0
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
            total += len(chunk)
    return h.hexdigest(), total


def atomic_write_bytes(path: Path, data: bytes) -> tuple[str, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_name = f".dw-atomic-{os.getpid()}-{secrets.token_hex(4)}.tmp"
    tmp_path = path.parent / tmp_name
    try:
        with tmp_path.open("wb") as fh:
            fh.write(data)
            fh.flush()
            try:
                os.fsync(fh.fileno())
            except OSError:
                pass
        os.replace(tmp_path, path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
    return hashlib.sha256(data).hexdigest(), len(data)


def atomic_write_json(path: Path, payload: Any) -> tuple[str, int]:
    text = json.dumps(payload, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    raw = text.replace("\r\n", "\n").encode("utf-8")
    return atomic_write_bytes(path, raw)


def atomic_write_text(path: Path, text: str) -> tuple[str, int]:
    raw = text.replace("\r\n", "\n").encode("utf-8")
    return atomic_write_bytes(path, raw)


def norm_key(rel_posix: str) -> str:
    cleaned = rel_posix.replace("\\", "/").strip("/")
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    return cleaned.lower() if os.name == "nt" else cleaned


def to_rel_posix(path: Path | str, root: Path) -> str | None:
    abs_root = os.path.abspath(str(root))
    abs_path = os.path.abspath(str(path))
    try:
        rel = os.path.relpath(abs_path, abs_root)
    except ValueError:
        return None
    rel_posix = rel.replace("\\", "/")
    if rel_posix == ".":
        return ""
    if rel_posix == ".." or rel_posix.startswith("../"):
        return None
    return rel_posix


def is_subpath_lexical(path: Path, root: Path) -> bool:
    rel = to_rel_posix(path, root)
    return rel is not None


def is_subpath_real(path: Path, root: Path) -> bool:
    try:
        r_path = Path(os.path.realpath(str(path)))
        r_root = Path(os.path.realpath(str(root)))
        return to_rel_posix(r_path, r_root) is not None
    except OSError:
        return False


def _resolve_repo_root(raw_repo_root: str, *, as_json: bool) -> Path | None:
    if not raw_repo_root or any(ord(ch) < 32 or ord(ch) == 127 for ch in raw_repo_root):
        emit_output(
            {
                "ok": False,
                "code": "INVALID_REPO_ROOT",
                "detail": f"Invalid or missing repo_root directory: {raw_repo_root}",
            },
            as_json=as_json,
        )
        return None
    cand = Path(raw_repo_root).expanduser()
    if not cand.exists() or not cand.is_dir():
        emit_output(
            {
                "ok": False,
                "code": "INVALID_REPO_ROOT",
                "detail": f"Invalid or missing repo_root directory: {raw_repo_root}",
            },
            as_json=as_json,
        )
        return None
    return Path(os.path.realpath(str(cand)))


def _resolve_cli_dir(raw_dir: str, repo_root: Path) -> Path:
    p = Path(raw_dir).expanduser()
    if p.is_absolute():
        return Path(os.path.abspath(str(p)))
    cand_repo = Path(os.path.abspath(str(repo_root / p)))
    if cand_repo.exists():
        return cand_repo
    cand_cwd = Path(os.path.abspath(str(p)))
    if cand_cwd.exists():
        return cand_cwd
    return cand_repo


def is_reparse_or_link(path: Path | str) -> bool:
    p_str = str(path)
    try:
        st = os.lstat(p_str)
    except OSError:
        return False
    attrs = getattr(st, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if attrs & reparse_flag:
        return True
    if stat.S_ISLNK(st.st_mode) or os.path.islink(p_str):
        return True
    isjunction = getattr(os.path, "isjunction", None)
    if isjunction is not None:
        try:
            if isjunction(p_str):
                return True
        except OSError:
            pass
    return False


def unlink_reparse_only(path: Path) -> None:
    """Remove a symlink or Windows junction without touching its target."""
    if os.name == "nt":
        # Windows directory junctions are removed via rmdir; file symlinks via unlink
        try:
            os.rmdir(path)
            return
        except OSError:
            pass
    os.unlink(path)


def safe_rmtree(target: Path) -> dict[str, int]:
    """Delete a file/dir tree safely without traversing symlinks or Windows junctions."""
    stats = {"files_removed": 0, "dirs_removed": 0, "bytes_reclaimed": 0, "reparse_links_unlinked": 0}
    if not target.exists() and not is_reparse_or_link(target):
        return stats

    if is_reparse_or_link(target):
        unlink_reparse_only(target)
        stats["reparse_links_unlinked"] += 1
        return stats

    try:
        st = os.lstat(target)
    except OSError:
        return stats

    if not stat.S_ISDIR(st.st_mode):
        try:
            os.chmod(target, stat.S_IWRITE | stat.S_IREAD)
        except OSError:
            pass
        os.unlink(target)
        stats["files_removed"] += 1
        stats["bytes_reclaimed"] += int(st.st_size)
        return stats

    with os.scandir(target) as it:
        entries = list(it)
    for entry in entries:
        child = Path(entry.path)
        if is_reparse_or_link(child):
            unlink_reparse_only(child)
            stats["reparse_links_unlinked"] += 1
            continue
        try:
            cst = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        if stat.S_ISDIR(cst.st_mode):
            sub = safe_rmtree(child)
            for k, v in sub.items():
                stats[k] += v
        else:
            try:
                os.chmod(child, stat.S_IWRITE | stat.S_IREAD)
            except OSError:
                pass
            os.unlink(child)
            stats["files_removed"] += 1
            stats["bytes_reclaimed"] += int(cst.st_size)

    try:
        os.chmod(target, stat.S_IWRITE | stat.S_IREAD | stat.S_IEXEC)
    except OSError:
        pass
    os.rmdir(target)
    stats["dirs_removed"] += 1
    return stats


def sanitize_slug(value: str, fallback: str = "work") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip(".-")
    if not cleaned:
        cleaned = fallback
    stem = cleaned.split(".", 1)[0].upper()
    if stem in WINDOWS_RESERVED_NAMES:
        cleaned = f"dw-{cleaned}"
    return cleaned[:48]


def is_root_clutter_name(name: str, *, allow_dot_tmp_dir: bool = False) -> bool:
    low = name.lower()
    if allow_dot_tmp_dir and low == ".tmp":
        return False
    for ext in ROOT_CLUTTER_EXTS:
        if low.endswith(ext):
            return True
    for pref in ROOT_CLUTTER_PREFIXES:
        if low.startswith(pref):
            return True
    return False


# ---------------------------------------------------------------------------
# Git Helpers
# ---------------------------------------------------------------------------


def is_git_repo(repo_root: Path) -> bool:
    return (repo_root / ".git").exists()


def is_repo_tmp_gitignored(repo_root: Path) -> bool:
    """Return True iff <repo_root>/.tmp/ is ignored by Git (or .gitignore fallback)."""
    if is_git_repo(repo_root):
        proc = subprocess.run(
            ["git", "-C", str(repo_root), "check-ignore", "-q", ".tmp/probe"],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode == 0:
            return True
        if proc.returncode == 1:
            return False
    gi = repo_root / ".gitignore"
    if not gi.is_file():
        return False
    try:
        for raw_line in gi.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or line.startswith("!"):
                continue
            if line in {".tmp", ".tmp/", "/.tmp", "/.tmp/", ".tmp/*", "/.tmp/*", ".tmp/**", "/.tmp/**"}:
                return True
    except OSError:
        return False
    return False


def git_tracked_relpaths(repo_root: Path) -> set[str]:
    if not is_git_repo(repo_root):
        return set()
    proc = subprocess.run(
        ["git", "-C", str(repo_root), "ls-files", "-z"],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        return set()
    out: set[str] = set()
    for item in proc.stdout.split(b"\x00"):
        if item:
            out.add(norm_key(item.decode("utf-8", errors="replace")))
    return out


def git_check_ignored_batch(repo_root: Path, relpaths: list[str]) -> set[str]:
    if not relpaths:
        return set()
    if is_git_repo(repo_root):
        stdin_bytes = b"\x00".join(p.encode("utf-8") for p in relpaths) + b"\x00"
        proc = subprocess.run(
            ["git", "-C", str(repo_root), "check-ignore", "--stdin", "-z"],
            input=stdin_bytes,
            capture_output=True,
            check=False,
        )
        if proc.returncode in (0, 1):
            ignored: set[str] = set()
            for item in proc.stdout.split(b"\x00"):
                if item:
                    ignored.add(norm_key(item.decode("utf-8", errors="replace")))
            return ignored
    # Fallback minimal .gitignore matching for non-git repos
    gi = repo_root / ".gitignore"
    if not gi.is_file():
        return set()
    patterns: list[str] = []
    for raw_line in gi.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if line and not line.startswith("#") and not line.startswith("!"):
            patterns.append(line.lstrip("/"))
    ignored_fb: set[str] = set()
    for rel in relpaths:
        for pat in patterns:
            if pat.endswith("/") and (rel.startswith(pat) or f"/{pat}" in f"/{rel}"):
                ignored_fb.add(norm_key(rel))
                break
            if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(Path(rel).name, pat):
                ignored_fb.add(norm_key(rel))
                break
    return ignored_fb


# ---------------------------------------------------------------------------
# Cross-Platform Process Liveness & Start-Time Reuse Guard
# ---------------------------------------------------------------------------


def inspect_process(pid: int) -> tuple[bool, str | None]:
    """Return (is_alive, process_start_token) without external dependencies."""
    if not isinstance(pid, int) or pid <= 0:
        return False, None

    if os.name == "nt":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        ERROR_ACCESS_DENIED = 5

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        OpenProcess = kernel32.OpenProcess
        OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        OpenProcess.restype = wintypes.HANDLE

        GetExitCodeProcess = kernel32.GetExitCodeProcess
        GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        GetExitCodeProcess.restype = wintypes.BOOL

        GetProcessTimes = kernel32.GetProcessTimes
        GetProcessTimes.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(wintypes.FILETIME),
            ctypes.POINTER(wintypes.FILETIME),
            ctypes.POINTER(wintypes.FILETIME),
            ctypes.POINTER(wintypes.FILETIME),
        ]
        GetProcessTimes.restype = wintypes.BOOL

        CloseHandle = kernel32.CloseHandle
        CloseHandle.argtypes = [wintypes.HANDLE]
        CloseHandle.restype = wintypes.BOOL

        handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            err = ctypes.get_last_error()
            if err == ERROR_ACCESS_DENIED:
                return True, "win-access-denied"
            return False, None
        try:
            exit_code = wintypes.DWORD(0)
            if GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                if exit_code.value != STILL_ACTIVE:
                    return False, None
            c_t = wintypes.FILETIME()
            e_t = wintypes.FILETIME()
            k_t = wintypes.FILETIME()
            u_t = wintypes.FILETIME()
            if GetProcessTimes(handle, ctypes.byref(c_t), ctypes.byref(e_t), ctypes.byref(k_t), ctypes.byref(u_t)):
                ft64 = (int(c_t.dwHighDateTime) << 32) | int(c_t.dwLowDateTime)
                return True, f"win-ft:{ft64}"
            return True, "unknown"
        finally:
            CloseHandle(handle)

    # Linux /proc
    proc_stat = Path(f"/proc/{pid}/stat")
    if proc_stat.is_file():
        try:
            raw = proc_stat.read_text(encoding="utf-8", errors="replace")
            rparen = raw.rfind(")")
            if rparen != -1:
                fields = raw[rparen + 2 :].split()
                if fields:
                    state = fields[0]
                    if state == "Z":
                        return False, None
                    if len(fields) >= 20:
                        return True, f"linux-st:{fields[19]}"
            return True, "unknown"
        except OSError:
            return False, None

    # Generic POSIX fallback (macOS / BSD)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False, None
    except PermissionError:
        pass
    except OSError:
        return False, None

    proc = subprocess.run(
        ["ps", "-o", "lstart=", "-p", str(pid)],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode == 0 and proc.stdout.strip():
        return True, f"ps-lstart:{' '.join(proc.stdout.strip().split())}"
    return True, "unknown"


def find_conflicting_processes(substrings: list[str]) -> list[dict[str, Any]]:
    """Return live OS processes matching any case-insensitive substring (excluding self PID)."""
    needles = [s.lower() for s in substrings if s and s.strip()]
    if not needles:
        return []

    my_pid = os.getpid()
    matches: list[dict[str, Any]] = []

    if os.name == "nt":
        proc = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        reader = csv.reader(io.StringIO(proc.stdout))
        for row in reader:
            if len(row) < 2:
                continue
            name = row[0].strip()
            pid_str = row[1].strip()
            pid = int(pid_str) if pid_str.isdigit() else -1
            if pid == my_pid:
                continue
            low = name.lower()
            for needle in needles:
                if needle in low:
                    matches.append({"pid": pid, "name": name, "matched": needle})
                    break
        return matches

    # Linux /proc
    proc_root = Path("/proc")
    if proc_root.is_dir():
        for entry in proc_root.iterdir():
            if not entry.name.isdigit():
                continue
            pid = int(entry.name)
            if pid == my_pid:
                continue
            try:
                comm = (entry / "comm").read_text(encoding="utf-8", errors="replace").strip()
                cmdline = (entry / "cmdline").read_bytes().replace(b"\x00", b" ").decode("utf-8", errors="replace").strip()
            except OSError:
                continue
            hay = f"{comm} {cmdline}".lower()
            for needle in needles:
                if needle in hay:
                    matches.append({"pid": pid, "name": comm, "cmdline": cmdline, "matched": needle})
                    break
        return matches

    # macOS / POSIX ps fallback
    proc = subprocess.run(
        ["ps", "-ax", "-o", "pid=,comm=,args="],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    for line in proc.stdout.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) < 2 or not parts[0].isdigit():
            continue
        pid = int(parts[0])
        if pid == my_pid:
            continue
        hay = " ".join(parts[1:]).lower()
        for needle in needles:
            if needle in hay:
                matches.append({"pid": pid, "name": parts[1], "matched": needle})
                break
    return matches


# ---------------------------------------------------------------------------
# SHA Manifest & ProtectedSet Utilities
# ---------------------------------------------------------------------------


def parse_sha_manifest_lines(text: str) -> list[tuple[str, int | None, str]]:
    """Parse 2-column, *-binary, and 3-column (sha256 size path) manifest lines."""
    entries: list[tuple[str, int | None, str]] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        m = SHA_LINE_RE.match(line)
        if not m:
            continue
        digest = m.group(1).lower()
        size_str = m.group(2)
        target = (m.group(3) or "").strip()
        if not target:
            continue
        if target.startswith("*"):
            target = target[1:].strip()
        if target.startswith("./"):
            target = target[2:]
        size_val = int(size_str) if size_str and size_str.isdigit() else None
        entries.append((digest, size_val, target.replace("\\", "/")))
    return entries


def is_sha_manifest_filename(name: str) -> bool:
    low = name.lower()
    return low == "sha256sums" or low.endswith(".sha256") or low.endswith(".sha256.txt")


def resolve_manifest_ref(manifest_path: Path, repo_root: Path, ref: str) -> tuple[Path, str | None]:
    """Resolve a manifest entry against manifest parent first, then repo root."""
    cand_parent = manifest_path.parent / ref
    cand_root = repo_root / ref
    if cand_parent.exists():
        return cand_parent, to_rel_posix(cand_parent, repo_root)
    if cand_root.exists():
        return cand_root, to_rel_posix(cand_root, repo_root)
    # Neither exists: prefer repo-relative if ref looks multi-segment starting with top-level dir, else parent
    rel_parent = to_rel_posix(cand_parent, repo_root)
    rel_root = to_rel_posix(cand_root, repo_root)
    if "/" in ref and (repo_root / ref.split("/", 1)[0]).exists():
        return cand_root, rel_root
    return cand_parent, rel_parent


def extract_bundle_info(bundle_path: Path, repo_root: Path) -> dict[str, Any]:
    """Read dw-dehydrated-bundle.json or mph-dehydrated-bundle.json metadata safely."""
    info: dict[str, Any] = {
        "kind": "dw" if bundle_path.name == DW_BUNDLE_FILENAME else "mph",
        "bundle_relpath": to_rel_posix(bundle_path, repo_root) or str(bundle_path),
        "valid_json": False,
        "preserved_relpaths": [],
        "dehydrated_relpaths": [],
        "doc": None,
        "error": None,
    }
    try:
        doc = json.loads(bundle_path.read_text(encoding="utf-8"))
    except Exception as exc:
        info["error"] = f"json_parse_error:{exc}"
        return info
    if not isinstance(doc, dict):
        info["error"] = "bundle_not_object"
        return info
    info["valid_json"] = True
    info["doc"] = doc

    if info["kind"] == "dw":
        slot_rel = doc.get("slot_relpath")
        slot_dir = (repo_root / slot_rel) if isinstance(slot_rel, str) and slot_rel else bundle_path.parent
        for list_key in ("preserved_artifacts", "preserved_files"):
            items = doc.get(list_key)
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict) and isinstance(item.get("relpath"), str):
                        info["preserved_relpaths"].append(item["relpath"].replace("\\", "/"))
                    elif isinstance(item, str):
                        rel = to_rel_posix(slot_dir / item, repo_root)
                        if rel:
                            info["preserved_relpaths"].append(rel)
        for ref_key in ("parameters_ref", "proof_ref"):
            ref_obj = doc.get(ref_key)
            if isinstance(ref_obj, dict) and isinstance(ref_obj.get("relpath"), str):
                info["preserved_relpaths"].append(ref_obj["relpath"].replace("\\", "/"))
        targets = doc.get("dehydrated_targets")
        if isinstance(targets, list):
            for t in targets:
                if isinstance(t, dict) and isinstance(t.get("relpath"), str):
                    info["dehydrated_relpaths"].append(t["relpath"].replace("\\", "/"))
    else:
        slot_rel = doc.get("slot_relpath")
        if isinstance(slot_rel, str) and slot_rel:
            slot_dir = repo_root / slot_rel
        elif bundle_path.parent.parent.name == "results":
            slot_dir = bundle_path.parents[2]
        else:
            slot_dir = bundle_path.parent

        ev = doc.get("preserved_evidence")
        if isinstance(ev, dict):
            for k in ev.keys():
                if isinstance(k, str):
                    rel = to_rel_posix(slot_dir / k, repo_root)
                    if rel:
                        info["preserved_relpaths"].append(rel)
        for list_key in ("preserved_artifacts", "preserved_files"):
            items = doc.get(list_key)
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict) and isinstance(item.get("relpath"), str):
                        info["preserved_relpaths"].append(item["relpath"].replace("\\", "/"))
                    elif isinstance(item, str):
                        rel = to_rel_posix(slot_dir / item, repo_root)
                        if rel:
                            info["preserved_relpaths"].append(rel)
        mph_files = doc.get("dehydrated_mph_files")
        if isinstance(mph_files, list):
            for entry in mph_files:
                if isinstance(entry, dict):
                    if isinstance(entry.get("relpath"), str):
                        info["dehydrated_relpaths"].append(entry["relpath"].replace("\\", "/"))
                    if isinstance(entry.get("filename"), str):
                        rel_fn = to_rel_posix(bundle_path.parent / entry["filename"], repo_root)
                        if rel_fn:
                            info["dehydrated_relpaths"].append(rel_fn)

    return info


class InodeAccumulator:
    def __init__(self) -> None:
        self.file_count: int = 0
        self.logical_bytes: int = 0
        self.physical_bytes: int = 0
        self._seen: set[tuple[Any, ...]] = set()

    def add(self, path_str: str, st: os.stat_result) -> None:
        if not st.st_ino:
            try:
                st = os.lstat(path_str)
            except OSError:
                pass
        size = int(st.st_size)
        self.file_count += 1
        self.logical_bytes += size
        if st.st_ino:
            key: tuple[Any, ...] = (int(st.st_dev), int(st.st_ino))
        else:
            key = ("path", os.path.abspath(path_str))
        if key not in self._seen:
            self._seen.add(key)
            self.physical_bytes += size

    def to_dict(self) -> dict[str, Any]:
        return {
            "file_count": self.file_count,
            "logical_bytes": self.logical_bytes,
            "physical_bytes": self.physical_bytes,
            "hardlink_dedup_saved_bytes": self.logical_bytes - self.physical_bytes,
        }


def scan_workspace_state(
    repo_root: Path,
    *,
    protected_globs: list[str] | None = None,
    large_file_bytes: int = 50 * 1024 * 1024,
    orphan_grace_sec: int = 600,
) -> dict[str, Any]:
    """Perform a single safe read-only walk building ProtectedSet, accounting, and audit findings."""
    repo_root = Path(os.path.realpath(str(repo_root)))
    protected_files: set[str] = set()
    protected_reasons: dict[str, str] = {}
    tracked_files = git_tracked_relpaths(repo_root)
    for tk in tracked_files:
        protected_files.add(tk)
        protected_reasons.setdefault(tk, "git_tracked")

    globs = list(protected_globs or [])
    acc = InodeAccumulator()
    sha_manifests: list[Path] = []
    bundle_paths: list[Path] = []
    all_large_files: list[dict[str, Any]] = []
    root_clutter: list[str] = []

    def add_protected(rel_posix: str, reason: str) -> None:
        k = norm_key(rel_posix)
        if not k:
            return
        protected_files.add(k)
        protected_reasons.setdefault(k, reason)

    # Check direct children of repo_root for root_clutter and .tmp existence
    repo_tmp_dir = repo_root / ".tmp"
    repo_tmp_exists = repo_tmp_dir.exists() or is_reparse_or_link(repo_tmp_dir)
    repo_tmp_gitignored = is_repo_tmp_gitignored(repo_root) if repo_tmp_exists else is_repo_tmp_gitignored(repo_root)

    try:
        with os.scandir(repo_root) as it:
            for entry in it:
                if entry.name in SKIP_WALK_DIRS:
                    continue
                if is_root_clutter_name(entry.name, allow_dot_tmp_dir=True):
                    root_clutter.append(entry.name)
    except OSError:
        pass
    root_clutter.sort()

    # Iterative safe scandir walk (never follows symlinks/junctions)
    stack: list[Path] = [repo_root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                entries = list(it)
        except OSError:
            continue
        for entry in entries:
            name = entry.name
            p = Path(entry.path)
            if current == repo_root and name in SKIP_WALK_DIRS:
                continue
            if is_reparse_or_link(p):
                continue
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISDIR(st.st_mode):
                if name in SKIP_WALK_DIRS:
                    continue
                stack.append(p)
                continue
            if not stat.S_ISREG(st.st_mode):
                continue

            acc.add(entry.path, st)
            rel = to_rel_posix(p, repo_root)
            if rel is None:
                continue

            in_tmp = rel == ".tmp" or rel.startswith(".tmp/")
            if rel.startswith("templates/"):
                add_protected(rel, "templates_dir")
            for pat in globs:
                if fnmatch.fnmatch(rel, pat):
                    add_protected(rel, f"protected_glob:{pat}")
                    break

            if not in_tmp:
                if is_sha_manifest_filename(name):
                    sha_manifests.append(p)
                if name in (DW_BUNDLE_FILENAME, MPH_BUNDLE_FILENAME):
                    bundle_paths.append(p)
                if int(st.st_size) >= large_file_bytes:
                    all_large_files.append({"relpath": rel, "size_bytes": int(st.st_size)})

    # Process bundles first so dehydrated_target_set is ready before SHA manifest checking
    dehydrated_targets: set[str] = set()
    bundle_preserved_count = 0
    for bp in sorted(bundle_paths):
        binfo = extract_bundle_info(bp, repo_root)
        add_protected(binfo["bundle_relpath"], "dehydrated_bundle")
        if binfo["valid_json"]:
            for prel in binfo["preserved_relpaths"]:
                add_protected(prel, "bundle_preserved")
                bundle_preserved_count += 1
            for drel in binfo["dehydrated_relpaths"]:
                dehydrated_targets.add(norm_key(drel))

    # Process non-temp SHA256SUMS / *.sha256 manifests
    sha_pinned_files = 0
    broken_integrity_refs: list[dict[str, Any]] = []
    for mp in sorted(sha_manifests):
        m_rel = to_rel_posix(mp, repo_root) or str(mp)
        add_protected(m_rel, "sha_manifest")
        try:
            text = mp.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for digest, _size_val, ref in parse_sha_manifest_lines(text):
            resolved_path, rel_target = resolve_manifest_ref(mp, repo_root, ref)
            if rel_target:
                add_protected(rel_target, f"sha_manifest_ref:{m_rel}")
                sha_pinned_files += 1
            if not resolved_path.is_file():
                # Exclude explicitly dehydrated targets recorded in valid bundles
                key_cand = norm_key(rel_target) if rel_target else norm_key(ref)
                if key_cand in dehydrated_targets:
                    continue
                broken_integrity_refs.append(
                    {
                        "manifest": m_rel,
                        "ref": ref,
                        "resolved_relpath": rel_target,
                        "expected_sha256": digest,
                    }
                )

    # Check large files for unignored_large_untracked & large_unprotected_candidates
    untracked_large = [item for item in all_large_files if norm_key(item["relpath"]) not in tracked_files]
    ignored_large = git_check_ignored_batch(repo_root, [item["relpath"] for item in untracked_large])
    unignored_large_untracked = sorted(
        [item for item in untracked_large if norm_key(item["relpath"]) not in ignored_large],
        key=lambda x: (-x["size_bytes"], x["relpath"]),
    )
    large_unprotected_candidates = sorted(
        [item for item in all_large_files if norm_key(item["relpath"]) not in protected_files],
        key=lambda x: (-x["size_bytes"], x["relpath"]),
    )

    # Check orphan_temp_dirs under <repo_root>/.tmp/
    orphan_temp_dirs: list[dict[str, Any]] = []
    if repo_tmp_dir.is_dir() and not is_reparse_or_link(repo_tmp_dir):
        now_ts = time.time()
        try:
            with os.scandir(repo_tmp_dir) as it:
                for entry in it:
                    cpath = Path(entry.path)
                    rel = to_rel_posix(cpath, repo_root) or entry.name
                    decision = classify_temp_candidate(cpath, grace_sec=orphan_grace_sec, now_ts=now_ts, os_tier=False)
                    if decision["decision"].startswith("RECLAIM_"):
                        orphan_temp_dirs.append(
                            {
                                "relpath": rel,
                                "decision": decision["decision"],
                                "reason": decision["reason"],
                            }
                        )
        except OSError:
            pass
    orphan_temp_dirs.sort(key=lambda x: x["relpath"])

    return {
        "repo_root": str(repo_root),
        "protected_files": protected_files,
        "protected_reasons": protected_reasons,
        "accounting": acc.to_dict(),
        "protected_summary": {
            "total_protected_files": len(protected_files),
            "git_tracked_files": len(tracked_files),
            "sha_manifests": len(sha_manifests),
            "sha_pinned_files": sha_pinned_files,
            "bundles_found": len(bundle_paths),
            "bundle_preserved_refs": bundle_preserved_count,
        },
        "repo_tmp_exists": repo_tmp_exists,
        "repo_tmp_gitignored": repo_tmp_gitignored,
        "root_clutter": root_clutter,
        "broken_integrity_refs": broken_integrity_refs,
        "unignored_large_untracked": unignored_large_untracked,
        "orphan_temp_dirs": orphan_temp_dirs,
        "large_unprotected_candidates": large_unprotected_candidates,
    }


# ---------------------------------------------------------------------------
# Subcommand 1: check-path
# ---------------------------------------------------------------------------


def _check_reserved_and_control(raw_target: str) -> list[dict[str, str]]:
    violations: list[dict[str, str]] = []
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in raw_target):
        violations.append({"code": "CONTROL_CHAR", "detail": "Path contains ASCII control characters"})
    # Split on both / and \ regardless of host OS for cross-platform safety
    parts = re.split(r"[/\\]+", raw_target)
    for part in parts:
        if not part or part in (".", ".."):
            continue
        if len(part) == 2 and part[1] == ":" and part[0].isalpha():
            continue
        stripped = part.rstrip(" .")
        stem = stripped.split(".", 1)[0].upper()
        if stem in WINDOWS_RESERVED_NAMES:
            violations.append(
                {
                    "code": "RESERVED_DEVICE_NAME",
                    "detail": f"Path component {part!r} uses Windows reserved device name {stem!r}",
                }
            )
    return violations


def _is_desktop_path(raw_target: str, resolved_path: Path) -> bool:
    home_desktop = (Path.home() / "Desktop").resolve()
    if is_subpath_lexical(resolved_path, home_desktop):
        return True
    parts = [p.lower() for p in re.split(r"[/\\]+", raw_target) if p]
    for i, comp in enumerate(parts):
        if comp == "desktop" and i >= 1 and parts[i - 1] not in ("src", "docs", "tests", "assets"):
            if any(p in ("users", "home") for p in parts[:i]):
                return True
    return False


def _is_adhoc_temp_path(raw_target: str, resolved_path: Path, repo_root: Path) -> bool:
    if ADHOC_DRIVE_TEMP_RE.match(raw_target.strip()):
        return True
    if ADHOC_POSIX_TEMP_RE.match(raw_target.strip()):
        return True
    if _is_desktop_path(raw_target, resolved_path):
        return True
    # Sibling ../tmp* outside repo_root
    if not is_subpath_lexical(resolved_path, repo_root):
        rel_parent = to_rel_posix(resolved_path, repo_root.parent)
        if rel_parent:
            first = rel_parent.split("/", 1)[0].lower()
            if first.startswith(("tmp", "temp", "_tmp", "_scratch")):
                return True
    return False


def _detect_escaping_reparse(target_abs: Path, allowed_roots: list[Path]) -> str | None:
    """Walk existing components of target_abs; detect any symlink/reparse point escaping allowed_roots."""
    candidates: list[Path] = []
    cur = target_abs
    while True:
        candidates.append(cur)
        if cur.parent == cur:
            break
        cur = cur.parent
    candidates.reverse()

    for comp in candidates:
        if is_reparse_or_link(comp):
            real_comp = Path(os.path.realpath(str(comp)))
            if not any(is_subpath_lexical(real_comp, ar) for ar in allowed_roots):
                return f"Reparse/symlink component {comp} resolves outside allowed root to {real_comp}"
    return None


def cmd_check_path(args: argparse.Namespace) -> int:
    repo_root = _resolve_repo_root(args.repo_root, as_json=args.json)
    if repo_root is None:
        return 2
    raw_target = args.target
    intent = args.intent
    allowed_ext = [Path(os.path.realpath(str(Path(p).expanduser()))) for p in (args.allow_external_prefix or [])]

    violations = _check_reserved_and_control(raw_target)

    # Construct lexical absolute target without dereferencing symlinks
    raw_path = Path(raw_target).expanduser()
    if raw_path.is_absolute():
        target_abs = Path(os.path.abspath(str(raw_path)))
    else:
        target_abs = Path(os.path.abspath(str(repo_root / raw_path)))

    os_temp_root = Path(os.path.realpath(tempfile.gettempdir()))

    if intent == "persistent":
        allowed_roots = [repo_root, *allowed_ext]
        in_allowed_lexical = any(is_subpath_lexical(target_abs, r) for r in allowed_roots)
        if not in_allowed_lexical:
            violations.append(
                {
                    "code": "OUTSIDE_REPO_ROOT",
                    "detail": f"Persistent target {target_abs} escapes repo_root {repo_root}",
                }
            )
        reparse_err = _detect_escaping_reparse(target_abs, allowed_roots)
        if reparse_err:
            violations.append({"code": "REPARSE_OR_SYMLINK_ESCAPE", "detail": reparse_err})
        if _is_adhoc_temp_path(raw_target, target_abs, repo_root) and not any(
            is_subpath_lexical(target_abs, r) for r in allowed_ext
        ):
            violations.append(
                {
                    "code": "ADHOC_TEMP_PATH",
                    "detail": f"Ad-hoc drive-root, sibling temp, or Desktop path is forbidden: {raw_target}",
                }
            )
        rel_in_repo = to_rel_posix(target_abs, repo_root)
        if rel_in_repo is not None and rel_in_repo != "":
            parts = rel_in_repo.split("/")
            if len(parts) == 1 and is_root_clutter_name(parts[0], allow_dot_tmp_dir=False):
                violations.append(
                    {
                        "code": "ROOT_CLUTTER",
                        "detail": f"Root-level clutter filename {parts[0]!r} is forbidden at repository root",
                    }
                )

    elif intent == "temp":
        repo_tmp_root = repo_root / ".tmp"
        in_repo = is_subpath_lexical(target_abs, repo_root)
        in_repo_tmp = is_subpath_lexical(target_abs, repo_tmp_root)
        in_os_temp = is_subpath_lexical(target_abs, os_temp_root)

        if in_repo:
            if not in_repo_tmp:
                violations.append(
                    {
                        "code": "INVALID_TEMP_LOCATION",
                        "detail": (
                            f"Repo-local temp target must live under gitignored {repo_tmp_root}/<run_id>/..."
                        ),
                    }
                )
            else:
                if not is_repo_tmp_gitignored(repo_root):
                    violations.append(
                        {
                            "code": "REPO_TMP_NOT_GITIGNORED",
                            "detail": f"{repo_tmp_root} must be ignored by .gitignore before temp use",
                        }
                    )
                rel_rt = to_rel_posix(target_abs, repo_tmp_root) or ""
                parts = [p for p in rel_rt.split("/") if p]
                if len(parts) < 2:
                    violations.append(
                        {
                            "code": "BARE_TEMP_PATH",
                            "detail": "Repo temp target must be under <repo_root>/.tmp/<run_id>/...",
                        }
                    )
                reparse_err = _detect_escaping_reparse(target_abs, [repo_tmp_root])
                if reparse_err:
                    violations.append({"code": "REPARSE_OR_SYMLINK_ESCAPE", "detail": reparse_err})
        elif _is_adhoc_temp_path(raw_target, target_abs, repo_root):
            violations.append(
                {
                    "code": "ADHOC_TEMP_PATH",
                    "detail": f"Ad-hoc temp location forbidden: {raw_target}",
                }
            )
        elif in_os_temp:
            rel_os = to_rel_posix(target_abs, os_temp_root) or ""
            parts = [p for p in rel_os.split("/") if p]
            if len(parts) < 2:
                violations.append(
                    {
                        "code": "BARE_TEMP_PATH",
                        "detail": f"Temp target must be under a scoped subdirectory of {os_temp_root}",
                    }
                )
            reparse_err = _detect_escaping_reparse(target_abs, [os_temp_root])
            if reparse_err:
                violations.append({"code": "REPARSE_OR_SYMLINK_ESCAPE", "detail": reparse_err})
        else:
            violations.append(
                {
                    "code": "INVALID_TEMP_LOCATION",
                    "detail": (
                        f"Temp target must live under {os_temp_root}/<scoped_subdir>/... "
                        f"or gitignored {repo_tmp_root}/<run_id>/..."
                    ),
                }
            )

    elif intent == "external":
        if not allowed_ext or not any(is_subpath_lexical(target_abs, r) for r in allowed_ext):
            violations.append(
                {
                    "code": "EXTERNAL_NOT_ALLOWLISTED",
                    "detail": f"External target {target_abs} does not match any --allow-external-prefix",
                }
            )
        else:
            reparse_err = _detect_escaping_reparse(target_abs, allowed_ext)
            if reparse_err:
                violations.append({"code": "REPARSE_OR_SYMLINK_ESCAPE", "detail": reparse_err})

    ok = len(violations) == 0
    result = {
        "ok": ok,
        "intent": intent,
        "repo_root": str(repo_root),
        "target": raw_target,
        "canonical_path": str(target_abs),
        "violations": violations,
    }
    emit_output(result, as_json=args.json, human_ok=f"OK [{intent}]: {target_abs}")
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# Subcommand 2: alloc-temp
# ---------------------------------------------------------------------------


def cmd_alloc_temp(args: argparse.Namespace) -> int:
    repo_root = _resolve_repo_root(args.repo_root, as_json=args.json)
    if repo_root is None:
        return 2
    tier = args.tier
    task_raw = (args.task or "").strip()
    owner = (args.owner or "").strip()
    pid = int(args.pid)
    ttl_sec = int(args.ttl_sec)
    if pid < 1 or ttl_sec < 0 or not task_raw or not owner:
        emit_output(
            {
                "ok": False,
                "code": "INVALID_ARGUMENT",
                "detail": "alloc-temp requires pid >= 1, ttl_sec >= 0, and non-empty --task / --owner",
            },
            as_json=args.json,
        )
        return 2
    project = sanitize_slug(args.project or repo_root.name, fallback="project")
    task = sanitize_slug(task_raw, fallback="task")

    if tier == "repo":
        if not is_repo_tmp_gitignored(repo_root):
            payload = {
                "ok": False,
                "code": "REPO_TMP_NOT_GITIGNORED",
                "detail": f"Fail-closed: {repo_root / '.tmp'} is not ignored by Git (.gitignore).",
                "repo_root": str(repo_root),
            }
            emit_output(payload, as_json=args.json)
            return 2
        base_dir = repo_root / ".tmp"
    else:
        base_dir = Path(os.path.realpath(tempfile.gettempdir()))

    if base_dir.exists() and is_reparse_or_link(base_dir):
        payload = {
            "ok": False,
            "code": "BASE_DIR_IS_REPARSE",
            "detail": f"Refusing to allocate under reparse/symlink base dir: {base_dir}",
        }
        emit_output(payload, as_json=args.json)
        return 2

    base_dir.mkdir(parents=True, exist_ok=True)
    nonce8 = secrets.token_hex(4)
    dirname = f"{project}-{utc_now_compact()}-pid{pid}-{nonce8}-{task}"
    lease_dir = base_dir / dirname
    lease_dir.mkdir(parents=True, exist_ok=False)
    canonical_path = str(Path(os.path.realpath(str(lease_dir))))

    _alive, start_token = inspect_process(pid)
    lease_doc: dict[str, Any] = {
        "schema": TEMP_LEASE_SCHEMA,
        "schema_version": 1,
        "repo_root": str(repo_root),
        "project": project,
        "tier": tier,
        "owner": owner,
        "task": task,
        "pid": pid,
        "process_start_token": start_token or "unknown",
        "created_at_utc": utc_now_iso(),
        "ttl_sec": ttl_sec,
        "canonical_path": canonical_path,
    }
    lease_doc["lease_sha256"] = compute_canonical_sha256(lease_doc, "lease_sha256")
    lease_path = lease_dir / TEMP_LEASE_FILENAME
    atomic_write_json(lease_path, lease_doc)

    result = {
        "ok": True,
        "tier": tier,
        "canonical_path": canonical_path,
        "lease_file": str(lease_path),
        "lease": lease_doc,
    }
    emit_output(result, as_json=args.json, human_ok=f"ALLOCATED [{tier}]: {canonical_path}")
    return 0


# ---------------------------------------------------------------------------
# Subcommand 3: reclaim-temp
# ---------------------------------------------------------------------------


def classify_temp_candidate(
    candidate: Path,
    *,
    grace_sec: int,
    now_ts: float,
    os_tier: bool,
    expected_repo_root: str | None = None,
    expected_project: str | None = None,
) -> dict[str, Any]:
    """Classify a single temp directory candidate without modifying disk."""
    if is_reparse_or_link(candidate):
        if os_tier:
            return {"path": str(candidate), "decision": "HOLD_REPARSE_OS", "reason": "skip_reparse_in_os_temp"}
        try:
            age = now_ts - os.lstat(candidate).st_mtime
        except OSError:
            age = 0.0
        if age > grace_sec:
            return {
                "path": str(candidate),
                "decision": "RECLAIM_LINK_ONLY",
                "reason": f"unleased_reparse_age_{int(age)}s_gt_{grace_sec}s",
            }
        return {"path": str(candidate), "decision": "HOLD_GRACE_PERIOD", "reason": "reparse_within_grace"}

    lease_file = candidate / TEMP_LEASE_FILENAME
    if lease_file.is_file() and not is_reparse_or_link(lease_file):
        try:
            lease = json.loads(lease_file.read_text(encoding="utf-8"))
        except Exception:
            lease = None

        if isinstance(lease, dict) and lease.get("schema") == TEMP_LEASE_SCHEMA:
            expected_sha = lease.get("lease_sha256")
            recomputed = compute_canonical_sha256(lease, "lease_sha256")
            if expected_sha != recomputed:
                return {"path": str(candidate), "decision": "HOLD_INVALID_LEASE", "reason": "lease_sha256_mismatch"}

            if os_tier:
                lease_repo = str(lease.get("repo_root") or "")
                lease_proj = str(lease.get("project") or "")
                repo_match = expected_repo_root and norm_key(lease_repo) == norm_key(expected_repo_root)
                proj_match = expected_project and lease_proj == expected_project
                if not (repo_match or proj_match):
                    return {"path": str(candidate), "decision": "SKIP_FOREIGN_LEASE", "reason": "different_project"}

            pid = lease.get("pid")
            expected_token = str(lease.get("process_start_token") or "unknown")
            alive, current_token = inspect_process(int(pid)) if isinstance(pid, int) else (False, None)

            if alive:
                if (
                    expected_token not in ("", "unknown", "win-access-denied")
                    and current_token not in (None, "", "unknown", "win-access-denied")
                    and expected_token != current_token
                ):
                    return {
                        "path": str(candidate),
                        "decision": "RECLAIM_PID_REUSED",
                        "reason": f"pid_{pid}_start_token_mismatch",
                        "pid": pid,
                    }
                return {
                    "path": str(candidate),
                    "decision": "HOLD_ACTIVE",
                    "reason": f"pid_{pid}_alive",
                    "pid": pid,
                }
            return {
                "path": str(candidate),
                "decision": "RECLAIM_DEAD_PID",
                "reason": f"pid_{pid}_not_running",
                "pid": pid,
            }

    if os_tier:
        return {"path": str(candidate), "decision": "SKIP_UNLEASED_OS", "reason": "no_valid_dw_lease"}

    try:
        age = now_ts - os.lstat(candidate).st_mtime
    except OSError:
        age = 0.0
    if age > grace_sec:
        return {
            "path": str(candidate),
            "decision": "RECLAIM_UNLEASED_EXPIRED",
            "reason": f"unleased_age_{int(age)}s_gt_{grace_sec}s",
        }
    return {
        "path": str(candidate),
        "decision": "HOLD_GRACE_PERIOD",
        "reason": f"unleased_age_{int(age)}s_le_{grace_sec}s",
    }


def cmd_reclaim_temp(args: argparse.Namespace) -> int:
    if args.dry_run and args.execute:
        emit_output({"ok": False, "code": "CONFLICTING_FLAGS", "detail": "Specify either --dry-run or --execute"}, as_json=args.json)
        return 2
    dry_run = not args.execute

    repo_root = _resolve_repo_root(args.repo_root, as_json=args.json)
    if repo_root is None:
        return 2
    grace_sec = int(args.grace_sec)
    if grace_sec < 0:
        emit_output(
            {"ok": False, "code": "INVALID_ARGUMENT", "detail": "--grace-sec must be >= 0"},
            as_json=args.json,
        )
        return 2
    project = sanitize_slug(args.project or repo_root.name, fallback="project")
    now_ts = time.time()

    candidates: list[tuple[Path, bool]] = []
    repo_tmp = repo_root / ".tmp"
    if repo_tmp.exists():
        if is_reparse_or_link(repo_tmp):
            emit_output(
                {"ok": False, "code": "REPO_TMP_IS_REPARSE", "detail": f"Refusing to traverse reparse dir {repo_tmp}"},
                as_json=args.json,
            )
            return 2
        if repo_tmp.is_dir():
            with os.scandir(repo_tmp) as it:
                for entry in sorted(it, key=lambda e: e.name):
                    candidates.append((Path(entry.path), False))

    if args.scan_os_temp:
        os_temp = Path(os.path.realpath(tempfile.gettempdir()))
        if os_temp.is_dir():
            prefix = f"{project}-"
            try:
                with os.scandir(os_temp) as it:
                    for entry in sorted(it, key=lambda e: e.name):
                        if not entry.name.startswith(prefix):
                            continue
                        p = Path(entry.path)
                        if (p / TEMP_LEASE_FILENAME).is_file():
                            candidates.append((p, True))
            except OSError:
                pass

    entries: list[dict[str, Any]] = []
    reclaimed_count = 0
    held_count = 0
    total_bytes_reclaimed = 0
    total_reparse_unlinked = 0

    for cand, is_os in candidates:
        info = classify_temp_candidate(
            cand,
            grace_sec=grace_sec,
            now_ts=now_ts,
            os_tier=is_os,
            expected_repo_root=str(repo_root),
            expected_project=project,
        )
        info["tier"] = "os" if is_os else "repo"
        dec = info["decision"]
        if dec.startswith("SKIP_"):
            continue
        if dec.startswith("RECLAIM_"):
            if not dry_run:
                rm_stats = safe_rmtree(cand)
                info["reclaimed"] = True
                info["rm_stats"] = rm_stats
                total_bytes_reclaimed += rm_stats["bytes_reclaimed"]
                total_reparse_unlinked += rm_stats["reparse_links_unlinked"]
            else:
                info["reclaimed"] = False
            reclaimed_count += 1
        else:
            info["reclaimed"] = False
            held_count += 1
        entries.append(info)

    result = {
        "ok": True,
        "dry_run": dry_run,
        "repo_root": str(repo_root),
        "project": project,
        "grace_sec": grace_sec,
        "reclaim_candidates": reclaimed_count,
        "held_count": held_count,
        "bytes_reclaimed": total_bytes_reclaimed,
        "reparse_links_unlinked": total_reparse_unlinked,
        "created_at_utc": utc_now_iso(),
        "entries": entries,
    }
    if args.receipt_out:
        receipt_path = Path(args.receipt_out).expanduser()
        atomic_write_json(receipt_path, result)
        result["receipt_out"] = str(receipt_path)

    emit_output(
        result,
        as_json=args.json,
        human_ok=f"RECLAIM ({'DRY-RUN' if dry_run else 'EXECUTE'}): candidates={reclaimed_count}, held={held_count}",
    )
    return 0


# ---------------------------------------------------------------------------
# Subcommand 4: audit
# ---------------------------------------------------------------------------


def cmd_audit(args: argparse.Namespace) -> int:
    repo_root = _resolve_repo_root(args.repo_root, as_json=args.json)
    if repo_root is None:
        return 2
    large_mb = float(args.large_file_mb)
    orphan_grace_sec = int(args.orphan_grace_sec)
    if not math.isfinite(large_mb) or large_mb <= 0 or orphan_grace_sec < 0:
        emit_output(
            {
                "ok": False,
                "code": "INVALID_ARGUMENT",
                "detail": "--large-file-mb must be > 0 and --orphan-grace-sec must be >= 0",
            },
            as_json=args.json,
        )
        return 2
    large_bytes = max(1, int(large_mb * 1024 * 1024))
    state = scan_workspace_state(
        repo_root,
        protected_globs=args.protected_glob or [],
        large_file_bytes=large_bytes,
        orphan_grace_sec=orphan_grace_sec,
    )

    tmp_ok = (not state["repo_tmp_exists"]) or bool(state["repo_tmp_gitignored"])
    check_passed = (
        len(state["root_clutter"]) == 0
        and len(state["broken_integrity_refs"]) == 0
        and len(state["unignored_large_untracked"]) == 0
        and tmp_ok
    )

    report = {
        "ok": True if not args.check else check_passed,
        "check_mode": bool(args.check),
        "check_passed": check_passed,
        "created_at_utc": utc_now_iso(),
        "repo_root": state["repo_root"],
        "accounting": state["accounting"],
        "protected_summary": state["protected_summary"],
        "repo_tmp_exists": state["repo_tmp_exists"],
        "repo_tmp_gitignored": state["repo_tmp_gitignored"],
        "root_clutter": state["root_clutter"],
        "broken_integrity_refs": state["broken_integrity_refs"],
        "unignored_large_untracked": state["unignored_large_untracked"],
        "orphan_temp_dirs": state["orphan_temp_dirs"],
        "large_unprotected_candidates": state["large_unprotected_candidates"],
    }

    if args.json_out:
        out_path = Path(args.json_out).expanduser()
        atomic_write_json(out_path, report)
        report["json_out"] = str(out_path)

    emit_output(
        report,
        as_json=args.json,
        human_ok=(
            f"AUDIT: files={report['accounting']['file_count']}, "
            f"logical={report['accounting']['logical_bytes']}B, "
            f"physical={report['accounting']['physical_bytes']}B, "
            f"check_passed={check_passed}"
        ),
    )
    if args.check and not check_passed:
        return 1
    return 0


# ---------------------------------------------------------------------------
# Subcommand 5: dehydrate
# ---------------------------------------------------------------------------


def _resolve_in_slot_or_repo(raw: str, slot_dir: Path, repo_root: Path) -> Path:
    p = Path(raw).expanduser()
    if p.is_absolute():
        return Path(os.path.abspath(str(p)))
    cand_slot = Path(os.path.abspath(str(slot_dir / p)))
    if cand_slot.exists():
        return cand_slot
    cand_repo = Path(os.path.abspath(str(repo_root / p)))
    if cand_repo.exists():
        return cand_repo
    return cand_slot


def cmd_dehydrate(args: argparse.Namespace) -> int:
    if args.dry_run and args.execute:
        emit_output({"ok": False, "code": "CONFLICTING_FLAGS", "detail": "Specify either --dry-run or --execute"}, as_json=args.json)
        return 2
    dry_run = not args.execute

    repo_root = _resolve_repo_root(args.repo_root, as_json=args.json)
    if repo_root is None:
        return 2
    slot_dir = _resolve_cli_dir(args.slot_dir, repo_root)
    receipt_dir = _resolve_cli_dir(args.receipt_dir, repo_root)

    failed_gates: list[dict[str, Any]] = []

    # Build ProtectedSet dynamically
    state = scan_workspace_state(repo_root)
    protected_files: set[str] = state["protected_files"]

    # Resolve targets
    resolved_targets: list[Path] = []
    target_keys: set[str] = set()
    slot_reparse_err = _detect_escaping_reparse(slot_dir, [repo_root])
    if (
        not slot_dir.is_dir()
        or is_reparse_or_link(slot_dir)
        or slot_dir == repo_root
        or not is_subpath_lexical(slot_dir, repo_root)
        or slot_reparse_err is not None
    ):
        failed_gates.append({"gate": 1, "code": "GATE1_INVALID_SLOT_DIR", "detail": f"Invalid slot_dir: {slot_dir}"})

    for raw_t in args.target:
        tp = _resolve_in_slot_or_repo(raw_t, slot_dir, repo_root)
        rel_in_slot = to_rel_posix(tp, slot_dir)
        rel_in_repo = to_rel_posix(tp, repo_root)
        if rel_in_slot is None or not rel_in_slot:
            failed_gates.append({"gate": 1, "code": "GATE1_TARGET_OUTSIDE_SLOT", "detail": f"Target outside slot_dir: {raw_t}"})
            continue
        if is_reparse_or_link(tp) or _detect_escaping_reparse(tp, [slot_dir]) is not None:
            failed_gates.append({"gate": 1, "code": "GATE1_TARGET_REPARSE", "detail": f"Target is symlink/reparse: {raw_t}"})
            continue
        if not tp.is_file():
            failed_gates.append({"gate": 1, "code": "GATE1_TARGET_MISSING", "detail": f"Target does not exist as regular file: {raw_t}"})
            continue
        tkey = norm_key(str(tp))
        if tkey in target_keys:
            failed_gates.append({"gate": 1, "code": "GATE1_DUPLICATE_TARGET", "detail": f"Duplicate target specified: {raw_t}"})
            continue
        if rel_in_repo is not None and norm_key(rel_in_repo) in protected_files:
            failed_gates.append(
                {
                    "gate": 1,
                    "code": "GATE1_TARGET_PROTECTED",
                    "detail": f"Target {rel_in_repo} is in ProtectedSet ({state['protected_reasons'].get(norm_key(rel_in_repo), 'protected')})",
                }
            )
            continue
        resolved_targets.append(tp)
        target_keys.add(tkey)

    # Gate 2: Conflicting processes
    conflicts = find_conflicting_processes(args.conflict_proc_substr or [])
    if conflicts:
        failed_gates.append(
            {
                "gate": 2,
                "code": "GATE2_CONFLICT_PROCESS",
                "detail": f"Found {len(conflicts)} conflicting live process(es)",
                "processes": conflicts,
            }
        )

    # Gate 3: Preserved artifacts + parameters_ref + engine metadata valid & non-overlapping
    if not (args.command_template or "").strip() or not (args.engine_version or "").strip():
        failed_gates.append(
            {
                "gate": 3,
                "code": "GATE3_ENGINE_METADATA_INVALID",
                "detail": "--command-template and --engine-version must be non-empty",
            }
        )

    resolved_preserved: list[Path] = []
    for raw_p in args.preserve:
        pp = _resolve_in_slot_or_repo(raw_p, slot_dir, repo_root)
        if norm_key(str(pp)) in target_keys:
            failed_gates.append({"gate": 3, "code": "GATE3_TARGET_PRESERVE_OVERLAP", "detail": f"Target overlaps preserve: {raw_p}"})
            continue
        if (
            not is_subpath_lexical(pp, repo_root)
            or is_reparse_or_link(pp)
            or _detect_escaping_reparse(pp, [repo_root]) is not None
            or not pp.is_file()
        ):
            failed_gates.append({"gate": 3, "code": "GATE3_PRESERVED_INVALID", "detail": f"Preserved file missing, outside repo, or reparse: {raw_p}"})
            continue
        if os.lstat(pp).st_size <= 0:
            failed_gates.append({"gate": 3, "code": "GATE3_PRESERVED_INVALID", "detail": f"Preserved file is empty (0 bytes): {raw_p}"})
            continue
        resolved_preserved.append(pp)

    params_path = _resolve_in_slot_or_repo(args.parameters_ref, slot_dir, repo_root)
    if norm_key(str(params_path)) in target_keys:
        failed_gates.append({"gate": 3, "code": "GATE3_TARGET_PRESERVE_OVERLAP", "detail": "parameters_ref overlaps target"})
    elif (
        not is_subpath_lexical(params_path, repo_root)
        or is_reparse_or_link(params_path)
        or _detect_escaping_reparse(params_path, [repo_root]) is not None
        or not params_path.is_file()
        or os.lstat(params_path).st_size <= 0
    ):
        failed_gates.append(
            {"gate": 3, "code": "GATE3_PARAMETERS_INVALID", "detail": f"parameters_ref missing, outside repo, reparse, or empty: {args.parameters_ref}"}
        )

    # Gate 4: proof-ref valid JSON with status == VERIFIED
    proof_path = _resolve_in_slot_or_repo(args.proof_ref, slot_dir, repo_root)
    if (
        not is_subpath_lexical(proof_path, repo_root)
        or is_reparse_or_link(proof_path)
        or _detect_escaping_reparse(proof_path, [repo_root]) is not None
        or not proof_path.is_file()
    ):
        failed_gates.append({"gate": 4, "code": "GATE4_PROOF_MISSING", "detail": f"proof_ref missing, outside repo, or reparse: {args.proof_ref}"})
    else:
        try:
            proof_doc = json.loads(proof_path.read_text(encoding="utf-8"))
        except Exception as exc:
            proof_doc = None
            failed_gates.append({"gate": 4, "code": "GATE4_PROOF_INVALID_JSON", "detail": f"proof_ref JSON error: {exc}"})
        if proof_doc is not None and (not isinstance(proof_doc, dict) or proof_doc.get("status") != "VERIFIED"):
            failed_gates.append(
                {
                    "gate": 4,
                    "code": "GATE4_PROOF_NOT_VERIFIED",
                    "detail": f"proof_ref status must be 'VERIFIED', got {proof_doc.get('status') if isinstance(proof_doc, dict) else type(proof_doc).__name__!r}",
                }
            )

    # Gate 5: receipt-dir clean & free of escaping reparse
    if is_subpath_lexical(receipt_dir, repo_root) and _detect_escaping_reparse(receipt_dir, [repo_root]) is not None:
        failed_gates.append(
            {
                "gate": 5,
                "code": "GATE5_INVALID_RECEIPT_DIR",
                "detail": f"receipt_dir contains an escaping symlink/reparse point: {receipt_dir}",
            }
        )
    receipt_json_path = receipt_dir / DEHYDRATION_RECEIPT_FILENAME
    receipt_sha_path = receipt_dir / "SHA256SUMS"
    if receipt_json_path.exists() or receipt_sha_path.exists():
        failed_gates.append(
            {
                "gate": 5,
                "code": "GATE5_RECEIPT_EXISTS",
                "detail": f"Receipt artifacts already exist in {receipt_dir}",
            }
        )

    # Gate 6: no conflicting existing bundle in slot_dir
    bundle_path = slot_dir / DW_BUNDLE_FILENAME
    legacy_bundle_path = slot_dir / MPH_BUNDLE_FILENAME
    if bundle_path.exists() or legacy_bundle_path.exists():
        failed_gates.append(
            {
                "gate": 6,
                "code": "GATE6_BUNDLE_EXISTS",
                "detail": f"Existing dehydrated bundle found in {slot_dir}",
            }
        )

    if failed_gates:
        payload = {
            "ok": False,
            "dry_run": dry_run,
            "failed_gates": failed_gates,
        }
        emit_output(payload, as_json=args.json)
        return 2

    if dry_run:
        target_bytes = sum(os.lstat(t).st_size for t in resolved_targets)
        payload = {
            "ok": True,
            "dry_run": True,
            "slot_dir": str(slot_dir),
            "targets": [to_rel_posix(t, repo_root) or str(t) for t in resolved_targets],
            "preserved": [to_rel_posix(p, repo_root) or str(p) for p in resolved_preserved],
            "reclaimable_bytes": target_bytes,
            "gates_passed": 6,
        }
        emit_output(payload, as_json=args.json, human_ok=f"DEHYDRATE DRY-RUN OK: {len(resolved_targets)} targets ({target_bytes}B)")
        return 0

    # Atomic execute order:
    # 1. Hash preserved, parameters, proof, and targets
    preserved_records: list[dict[str, Any]] = []
    for pp in resolved_preserved:
        digest, size_b = sha256_file(pp)
        preserved_records.append(
            {
                "relpath": to_rel_posix(pp, repo_root) or str(pp),
                "slot_relpath": to_rel_posix(pp, slot_dir) or pp.name,
                "size_bytes": size_b,
                "sha256": digest,
            }
        )
    params_sha, params_size = sha256_file(params_path)
    proof_sha, proof_size = sha256_file(proof_path)

    target_records: list[dict[str, Any]] = []
    for tp in resolved_targets:
        st = os.lstat(tp)
        digest, size_b = sha256_file(tp)
        target_records.append(
            {
                "relpath": to_rel_posix(tp, repo_root) or str(tp),
                "slot_relpath": to_rel_posix(tp, slot_dir) or tp.name,
                "size_bytes": size_b,
                "sha256": digest,
                "st_dev": int(st.st_dev),
                "st_ino": int(st.st_ino),
            }
        )

    bundle_doc: dict[str, Any] = {
        "schema": DW_BUNDLE_SCHEMA,
        "schema_version": 1,
        "created_at_utc": utc_now_iso(),
        "repo_root": str(repo_root),
        "slot_relpath": to_rel_posix(slot_dir, repo_root) or "",
        "reproducibility_tier": args.reproducibility_tier,
        "engine": {
            "version": args.engine_version,
            "command_template": args.command_template,
            "seed": args.seed,
        },
        "parameters_ref": {
            "relpath": to_rel_posix(params_path, repo_root) or str(params_path),
            "size_bytes": params_size,
            "sha256": params_sha,
        },
        "proof_ref": {
            "relpath": to_rel_posix(proof_path, repo_root) or str(proof_path),
            "status": "VERIFIED",
            "size_bytes": proof_size,
            "sha256": proof_sha,
        },
        "dehydrated_targets": target_records,
        "preserved_artifacts": preserved_records,
    }
    bundle_doc["bundle_sha256"] = compute_canonical_sha256(bundle_doc, "bundle_sha256")

    # 2. Atomic write bundle
    bundle_file_sha, bundle_file_bytes = atomic_write_json(bundle_path, bundle_doc)

    # 3. Re-read & verify 100% hashes + bundle_sha256 BEFORE deleting any target!
    verify_ok, verify_errors, _ = verify_dw_bundle(bundle_path, repo_root)
    if not verify_ok:
        emit_output(
            {
                "ok": False,
                "code": "POST_WRITE_BUNDLE_VERIFY_FAILED",
                "errors": verify_errors,
            },
            as_json=args.json,
        )
        return 2

    # 4. Unlink targets safely
    reclaimed_bytes = 0
    for tp in resolved_targets:
        if is_reparse_or_link(tp):
            emit_output({"ok": False, "code": "TARGET_BECAME_REPARSE", "detail": str(tp)}, as_json=args.json)
            return 2
        reclaimed_bytes += int(os.lstat(tp).st_size)
        os.unlink(tp)

    # 5. Write receipt & SHA256SUMS
    receipt_dir.mkdir(parents=True, exist_ok=True)
    receipt_doc: dict[str, Any] = {
        "schema": DEHYDRATION_RECEIPT_SCHEMA,
        "schema_version": 1,
        "created_at_utc": utc_now_iso(),
        "repo_root": str(repo_root),
        "slot_relpath": to_rel_posix(slot_dir, repo_root) or "",
        "bundle_relpath": to_rel_posix(bundle_path, repo_root) or str(bundle_path),
        "bundle_file_sha256": bundle_file_sha,
        "bundle_file_bytes": bundle_file_bytes,
        "bundle_sha256": bundle_doc["bundle_sha256"],
        "reclaimed_bytes": reclaimed_bytes,
        "dehydrated_targets": target_records,
        "preserved_artifacts": preserved_records,
    }
    receipt_sha, _receipt_bytes = atomic_write_json(receipt_json_path, receipt_doc)

    bundle_ref_for_sha = to_rel_posix(bundle_path, repo_root) or str(bundle_path)
    sha_lines = [
        f"{receipt_sha}  {DEHYDRATION_RECEIPT_FILENAME}",
        f"{bundle_file_sha}  {bundle_ref_for_sha}",
    ]
    atomic_write_text(receipt_sha_path, "\n".join(sha_lines) + "\n")

    result = {
        "ok": True,
        "dry_run": False,
        "bundle_path": str(bundle_path),
        "receipt_path": str(receipt_json_path),
        "sha256sums_path": str(receipt_sha_path),
        "reclaimed_bytes": reclaimed_bytes,
        "targets_removed": len(resolved_targets),
        "preserved_verified": len(preserved_records),
    }
    emit_output(result, as_json=args.json, human_ok=f"DEHYDRATED: {len(resolved_targets)} targets ({reclaimed_bytes}B)")
    return 0


# ---------------------------------------------------------------------------
# Subcommand 6: verify-bundles
# ---------------------------------------------------------------------------


def verify_dw_bundle(bundle_path: Path, repo_root: Path) -> tuple[bool, list[str], int]:
    errors: list[str] = []
    files_checked = 0
    try:
        doc = json.loads(bundle_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return False, [f"json_parse_error:{exc}"], 0
    if not isinstance(doc, dict):
        return False, ["bundle_not_object"], 0

    if doc.get("schema") != DW_BUNDLE_SCHEMA or doc.get("schema_version") != 1:
        errors.append(f"invalid_schema:{doc.get('schema')!r}/{doc.get('schema_version')!r}")

    b_sha = doc.get("bundle_sha256")
    if not isinstance(b_sha, str) or not HEX64_RE.fullmatch(b_sha):
        errors.append("invalid_bundle_sha256_format")
    else:
        recomputed = compute_canonical_sha256(doc, "bundle_sha256")
        if b_sha.lower() != recomputed:
            errors.append("bundle_sha256_mismatch")

    targets = doc.get("dehydrated_targets")
    if not isinstance(targets, list) or not targets:
        errors.append("empty_dehydrated_targets")
    else:
        for t in targets:
            if not isinstance(t, dict):
                errors.append("invalid_target_entry")
                continue
            d = t.get("sha256")
            sz = t.get("size_bytes")
            if not isinstance(d, str) or not HEX64_RE.fullmatch(d):
                errors.append(f"invalid_target_sha256:{t.get('relpath')!r}")
            if isinstance(sz, bool) or not isinstance(sz, int) or sz <= 0:
                errors.append(f"invalid_target_size:{t.get('relpath')!r}")

    def check_file_ref(label: str, entry: Any) -> None:
        nonlocal files_checked
        if not isinstance(entry, dict):
            errors.append(f"invalid_{label}_entry")
            return
        rel = entry.get("relpath")
        exp_sha = entry.get("sha256")
        exp_sz = entry.get("size_bytes")
        if not isinstance(rel, str) or not rel:
            errors.append(f"missing_relpath:{label}")
            return
        if not isinstance(exp_sha, str) or not HEX64_RE.fullmatch(exp_sha):
            errors.append(f"invalid_sha256:{label}:{rel}")
            return
        if isinstance(exp_sz, bool) or not isinstance(exp_sz, int) or exp_sz <= 0:
            errors.append(f"invalid_size_bytes:{label}:{rel}")
            return
        p = Path(os.path.abspath(str(repo_root / rel)))
        if (
            Path(rel).is_absolute()
            or not is_subpath_lexical(p, repo_root)
            or is_reparse_or_link(p)
            or _detect_escaping_reparse(p, [repo_root]) is not None
        ):
            errors.append(f"escaping_or_reparse_path:{label}:{rel}")
            return
        if not p.is_file():
            errors.append(f"missing_preserved_file:{rel}")
            return
        actual_sha, actual_sz = sha256_file(p)
        files_checked += 1
        if actual_sz != exp_sz:
            errors.append(f"size_mismatch:{rel}:{actual_sz}!={exp_sz}")
        if actual_sha != exp_sha.lower():
            errors.append(f"sha256_mismatch:{rel}")

    preserved = doc.get("preserved_artifacts")
    if not isinstance(preserved, list) or not preserved:
        errors.append("empty_preserved_artifacts")
    else:
        for item in preserved:
            check_file_ref("preserved_artifact", item)

    if "parameters_ref" in doc:
        check_file_ref("parameters_ref", doc.get("parameters_ref"))
    if "proof_ref" in doc:
        check_file_ref("proof_ref", doc.get("proof_ref"))

    return len(errors) == 0, errors, files_checked


def verify_mph_bundle(bundle_path: Path, repo_root: Path) -> tuple[bool, list[str], int]:
    """Verify legacy mph-dehydrated-bundle/v1 bundles seamlessly."""
    errors: list[str] = []
    files_checked = 0
    try:
        doc = json.loads(bundle_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return False, [f"json_parse_error:{exc}"], 0
    if not isinstance(doc, dict):
        return False, ["bundle_not_object"], 0

    if doc.get("schema_version") != MPH_BUNDLE_SCHEMA:
        errors.append(f"invalid_schema_version:{doc.get('schema_version')!r}")

    mph_files = doc.get("dehydrated_mph_files")
    if not isinstance(mph_files, list) or not mph_files:
        errors.append("empty_dehydrated_mph_files")
    else:
        for entry in mph_files:
            if not isinstance(entry, dict):
                errors.append("invalid_mph_entry")
                continue
            d = entry.get("sha256")
            sz = entry.get("bytes")
            if not isinstance(d, str) or not HEX64_RE.fullmatch(d):
                errors.append(f"invalid_mph_sha256:{entry.get('filename')!r}")
            if isinstance(sz, bool) or not isinstance(sz, int) or sz <= 0:
                errors.append(f"invalid_mph_bytes:{entry.get('filename')!r}")

    slot_rel = doc.get("slot_relpath")
    if isinstance(slot_rel, str) and slot_rel:
        slot_dir = repo_root / slot_rel
    elif bundle_path.parent.parent.name == "results":
        slot_dir = bundle_path.parents[2]
    else:
        slot_dir = bundle_path.parent

    slot_dir = Path(os.path.abspath(str(slot_dir)))
    if not is_subpath_lexical(slot_dir, repo_root) or _detect_escaping_reparse(slot_dir, [repo_root]) is not None:
        errors.append("escaping_slot_dir")
        return False, errors, files_checked

    evidence = doc.get("preserved_evidence")
    if not isinstance(evidence, dict) or not evidence:
        errors.append("missing_preserved_evidence")
    else:
        for rel_key, meta in evidence.items():
            if not isinstance(rel_key, str) or not rel_key:
                errors.append(f"invalid_evidence_relpath:{rel_key!r}")
                continue
            if not isinstance(meta, dict):
                errors.append(f"invalid_evidence_meta:{rel_key}")
                continue
            exp_sha = meta.get("sha256")
            exp_bytes = meta.get("bytes")
            if not isinstance(exp_sha, str) or not HEX64_RE.fullmatch(exp_sha):
                errors.append(f"invalid_evidence_sha256:{rel_key}")
                continue
            if isinstance(exp_bytes, bool) or not isinstance(exp_bytes, int) or exp_bytes < 0:
                errors.append(f"invalid_evidence_bytes:{rel_key}")
                continue
            target = Path(os.path.abspath(str(slot_dir / rel_key)))
            if (
                Path(rel_key).is_absolute()
                or not is_subpath_lexical(target, slot_dir)
                or is_reparse_or_link(target)
                or _detect_escaping_reparse(target, [repo_root]) is not None
            ):
                errors.append(f"invalid_or_escaping_evidence_path:{rel_key}")
                continue
            if not target.is_file():
                errors.append(f"missing_evidence_file:{rel_key}")
                continue
            actual_sha, actual_bytes = sha256_file(target)
            files_checked += 1
            if actual_bytes != exp_bytes:
                errors.append(f"evidence_bytes_mismatch:{rel_key}:{actual_bytes}!={exp_bytes}")
            if actual_sha != exp_sha.lower():
                errors.append(f"evidence_sha256_mismatch:{rel_key}")

    return len(errors) == 0, errors, files_checked


def cmd_verify_bundles(args: argparse.Namespace) -> int:
    repo_root = _resolve_repo_root(args.repo_root, as_json=args.json)
    if repo_root is None:
        return 2

    dw_bundles: list[Path] = []
    mph_bundles: list[Path] = []

    stack: list[Path] = [repo_root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                entries = list(it)
        except OSError:
            continue
        for entry in entries:
            name = entry.name
            p = Path(entry.path)
            if current == repo_root and (name in SKIP_WALK_DIRS or name == ".tmp"):
                continue
            if is_reparse_or_link(p):
                continue
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISDIR(st.st_mode):
                if name not in SKIP_WALK_DIRS:
                    stack.append(p)
            elif stat.S_ISREG(st.st_mode):
                if name == DW_BUNDLE_FILENAME:
                    dw_bundles.append(p)
                elif name == MPH_BUNDLE_FILENAME:
                    mph_bundles.append(p)

    failures: list[dict[str, Any]] = []
    preserved_checked = 0

    for bp in sorted(dw_bundles):
        ok, errs, cnt = verify_dw_bundle(bp, repo_root)
        preserved_checked += cnt
        if not ok:
            failures.append({"bundle": to_rel_posix(bp, repo_root) or str(bp), "kind": "dw", "errors": errs})

    for bp in sorted(mph_bundles):
        ok, errs, cnt = verify_mph_bundle(bp, repo_root)
        preserved_checked += cnt
        if not ok:
            failures.append({"bundle": to_rel_posix(bp, repo_root) or str(bp), "kind": "mph", "errors": errs})

    receipt_entries_checked = 0
    if args.receipt_dir:
        rdir = _resolve_cli_dir(args.receipt_dir, repo_root)
        sha_path = rdir / "SHA256SUMS"
        if not sha_path.is_file():
            failures.append({"receipt": str(sha_path), "kind": "receipt", "errors": ["receipt_SHA256SUMS_missing"]})
        else:
            entries = parse_sha_manifest_lines(sha_path.read_text(encoding="utf-8", errors="replace"))
            if not entries:
                failures.append({"receipt": str(sha_path), "kind": "receipt", "errors": ["receipt_SHA256SUMS_empty"]})
            for exp_sha, exp_sz, ref in entries:
                resolved, _ = resolve_manifest_ref(sha_path, repo_root, ref)
                if (
                    Path(ref).is_absolute()
                    or not (is_subpath_lexical(resolved, repo_root) or is_subpath_lexical(resolved, rdir))
                    or is_reparse_or_link(resolved)
                    or _detect_escaping_reparse(resolved, [repo_root, rdir]) is not None
                ):
                    failures.append({"receipt": str(sha_path), "kind": "receipt", "errors": [f"escaping_or_reparse_receipt_target:{ref}"]})
                    continue
                if not resolved.is_file():
                    failures.append({"receipt": str(sha_path), "kind": "receipt", "errors": [f"missing_receipt_target:{ref}"]})
                    continue
                act_sha, act_sz = sha256_file(resolved)
                receipt_entries_checked += 1
                if exp_sz is not None and act_sz != exp_sz:
                    failures.append({"receipt": str(sha_path), "kind": "receipt", "errors": [f"size_mismatch:{ref}"]})
                if act_sha != exp_sha:
                    failures.append({"receipt": str(sha_path), "kind": "receipt", "errors": [f"sha256_mismatch:{ref}"]})

    total_bundles = len(dw_bundles) + len(mph_bundles)
    result = {
        "ok": len(failures) == 0,
        "repo_root": str(repo_root),
        "bundles_checked": total_bundles,
        "dw_bundles_checked": len(dw_bundles),
        "mph_bundles_checked": len(mph_bundles),
        "preserved_files_checked": preserved_checked,
        "receipt_entries_checked": receipt_entries_checked,
        "failure_count": len(failures),
        "failures": failures,
    }
    emit_output(
        result,
        as_json=args.json,
        human_ok=(
            f"VERIFY-BUNDLES: checked={total_bundles} (dw={len(dw_bundles)}, mph={len(mph_bundles)}), "
            f"files={preserved_checked}, failures={len(failures)}"
        ),
    )
    return 0 if len(failures) == 0 else 1


# ---------------------------------------------------------------------------
# Subcommand 7: archive-index
# ---------------------------------------------------------------------------


def _collect_archive_files(archive_dir: Path) -> tuple[list[Path], list[str]]:
    files: list[Path] = []
    reparse_hits: list[str] = []
    stack: list[Path] = [archive_dir]
    while stack:
        cur = stack.pop()
        with os.scandir(cur) as it:
            entries = sorted(it, key=lambda e: e.name)
        for entry in entries:
            p = Path(entry.path)
            if cur == archive_dir and entry.name in (ARCHIVE_MANIFEST_FILENAME, "SHA256SUMS"):
                continue
            if is_reparse_or_link(p):
                reparse_hits.append(to_rel_posix(p, archive_dir) or entry.name)
                continue
            st = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode):
                stack.append(p)
            elif stat.S_ISREG(st.st_mode):
                files.append(p)
    files.sort(key=lambda x: to_rel_posix(x, archive_dir) or x.name)
    return files, reparse_hits


def cmd_archive_index(args: argparse.Namespace) -> int:
    repo_root = _resolve_repo_root(args.repo_root, as_json=args.json)
    if repo_root is None:
        return 2
    archive_dir = _resolve_cli_dir(args.archive_dir, repo_root)
    manifest_path = archive_dir / ARCHIVE_MANIFEST_FILENAME
    sha_path = archive_dir / "SHA256SUMS"

    if (
        not archive_dir.is_dir()
        or is_reparse_or_link(archive_dir)
        or archive_dir == repo_root
        or (is_subpath_lexical(archive_dir, repo_root) and _detect_escaping_reparse(archive_dir, [repo_root]) is not None)
    ):
        emit_output({"ok": False, "code": "INVALID_ARCHIVE_DIR", "detail": f"Invalid archive_dir: {archive_dir}"}, as_json=args.json)
        return 2

    if args.verify:
        failures: list[dict[str, str]] = []
        if not manifest_path.is_file():
            failures.append({"code": "MANIFEST_MISSING", "detail": str(manifest_path)})
        if not sha_path.is_file():
            failures.append({"code": "SHA256SUMS_MISSING", "detail": str(sha_path)})

        indexed_relpaths: set[str] = set()
        if manifest_path.is_file():
            try:
                doc = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception as exc:
                doc = None
                failures.append({"code": "MANIFEST_PARSE_ERROR", "detail": str(exc)})
            if isinstance(doc, dict):
                if doc.get("schema") != ARCHIVE_MANIFEST_SCHEMA or doc.get("schema_version") != 1:
                    failures.append({"code": "MANIFEST_SCHEMA_INVALID", "detail": repr(doc.get("schema"))})
                exp_msha = doc.get("manifest_sha256")
                if not isinstance(exp_msha, str) or exp_msha.lower() != compute_canonical_sha256(doc, "manifest_sha256"):
                    failures.append({"code": "MANIFEST_SHA256_MISMATCH", "detail": "manifest_sha256 mismatch"})
                for entry in doc.get("files") or []:
                    if not isinstance(entry, dict) or not isinstance(entry.get("relpath"), str) or not entry.get("relpath"):
                        failures.append({"code": "MANIFEST_ENTRY_INVALID", "detail": repr(entry)})
                        continue
                    rel = entry.get("relpath")
                    exp_sha = entry.get("sha256")
                    exp_sz = entry.get("size_bytes")
                    indexed_relpaths.add(norm_key(rel))
                    fp = Path(os.path.abspath(str(archive_dir / rel)))
                    if (
                        Path(rel).is_absolute()
                        or not is_subpath_lexical(fp, archive_dir)
                        or _detect_escaping_reparse(fp, [archive_dir]) is not None
                    ):
                        failures.append({"code": "ESCAPING_ARCHIVE_PATH", "detail": rel})
                        continue
                    if not fp.is_file() or is_reparse_or_link(fp):
                        failures.append({"code": "ARCHIVED_FILE_MISSING", "detail": rel})
                        continue
                    act_sha, act_sz = sha256_file(fp)
                    if act_sz != exp_sz:
                        failures.append({"code": "SIZE_MISMATCH", "detail": f"{rel}: {act_sz}!={exp_sz}"})
                    if act_sha != str(exp_sha).lower():
                        failures.append({"code": "SHA256_MISMATCH", "detail": rel})

        # Detect any extra unindexed files in archive_dir
        live_files, reparse_hits = _collect_archive_files(archive_dir)
        for rh in reparse_hits:
            failures.append({"code": "UNEXPECTED_REPARSE", "detail": rh})
        for lf in live_files:
            lrel = to_rel_posix(lf, archive_dir) or lf.name
            if norm_key(lrel) not in indexed_relpaths:
                failures.append({"code": "UNINDEXED_EXTRA_FILE", "detail": lrel})

        # Verify SHA256SUMS
        if sha_path.is_file():
            sha_entries = parse_sha_manifest_lines(sha_path.read_text(encoding="utf-8", errors="replace"))
            if not sha_entries:
                failures.append({"code": "SHA256SUMS_EMPTY", "detail": str(sha_path)})
            for exp_sha, exp_sz, ref in sha_entries:
                fp = Path(os.path.abspath(str(archive_dir / ref)))
                if (
                    Path(ref).is_absolute()
                    or not is_subpath_lexical(fp, archive_dir)
                    or _detect_escaping_reparse(fp, [archive_dir]) is not None
                ):
                    failures.append({"code": "ESCAPING_ARCHIVE_PATH", "detail": ref})
                    continue
                if not fp.is_file() or is_reparse_or_link(fp):
                    failures.append({"code": "SHA256SUMS_TARGET_MISSING", "detail": ref})
                    continue
                act_sha, act_sz = sha256_file(fp)
                if exp_sz is not None and act_sz != exp_sz:
                    failures.append({"code": "SHA256SUMS_SIZE_MISMATCH", "detail": ref})
                if act_sha != exp_sha:
                    failures.append({"code": "SHA256SUMS_HASH_MISMATCH", "detail": ref})

        result = {
            "ok": len(failures) == 0,
            "mode": "verify",
            "archive_dir": str(archive_dir),
            "files_verified": len(indexed_relpaths),
            "failure_count": len(failures),
            "failures": failures,
        }
        emit_output(result, as_json=args.json, human_ok=f"ARCHIVE VERIFY: ok={result['ok']}, files={len(indexed_relpaths)}")
        return 0 if len(failures) == 0 else 1

    # Seal mode
    if args.dry_run and args.execute:
        emit_output({"ok": False, "code": "CONFLICTING_FLAGS", "detail": "Specify either --dry-run or --execute"}, as_json=args.json)
        return 2
    dry_run = not args.execute

    batch_id = (args.batch_id or "").strip()
    reason = (args.reason or "").strip()
    if not batch_id or not reason:
        emit_output({"ok": False, "code": "MISSING_METADATA", "detail": "--batch-id and --reason are required in seal mode"}, as_json=args.json)
        return 2

    if manifest_path.exists() or sha_path.exists():
        emit_output(
            {
                "ok": False,
                "code": "ARCHIVE_ALREADY_SEALED",
                "detail": f"Refusing to overwrite existing archive index in {archive_dir}",
            },
            as_json=args.json,
        )
        return 2

    files, reparse_hits = _collect_archive_files(archive_dir)
    if reparse_hits:
        emit_output(
            {"ok": False, "code": "REPARSE_IN_ARCHIVE", "detail": f"Reparse/symlink entries forbidden in archive: {reparse_hits}"},
            as_json=args.json,
        )
        return 2

    acc = InodeAccumulator()
    file_records: list[dict[str, Any]] = []
    for fp in files:
        st = os.lstat(fp)
        acc.add(str(fp), st)
        rel = to_rel_posix(fp, archive_dir) or fp.name
        if dry_run:
            file_records.append({"relpath": rel, "size_bytes": int(st.st_size)})
        else:
            digest, sz = sha256_file(fp)
            file_records.append({"relpath": rel, "size_bytes": sz, "sha256": digest})

    if dry_run:
        result = {
            "ok": True,
            "mode": "seal",
            "dry_run": True,
            "archive_dir": str(archive_dir),
            "batch_id": batch_id,
            "file_count": acc.file_count,
            "logical_bytes": acc.logical_bytes,
            "physical_bytes": acc.physical_bytes,
        }
        emit_output(result, as_json=args.json, human_ok=f"ARCHIVE DRY-RUN: files={acc.file_count}, bytes={acc.physical_bytes}")
        return 0

    manifest_doc: dict[str, Any] = {
        "schema": ARCHIVE_MANIFEST_SCHEMA,
        "schema_version": 1,
        "batch_id": batch_id,
        "reason": reason,
        "source_ref": args.source_ref or "",
        "created_at_utc": utc_now_iso(),
        "archive_relpath": to_rel_posix(archive_dir, repo_root) or str(archive_dir),
        "file_count": acc.file_count,
        "logical_bytes": acc.logical_bytes,
        "physical_bytes": acc.physical_bytes,
        "files": file_records,
    }
    manifest_doc["manifest_sha256"] = compute_canonical_sha256(manifest_doc, "manifest_sha256")
    manifest_file_sha, _ = atomic_write_json(manifest_path, manifest_doc)

    sha_lines = [f"{manifest_file_sha}  {ARCHIVE_MANIFEST_FILENAME}"]
    for rec in file_records:
        sha_lines.append(f"{rec['sha256']}  {rec['relpath']}")
    atomic_write_text(sha_path, "\n".join(sha_lines) + "\n")

    result = {
        "ok": True,
        "mode": "seal",
        "dry_run": False,
        "archive_dir": str(archive_dir),
        "manifest_path": str(manifest_path),
        "sha256sums_path": str(sha_path),
        "batch_id": batch_id,
        "file_count": acc.file_count,
        "logical_bytes": acc.logical_bytes,
        "physical_bytes": acc.physical_bytes,
        "manifest_sha256": manifest_doc["manifest_sha256"],
    }
    emit_output(result, as_json=args.json, human_ok=f"ARCHIVE SEALED: {archive_dir} ({acc.file_count} files)")
    return 0


# ---------------------------------------------------------------------------
# Output & CLI Parser
# ---------------------------------------------------------------------------


def emit_output(payload: dict[str, Any], *, as_json: bool, human_ok: str | None = None) -> None:
    if as_json:
        print(json.dumps(payload, indent=2, ensure_ascii=False, allow_nan=False))
        return
    if payload.get("ok") and human_ok:
        print(human_ok)
    else:
        print(json.dumps(payload, indent=2, ensure_ascii=False, allow_nan=False))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="workspace_governance.py",
        description="Cross-project workspace file governance CLI (7 deterministic rules).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # 1. check-path
    p_cp = sub.add_parser("check-path", help="Validate target path against boundary, temp, clutter, and reserved-name rules.")
    p_cp.add_argument("--repo-root", required=True)
    p_cp.add_argument("--target", required=True)
    p_cp.add_argument("--intent", choices=["persistent", "temp", "external"], default="persistent")
    p_cp.add_argument("--allow-external-prefix", action="append", default=[])
    p_cp.add_argument("--json", action="store_true")
    p_cp.set_defaults(func=cmd_check_path)

    # 2. alloc-temp
    p_at = sub.add_parser("alloc-temp", help="Allocate a leased scoped temp directory (OS or gitignored repo .tmp).")
    p_at.add_argument("--repo-root", required=True)
    p_at.add_argument("--tier", choices=["os", "repo"], default="os")
    p_at.add_argument("--task", required=True)
    p_at.add_argument("--owner", required=True)
    p_at.add_argument("--pid", type=int, default=os.getpid())
    p_at.add_argument("--ttl-sec", type=int, default=14400)
    p_at.add_argument("--project", default=None)
    p_at.add_argument("--json", action="store_true")
    p_at.set_defaults(func=cmd_alloc_temp)

    # 3. reclaim-temp
    p_rt = sub.add_parser("reclaim-temp", help="Reclaim expired/dead-PID temp directories safely without crossing junctions.")
    p_rt.add_argument("--repo-root", required=True)
    p_rt.add_argument("--scan-os-temp", action="store_true")
    p_rt.add_argument("--project", default=None)
    p_rt.add_argument("--grace-sec", type=int, default=600)
    p_rt.add_argument("--dry-run", action="store_true")
    p_rt.add_argument("--execute", action="store_true")
    p_rt.add_argument("--receipt-out", default=None)
    p_rt.add_argument("--json", action="store_true")
    p_rt.set_defaults(func=cmd_reclaim_temp)

    # 4. audit
    p_au = sub.add_parser("audit", help="Read-only workspace audit with ProtectedSet and inode-deduplicated accounting.")
    p_au.add_argument("--repo-root", required=True)
    p_au.add_argument("--large-file-mb", type=float, default=50.0)
    p_au.add_argument("--orphan-grace-sec", type=int, default=600)
    p_au.add_argument("--protected-glob", action="append", default=[])
    p_au.add_argument("--check", action="store_true")
    p_au.add_argument("--json-out", default=None)
    p_au.add_argument("--json", action="store_true")
    p_au.set_defaults(func=cmd_audit)

    # 5. dehydrate
    p_dh = sub.add_parser("dehydrate", help="6-gate fail-closed atomic lossless dehydration of recomputable artifacts.")
    p_dh.add_argument("--repo-root", required=True)
    p_dh.add_argument("--slot-dir", required=True)
    p_dh.add_argument("--target", action="append", required=True)
    p_dh.add_argument("--preserve", action="append", required=True)
    p_dh.add_argument("--command-template", required=True)
    p_dh.add_argument("--engine-version", required=True)
    p_dh.add_argument("--parameters-ref", required=True)
    p_dh.add_argument("--seed", default=None)
    p_dh.add_argument(
        "--reproducibility-tier",
        choices=["deterministic_recompute", "verified_tolerance_recompute"],
        required=True,
    )
    p_dh.add_argument("--proof-ref", required=True)
    p_dh.add_argument("--conflict-proc-substr", action="append", default=[])
    p_dh.add_argument("--receipt-dir", required=True)
    p_dh.add_argument("--dry-run", action="store_true")
    p_dh.add_argument("--execute", action="store_true")
    p_dh.add_argument("--json", action="store_true")
    p_dh.set_defaults(func=cmd_dehydrate)

    # 6. verify-bundles
    p_vb = sub.add_parser("verify-bundles", help="Verify all dw-dehydrated-bundle.json and mph-dehydrated-bundle.json files.")
    p_vb.add_argument("--repo-root", required=True)
    p_vb.add_argument("--receipt-dir", default=None)
    p_vb.add_argument("--json", action="store_true")
    p_vb.set_defaults(func=cmd_verify_bundles)

    # 7. archive-index
    p_ai = sub.add_parser("archive-index", help="Seal or verify an immutable cold archive directory.")
    p_ai.add_argument("--repo-root", required=True)
    p_ai.add_argument("--archive-dir", required=True)
    p_ai.add_argument("--batch-id", default=None)
    p_ai.add_argument("--reason", default=None)
    p_ai.add_argument("--source-ref", default=None)
    p_ai.add_argument("--dry-run", action="store_true")
    p_ai.add_argument("--execute", action="store_true")
    p_ai.add_argument("--verify", action="store_true")
    p_ai.add_argument("--json", action="store_true")
    p_ai.set_defaults(func=cmd_archive_index)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
