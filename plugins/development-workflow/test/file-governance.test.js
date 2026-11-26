#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const skillDir = path.join(pluginRoot, 'skills', 'dw-file-governance');
const scriptPath = path.join(skillDir, 'scripts', 'workspace_governance.py');

function resolvePythonExecutable() {
  const probeCode = 'import sys; assert sys.version_info >= (3, 9); print(sys.executable)';
  const candidates = [process.env.DW_TEST_PYTHON_PATH, 'python', 'python3', 'py'].filter(Boolean);
  for (const candidate of candidates) {
    const res = childProcess.spawnSync(candidate, ['-B', '-c', probeCode], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    if (!res.error && res.status === 0 && res.stdout.trim()) {
      return res.stdout.trim();
    }
  }
  return null;
}

const PYTHON_TEST_SUITE = String.raw`from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from typing import Any

PLUGIN_ROOT = Path(os.environ["DW_PLUGIN_ROOT"]).resolve()
SKILL_DIR = PLUGIN_ROOT / "skills" / "dw-file-governance"
SCRIPT_PATH = SKILL_DIR / "scripts" / "workspace_governance.py"
SKILL_MD_PATH = SKILL_DIR / "SKILL.md"


def run_cli(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    cmd = [sys.executable, "-B", str(SCRIPT_PATH), *args]
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else str(PLUGIN_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )


def parse_json_stdout(proc: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    assert proc.stdout.strip(), f"Expected JSON stdout; stderr={proc.stderr!r}, rc={proc.returncode}"
    return json.loads(proc.stdout)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def init_git_repo(repo: Path, gitignore_lines: list[str] | None = None) -> None:
    repo.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=str(repo), check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=str(repo), check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=str(repo), check=True)
    if gitignore_lines is not None:
        (repo / ".gitignore").write_text("\n".join(gitignore_lines) + "\n", encoding="utf-8")
        subprocess.run(["git", "add", ".gitignore"], cwd=str(repo), check=True)


def make_dir_link(target: Path, link_path: Path) -> None:
    if os.name == "nt":
        proc = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link_path), str(target)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        assert proc.returncode == 0, proc.stderr
    else:
        os.symlink(target, link_path)


def safe_cleanup_tree(target: Path) -> None:
    if not target.exists() and not target.is_symlink():
        return
    if os.name == "nt":
        # Remove junctions safely without deleting external targets before rmtree.
        for root_dir, dirnames, _ in os.walk(target, topdown=True):
            kept: list[str] = []
            for d in dirnames:
                dp = Path(root_dir) / d
                is_junc = getattr(os.path, "isjunction", None)
                if dp.is_symlink() or (is_junc is not None and is_junc(dp)):
                    os.rmdir(dp)
                else:
                    kept.append(d)
            dirnames[:] = kept
    shutil.rmtree(target, ignore_errors=True)


class FileGovernanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp_root = Path(tempfile.mkdtemp(prefix="dw-fg-case-"))

    def tearDown(self) -> None:
        safe_cleanup_tree(self._tmp_root)

    def _setup_dehydrate_fixture(self) -> dict[str, Path]:
        repo = self._tmp_root / "dehyd_repo"
        init_git_repo(repo, [".tmp/", "artifacts/"])
        slot = repo / "artifacts" / "runs" / "slot_01"
        slot.mkdir(parents=True)
        target = slot / "heavy_mesh.bin"
        target.write_bytes(b"HEAVY_PAYLOAD_" * 1000)
        preserved = slot / "metrics.csv"
        preserved.write_text("k,v\nalpha,0.99\n", encoding="utf-8")
        params = slot / "params.json"
        params.write_text(json.dumps({"mesh": 4, "seed": 42}), encoding="utf-8")
        proof = repo / "artifacts" / "proofs" / "recompute_proof.json"
        proof.parent.mkdir(parents=True)
        proof.write_text(json.dumps({"status": "VERIFIED", "max_rel_err": 1e-8}), encoding="utf-8")
        receipt_dir = repo / "artifacts" / "receipts" / "batch_01"
        return {
            "repo": repo,
            "slot": slot,
            "target": target,
            "preserved": preserved,
            "params": params,
            "proof": proof,
            "receipt_dir": receipt_dir,
        }

    # 1-4: check-path
    def test_01_check_path_persistent_escape_and_external_allowlist(self) -> None:
        repo = self._tmp_root / "demo_repo"
        init_git_repo(repo, [".tmp/"])
        (repo / "src").mkdir(parents=True, exist_ok=True)

        ok = run_cli("check-path", "--repo-root", str(repo), "--target", "src/model.py", "--intent", "persistent", "--json")
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertTrue(parse_json_stdout(ok)["ok"])

        esc = run_cli("check-path", "--repo-root", str(repo), "--target", str(self._tmp_root / "outside.txt"), "--intent", "persistent", "--json")
        self.assertNotEqual(esc.returncode, 0)
        self.assertFalse(parse_json_stdout(esc)["ok"])

        ext_dir = self._tmp_root / "external_store"
        ext_dir.mkdir()
        deny_ext = run_cli("check-path", "--repo-root", str(repo), "--target", str(ext_dir / "dataset.parquet"), "--intent", "external", "--json")
        self.assertNotEqual(deny_ext.returncode, 0)

        ok_ext = run_cli(
            "check-path",
            "--repo-root", str(repo),
            "--target", str(ext_dir / "dataset.parquet"),
            "--intent", "external",
            "--allow-external-prefix", str(ext_dir),
            "--json",
        )
        self.assertEqual(ok_ext.returncode, 0, ok_ext.stdout)
        self.assertTrue(parse_json_stdout(ok_ext)["ok"])

    def test_02_check_path_reserved_device_names_control_chars_and_root_clutter(self) -> None:
        repo = self._tmp_root / "clutter_repo"
        init_git_repo(repo, [".tmp/"])

        for bad_name in ("nul", "NUL.txt", "src/CON.json", "src/com1", "docs/LPT9.md", "prn", "aux.log"):
            res = run_cli("check-path", "--repo-root", str(repo), "--target", bad_name, "--intent", "persistent", "--json")
            self.assertNotEqual(res.returncode, 0, bad_name)
            codes = {v["code"] for v in parse_json_stdout(res)["violations"]}
            self.assertIn("RESERVED_DEVICE_NAME", codes)

        ctrl = run_cli("check-path", "--repo-root", str(repo), "--target", "src/bad\x07name.py", "--intent", "persistent", "--json")
        self.assertNotEqual(ctrl.returncode, 0)
        self.assertIn("CONTROL_CHAR", {v["code"] for v in parse_json_stdout(ctrl)["violations"]})

        for clutter in ("scratch.tmp", "old.bak", "run.log", "stdout.out", ".tmp_work", "_scratch_dir", "tmp_eval.py", "model.mph", "weights.pt", "epoch1.ckpt", "cache.npz"):
            res = run_cli("check-path", "--repo-root", str(repo), "--target", clutter, "--intent", "persistent", "--json")
            self.assertNotEqual(res.returncode, 0, clutter)
            self.assertIn("ROOT_CLUTTER", {v["code"] for v in parse_json_stdout(res)["violations"]})

    def test_03_check_path_temp_rules_and_adhoc_rejections(self) -> None:
        repo_ignored = self._tmp_root / "repo_ignored"
        init_git_repo(repo_ignored, [".tmp/"])
        repo_unignored = self._tmp_root / "repo_unignored"
        init_git_repo(repo_unignored, [])

        os_scoped = Path(tempfile.gettempdir()) / "dw-test-scoped-run1" / "work.bin"
        res_os_ok = run_cli("check-path", "--repo-root", str(repo_ignored), "--target", str(os_scoped), "--intent", "temp", "--json")
        self.assertEqual(res_os_ok.returncode, 0, res_os_ok.stdout)

        os_bare = Path(tempfile.gettempdir()) / "bare.tmp"
        res_os_bare = run_cli("check-path", "--repo-root", str(repo_ignored), "--target", str(os_bare), "--intent", "temp", "--json")
        self.assertNotEqual(res_os_bare.returncode, 0)

        res_repo_ok = run_cli("check-path", "--repo-root", str(repo_ignored), "--target", ".tmp/run-001/data.bin", "--intent", "temp", "--json")
        self.assertEqual(res_repo_ok.returncode, 0, res_repo_ok.stdout)

        res_repo_bad = run_cli("check-path", "--repo-root", str(repo_unignored), "--target", ".tmp/run-001/data.bin", "--intent", "temp", "--json")
        self.assertNotEqual(res_repo_bad.returncode, 0)

        adhoc_paths = [
            r"C:\Temp\foo.bin",
            r"D:\tmp\bar.bin",
            "/tmp_work/baz.bin",
            str(repo_ignored.parent / "tmp_sibling" / "x.bin"),
            str(Path.home() / "Desktop" / "scratch.txt"),
        ]
        for adhoc in adhoc_paths:
            res = run_cli("check-path", "--repo-root", str(repo_ignored), "--target", adhoc, "--intent", "temp", "--json")
            self.assertNotEqual(res.returncode, 0, adhoc)

    def test_04_check_path_rejects_escaping_reparse_point(self) -> None:
        repo = self._tmp_root / "repo_reparse"
        init_git_repo(repo, [".tmp/"])
        outside = self._tmp_root / "outside_secret"
        outside.mkdir()
        (outside / "secret.txt").write_text("do not escape", encoding="utf-8")

        link_path = repo / "escaped_dir"
        make_dir_link(outside, link_path)

        res = run_cli("check-path", "--repo-root", str(repo), "--target", "escaped_dir/secret.txt", "--intent", "persistent", "--json")
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("REPARSE_OR_SYMLINK_ESCAPE", {v["code"] for v in parse_json_stdout(res)["violations"]})

    # 5-6: alloc-temp
    def test_05_alloc_temp_repo_tier_fail_closed_without_gitignore(self) -> None:
        repo = self._tmp_root / "unignored_repo"
        init_git_repo(repo, [])

        res = run_cli("alloc-temp", "--repo-root", str(repo), "--tier", "repo", "--task", "unit-test", "--owner", "unittest", "--json")
        self.assertEqual(res.returncode, 2)
        payload = parse_json_stdout(res)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "REPO_TMP_NOT_GITIGNORED")
        self.assertFalse((repo / ".tmp").exists())

    def test_06_alloc_temp_repo_and_os_tier_leases(self) -> None:
        repo = self._tmp_root / "ignored_repo"
        init_git_repo(repo, [".tmp/"])

        res_repo = run_cli(
            "alloc-temp", "--repo-root", str(repo), "--tier", "repo",
            "--task", "build-cache", "--owner", "worker-a",
            "--pid", str(os.getpid()), "--ttl-sec", "3600", "--project", "projalpha", "--json",
        )
        self.assertEqual(res_repo.returncode, 0, res_repo.stderr)
        data = parse_json_stdout(res_repo)
        self.assertTrue(data["ok"])
        lease_dir = Path(data["canonical_path"])
        self.assertTrue(lease_dir.is_dir())
        self.assertEqual(lease_dir.parent, (repo / ".tmp").resolve())
        lease_file = lease_dir / ".dw-temp-lease.json"
        lease = json.loads(lease_file.read_text(encoding="utf-8"))
        self.assertEqual(lease["schema"], "dw-temp-lease-v1")
        self.assertEqual(lease["schema_version"], 1)
        self.assertEqual(lease["pid"], os.getpid())
        self.assertEqual(lease["owner"], "worker-a")
        self.assertEqual(lease["tier"], "repo")
        self.assertRegex(lease["lease_sha256"], r"^[0-9a-f]{64}$")

        res_os = run_cli(
            "alloc-temp", "--repo-root", str(repo), "--tier", "os",
            "--task", "os-scratch", "--owner", "worker-b",
            "--pid", str(os.getpid()), "--project", "dwgovtestos", "--json",
        )
        self.assertEqual(res_os.returncode, 0, res_os.stderr)
        os_dir = Path(parse_json_stdout(res_os)["canonical_path"])
        try:
            self.assertTrue(os_dir.is_dir())
            self.assertTrue((os_dir / ".dw-temp-lease.json").is_file())
        finally:
            safe_cleanup_tree(os_dir)

    # 7-9: reclaim-temp
    def test_07_reclaim_temp_live_pid_hold_active_vs_dead_pid_reclaim(self) -> None:
        repo = self._tmp_root / "reclaim_repo"
        init_git_repo(repo, [".tmp/"])

        res_live = run_cli(
            "alloc-temp", "--repo-root", str(repo), "--tier", "repo",
            "--task", "live-job", "--owner", "live-worker",
            "--pid", str(os.getpid()), "--ttl-sec", "0", "--json",
        )
        self.assertEqual(res_live.returncode, 0)
        live_dir = Path(parse_json_stdout(res_live)["canonical_path"])
        (live_dir / "active.bin").write_bytes(b"live")

        dead_proc = subprocess.Popen([sys.executable, "-c", "pass"])
        dead_pid = dead_proc.pid
        dead_proc.wait(timeout=10)

        res_dead = run_cli(
            "alloc-temp", "--repo-root", str(repo), "--tier", "repo",
            "--task", "dead-job", "--owner", "dead-worker",
            "--pid", str(dead_pid), "--ttl-sec", "14400", "--json",
        )
        self.assertEqual(res_dead.returncode, 0)
        dead_dir = Path(parse_json_stdout(res_dead)["canonical_path"])
        (dead_dir / "stale.bin").write_bytes(b"dead")

        fresh_unleased = repo / ".tmp" / "unleased-fresh"
        fresh_unleased.mkdir(parents=True)
        (fresh_unleased / "a.txt").write_text("fresh", encoding="utf-8")

        old_unleased = repo / ".tmp" / "unleased-old"
        old_unleased.mkdir(parents=True)
        (old_unleased / "b.txt").write_text("old", encoding="utf-8")
        old_mtime = time.time() - 3600
        os.utime(old_unleased, (old_mtime, old_mtime))

        dry = run_cli("reclaim-temp", "--repo-root", str(repo), "--grace-sec", "600", "--json")
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertTrue(parse_json_stdout(dry)["dry_run"])
        self.assertTrue(live_dir.exists() and dead_dir.exists() and fresh_unleased.exists() and old_unleased.exists())

        receipt_path = self._tmp_root / "reclaim-receipt.json"
        exe = run_cli("reclaim-temp", "--repo-root", str(repo), "--grace-sec", "600", "--execute", "--receipt-out", str(receipt_path), "--json")
        self.assertEqual(exe.returncode, 0, exe.stderr)
        exe_data = parse_json_stdout(exe)
        self.assertFalse(exe_data["dry_run"])
        self.assertTrue(live_dir.exists() and (live_dir / "active.bin").is_file())
        self.assertTrue(fresh_unleased.exists())
        self.assertFalse(dead_dir.exists())
        self.assertFalse(old_unleased.exists())
        self.assertTrue(receipt_path.is_file())

        by_path = {Path(item["path"]).resolve(): item["decision"] for item in exe_data["entries"]}
        self.assertEqual(by_path[live_dir.resolve()], "HOLD_ACTIVE")
        self.assertIn(by_path[dead_dir.resolve()], ("RECLAIM_DEAD_PID", "RECLAIM_PID_REUSED"))
        self.assertEqual(by_path[fresh_unleased.resolve()], "HOLD_GRACE_PERIOD")
        self.assertEqual(by_path[old_unleased.resolve()], "RECLAIM_UNLEASED_EXPIRED")

    def test_08_reclaim_temp_pid_start_token_reuse_guard(self) -> None:
        repo = self._tmp_root / "pid_reuse_repo"
        init_git_repo(repo, [".tmp/"])

        alloc = run_cli(
            "alloc-temp", "--repo-root", str(repo), "--tier", "repo",
            "--task", "reused-pid", "--owner", "old-worker",
            "--pid", str(os.getpid()), "--json",
        )
        self.assertEqual(alloc.returncode, 0)
        reused_dir = Path(parse_json_stdout(alloc)["canonical_path"])
        lease_file = reused_dir / ".dw-temp-lease.json"
        lease = json.loads(lease_file.read_text(encoding="utf-8"))
        lease["process_start_token"] = "win-ft:1" if lease["process_start_token"].startswith("win-ft:") else "linux-st:1"
        lease_no_hash = {k: v for k, v in lease.items() if k != "lease_sha256"}
        canonical = json.dumps(lease_no_hash, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        lease["lease_sha256"] = sha256_bytes(canonical)
        lease_file.write_text(json.dumps(lease, indent=2) + "\n", encoding="utf-8")

        exe = run_cli("reclaim-temp", "--repo-root", str(repo), "--execute", "--json")
        self.assertEqual(exe.returncode, 0, exe.stderr)
        exe_data = parse_json_stdout(exe)
        self.assertFalse(reused_dir.exists())
        self.assertEqual(exe_data["entries"][0]["decision"], "RECLAIM_PID_REUSED")

    def test_09_reclaim_temp_junction_non_traversal_preserves_target(self) -> None:
        repo = self._tmp_root / "junction_repo"
        init_git_repo(repo, [".tmp/"])

        precious_dir = self._tmp_root / "precious_external_data"
        precious_dir.mkdir()
        precious_file = precious_dir / "gold.txt"
        precious_file.write_text("MUST NEVER BE DELETED", encoding="utf-8")

        dead_proc = subprocess.Popen([sys.executable, "-c", "pass"])
        dead_pid = dead_proc.pid
        dead_proc.wait(timeout=10)

        alloc = run_cli("alloc-temp", "--repo-root", str(repo), "--tier", "repo", "--task", "junction-test", "--owner", "tester", "--pid", str(dead_pid), "--json")
        self.assertEqual(alloc.returncode, 0)
        dead_dir = Path(parse_json_stdout(alloc)["canonical_path"])
        make_dir_link(precious_dir, dead_dir / "linked_precious")

        res = run_cli("reclaim-temp", "--repo-root", str(repo), "--execute", "--json")
        self.assertEqual(res.returncode, 0, res.stderr)
        data = parse_json_stdout(res)
        self.assertFalse(dead_dir.exists())
        self.assertTrue(precious_dir.is_dir())
        self.assertEqual(precious_file.read_text(encoding="utf-8"), "MUST NEVER BE DELETED")
        self.assertGreaterEqual(data["reparse_links_unlinked"], 1)

    # 10-11: audit
    def test_10_audit_hardlink_dedup_and_sha256sums_protection(self) -> None:
        repo = self._tmp_root / "audit_repo"
        init_git_repo(repo, [".tmp/", "artifacts/"])

        data_dir = repo / "artifacts" / "release"
        data_dir.mkdir(parents=True)
        blob = b"X" * 65536
        f1 = data_dir / "model_a.bin"
        f1.write_bytes(blob)
        f2 = data_dir / "model_b_hardlink.bin"
        os.link(f1, f2)

        h_blob = sha256_bytes(blob)
        f3 = data_dir / "notes.txt"
        f3.write_bytes(b"hello world")
        h_f3 = sha256_bytes(b"hello world")
        (data_dir / "SHA256SUMS").write_text(
            f"{h_blob}  model_a.bin\n"
            f"{h_blob} *model_b_hardlink.bin\n"
            f"{h_f3} {len(b'hello world')} notes.txt\n",
            encoding="utf-8",
        )

        res = run_cli("audit", "--repo-root", str(repo), "--large-file-mb", "1", "--check", "--json")
        self.assertEqual(res.returncode, 0, res.stdout)
        report = parse_json_stdout(res)
        self.assertTrue(report["check_passed"])
        self.assertGreater(report["accounting"]["logical_bytes"], report["accounting"]["physical_bytes"])
        self.assertGreaterEqual(report["accounting"]["hardlink_dedup_saved_bytes"], len(blob))
        self.assertGreaterEqual(report["protected_summary"]["sha_pinned_files"], 3)

        (repo / "stray.tmp").write_text("clutter", encoding="utf-8")
        (data_dir / "SHA256SUMS").write_text(f"{h_blob}  model_a.bin\n{h_blob}  missing_pinned.bin\n", encoding="utf-8")
        bad = run_cli("audit", "--repo-root", str(repo), "--large-file-mb", "1", "--check", "--json")
        self.assertEqual(bad.returncode, 1)
        bad_report = parse_json_stdout(bad)
        self.assertFalse(bad_report["check_passed"])
        self.assertTrue(any("stray.tmp" in p for p in bad_report["root_clutter"]))
        self.assertTrue(any("missing_pinned.bin" in item["ref"] for item in bad_report["broken_integrity_refs"]))

    def test_11_audit_detects_unignored_large_untracked_and_orphan_temp(self) -> None:
        repo = self._tmp_root / "audit_large_repo"
        init_git_repo(repo, [".tmp/"])
        big_dir = repo / "data"
        big_dir.mkdir()
        (big_dir / "unignored_big.bin").write_bytes(b"Z" * (120 * 1024))

        orphan_dir = repo / ".tmp" / "stale_orphan"
        orphan_dir.mkdir(parents=True)
        (orphan_dir / "junk.txt").write_text("stale", encoding="utf-8")
        old_t = time.time() - 7200
        os.utime(orphan_dir, (old_t, old_t))

        json_out = self._tmp_root / "audit-out.json"
        res = run_cli(
            "audit", "--repo-root", str(repo),
            "--large-file-mb", "0.05", "--orphan-grace-sec", "600",
            "--check", "--json-out", str(json_out), "--json",
        )
        self.assertEqual(res.returncode, 1)
        report = parse_json_stdout(res)
        self.assertTrue(json_out.is_file())
        self.assertTrue(any("unignored_big.bin" in item["relpath"] for item in report["unignored_large_untracked"]))
        self.assertTrue(any("unignored_big.bin" in item["relpath"] for item in report["large_unprotected_candidates"]))
        self.assertTrue(any("stale_orphan" in item["relpath"] for item in report["orphan_temp_dirs"]))

    # 12-15: dehydrate & verify-bundles
    def test_12_dehydrate_fail_closed_gates_1_3_4(self) -> None:
        fx = self._setup_dehydrate_fixture()

        fx["proof"].write_text(json.dumps({"status": "FAILED"}), encoding="utf-8")
        common = [
            "dehydrate", "--repo-root", str(fx["repo"]), "--slot-dir", str(fx["slot"]),
            "--target", "heavy_mesh.bin", "--preserve", "metrics.csv",
            "--command-template", "solver --params params.json", "--engine-version", "v1.0",
            "--parameters-ref", str(fx["params"]), "--reproducibility-tier", "deterministic_recompute",
            "--proof-ref", str(fx["proof"]), "--receipt-dir", str(fx["receipt_dir"]), "--execute", "--json",
        ]
        g4 = run_cli(*common)
        self.assertEqual(g4.returncode, 2)
        self.assertTrue(fx["target"].is_file())
        self.assertIn("GATE4_PROOF_NOT_VERIFIED", {g["code"] for g in parse_json_stdout(g4)["failed_gates"]})

        fx["proof"].write_text(json.dumps({"status": "VERIFIED"}), encoding="utf-8")
        sha_file = fx["slot"] / "SHA256SUMS"
        sha_file.write_text(f"{sha256_bytes(fx['target'].read_bytes())}  heavy_mesh.bin\n", encoding="utf-8")
        g1 = run_cli(*common)
        self.assertEqual(g1.returncode, 2)
        self.assertTrue(fx["target"].is_file())
        self.assertIn("GATE1_TARGET_PROTECTED", {g["code"] for g in parse_json_stdout(g1)["failed_gates"]})
        sha_file.unlink()

        fx["preserved"].write_bytes(b"")
        g3 = run_cli(*common)
        self.assertEqual(g3.returncode, 2)
        self.assertTrue(fx["target"].is_file())
        self.assertIn("GATE3_PRESERVED_INVALID", {g["code"] for g in parse_json_stdout(g3)["failed_gates"]})

    def test_13_dehydrate_gate2_conflict_process_blocks_execution(self) -> None:
        fx = self._setup_dehydrate_fixture()
        live_substr = Path(sys.executable).stem.lower()
        g2 = run_cli(
            "dehydrate", "--repo-root", str(fx["repo"]), "--slot-dir", str(fx["slot"]),
            "--target", "heavy_mesh.bin", "--preserve", "metrics.csv",
            "--command-template", "solver --params params.json", "--engine-version", "v1.0",
            "--parameters-ref", str(fx["params"]), "--reproducibility-tier", "deterministic_recompute",
            "--proof-ref", str(fx["proof"]), "--conflict-proc-substr", live_substr,
            "--receipt-dir", str(fx["receipt_dir"]), "--execute", "--json",
        )
        self.assertEqual(g2.returncode, 2)
        self.assertTrue(fx["target"].is_file())
        self.assertIn("GATE2_CONFLICT_PROCESS", {g["code"] for g in parse_json_stdout(g2)["failed_gates"]})

    def test_14_dehydrate_atomic_execute_and_verify_bundles_tamper(self) -> None:
        fx = self._setup_dehydrate_fixture()
        base_args = [
            "dehydrate", "--repo-root", str(fx["repo"]), "--slot-dir", str(fx["slot"]),
            "--target", "heavy_mesh.bin", "--preserve", "metrics.csv",
            "--command-template", "solver --params params.json", "--engine-version", "v1.2.3",
            "--parameters-ref", str(fx["params"]), "--seed", "42",
            "--reproducibility-tier", "verified_tolerance_recompute",
            "--proof-ref", str(fx["proof"]), "--receipt-dir", str(fx["receipt_dir"]), "--json",
        ]

        dry = run_cli(*base_args)
        self.assertEqual(dry.returncode, 0, dry.stdout)
        self.assertTrue(parse_json_stdout(dry)["dry_run"])
        self.assertTrue(fx["target"].is_file())
        self.assertFalse((fx["slot"] / "dw-dehydrated-bundle.json").exists())

        exe = run_cli(*base_args, "--execute")
        self.assertEqual(exe.returncode, 0, exe.stdout)
        self.assertTrue(parse_json_stdout(exe)["ok"])
        self.assertFalse(fx["target"].exists())
        self.assertTrue((fx["slot"] / "dw-dehydrated-bundle.json").is_file())
        self.assertTrue((fx["receipt_dir"] / "DEHYDRATION-RECEIPT.json").is_file())
        self.assertTrue((fx["receipt_dir"] / "SHA256SUMS").is_file())

        ver_ok = run_cli("verify-bundles", "--repo-root", str(fx["repo"]), "--receipt-dir", str(fx["receipt_dir"]), "--json")
        self.assertEqual(ver_ok.returncode, 0, ver_ok.stdout)
        vdata = parse_json_stdout(ver_ok)
        self.assertTrue(vdata["ok"])
        self.assertEqual(vdata["dw_bundles_checked"], 1)

        again = run_cli(*base_args, "--execute")
        self.assertEqual(again.returncode, 2)
        again_codes = {g["code"] for g in parse_json_stdout(again)["failed_gates"]}
        self.assertIn("GATE5_RECEIPT_EXISTS", again_codes)
        self.assertIn("GATE6_BUNDLE_EXISTS", again_codes)

        orig = fx["preserved"].read_bytes()
        tampered = bytearray(orig)
        tampered[0] ^= 0x01
        fx["preserved"].write_bytes(bytes(tampered))

        ver_bad = run_cli("verify-bundles", "--repo-root", str(fx["repo"]), "--receipt-dir", str(fx["receipt_dir"]), "--json")
        self.assertEqual(ver_bad.returncode, 1)
        self.assertGreaterEqual(parse_json_stdout(ver_bad)["failure_count"], 1)

    def test_15_verify_bundles_mph_legacy_compatibility_and_audit_exclusion(self) -> None:
        repo = self._tmp_root / "mph_compat_repo"
        init_git_repo(repo, [".tmp/", "artifacts/"])
        slot = repo / "artifacts" / "W1" / "native" / "JOB_01"
        export_dir = slot / "results" / "JOB_01"
        export_dir.mkdir(parents=True)

        slot_res = slot / "slot-result.json"
        slot_res.write_bytes(b'{"ok":true}\n')
        geom_file = export_dir / "native-geometry.json"
        geom_file.write_bytes(b'{"n_dots":31}\n')

        bundle = {
            "schema_version": "mph-dehydrated-bundle/v1",
            "created_utc": "2026-11-25T16:58:36+00:00",
            "job_id": "JOB_01",
            "slot_relpath": "artifacts/W1/native/JOB_01",
            "export_relpath": "artifacts/W1/native/JOB_01/results/JOB_01",
            "dehydrated_mph_files": [{"filename": "solved.mph", "relpath": "artifacts/W1/native/JOB_01/results/JOB_01/solved.mph", "bytes": 12345678, "sha256": "a" * 64}],
            "preserved_evidence": {
                "slot-result.json": {"bytes": len(slot_res.read_bytes()), "sha256": sha256_bytes(slot_res.read_bytes())},
                "results/JOB_01/native-geometry.json": {"bytes": len(geom_file.read_bytes()), "sha256": sha256_bytes(geom_file.read_bytes())},
            },
        }
        (export_dir / "mph-dehydrated-bundle.json").write_text(json.dumps(bundle, indent=2), encoding="utf-8")
        (export_dir / "SHA256SUMS").write_text(f"{'a' * 64}  solved.mph\n", encoding="utf-8")

        ver = run_cli("verify-bundles", "--repo-root", str(repo), "--json")
        self.assertEqual(ver.returncode, 0, ver.stdout)
        self.assertEqual(parse_json_stdout(ver)["mph_bundles_checked"], 1)

        aud = run_cli("audit", "--repo-root", str(repo), "--check", "--json")
        self.assertEqual(aud.returncode, 0, aud.stdout)
        self.assertEqual(parse_json_stdout(aud)["broken_integrity_refs"], [])

        geom_file.write_bytes(b'{"n_dots":32}\n')
        ver_bad = run_cli("verify-bundles", "--repo-root", str(repo), "--json")
        self.assertEqual(ver_bad.returncode, 1)
        self.assertGreaterEqual(parse_json_stdout(ver_bad)["failure_count"], 1)

    # 16-17: archive-index
    def test_16_archive_index_seal_verify_immutability_and_tamper(self) -> None:
        repo = self._tmp_root / "archive_repo"
        init_git_repo(repo, [".tmp/", "artifacts/"])
        arch = repo / "artifacts" / "archive" / "batch-20261125"
        arch.mkdir(parents=True)
        (arch / "summary.json").write_text('{"score": 1.0}\n', encoding="utf-8")
        (arch / "sub").mkdir()
        (arch / "sub" / "data.csv").write_text("x,y\n1,2\n", encoding="utf-8")

        common = [
            "archive-index", "--repo-root", str(repo), "--archive-dir", str(arch),
            "--batch-id", "batch-20261125", "--reason", "end-of-milestone cold archive", "--source-ref", "commit:abc123", "--json",
        ]
        dry = run_cli(*common)
        self.assertEqual(dry.returncode, 0, dry.stdout)
        self.assertFalse((arch / "ARCHIVE-MANIFEST.json").exists())

        seal = run_cli(*common, "--execute")
        self.assertEqual(seal.returncode, 0, seal.stdout)
        self.assertTrue((arch / "ARCHIVE-MANIFEST.json").is_file())
        self.assertTrue((arch / "SHA256SUMS").is_file())

        reseal = run_cli(*common, "--execute")
        self.assertEqual(reseal.returncode, 2)

        ver = run_cli("archive-index", "--repo-root", str(repo), "--archive-dir", str(arch), "--verify", "--json")
        self.assertEqual(ver.returncode, 0, ver.stdout)
        self.assertTrue(parse_json_stdout(ver)["ok"])

        (arch / "sub" / "data.csv").write_text("x,y\n1,3\n", encoding="utf-8")
        ver_tamper = run_cli("archive-index", "--repo-root", str(repo), "--archive-dir", str(arch), "--verify", "--json")
        self.assertEqual(ver_tamper.returncode, 1)
        self.assertFalse(parse_json_stdout(ver_tamper)["ok"])

    def test_17_archive_index_detects_extra_unindexed_file(self) -> None:
        repo = self._tmp_root / "archive_extra_repo"
        init_git_repo(repo, [".tmp/", "artifacts/"])
        arch = repo / "artifacts" / "archive" / "batch-extra"
        arch.mkdir(parents=True)
        (arch / "report.json").write_text('{"ok": true}\n', encoding="utf-8")

        seal = run_cli("archive-index", "--repo-root", str(repo), "--archive-dir", str(arch), "--batch-id", "batch-extra", "--reason", "seal test", "--execute", "--json")
        self.assertEqual(seal.returncode, 0)

        (arch / "rogue.txt").write_text("injected after sealing", encoding="utf-8")
        ver = run_cli("archive-index", "--repo-root", str(repo), "--archive-dir", str(arch), "--verify", "--json")
        self.assertEqual(ver.returncode, 1)
        vdata = parse_json_stdout(ver)
        self.assertFalse(vdata["ok"])
        self.assertTrue(any("rogue.txt" in f["detail"] for f in vdata["failures"]))

    # 18-19: skill metadata, links, and JSON schemas
    def test_18_skill_md_frontmatter_line_limit_and_links(self) -> None:
        self.assertTrue(SKILL_MD_PATH.is_file())
        self.assertFalse((SKILL_DIR / "references" / "dw-merge-checklist.md").exists())
        content = SKILL_MD_PATH.read_text(encoding="utf-8")
        self.assertLessEqual(len(content.splitlines()), 120)

        m = re.match(r"^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)", content)
        self.assertIsNotNone(m)
        fields: dict[str, str] = {}
        for line in m.group(1).splitlines():
            self.assertFalse(line.startswith((" ", "\t")), line)
            fm = re.match(r"^([a-z][a-z-]*):\s*(.*?)\s*$", line)
            self.assertIsNotNone(fm, line)
            self.assertNotIn(fm.group(2), (">", ">-", "|", "|-"))
            fields[fm.group(1)] = fm.group(2)
        self.assertEqual(fields.get("name"), "dw-file-governance")
        self.assertTrue(fields.get("description", "").startswith("Use when "))

        for p in SKILL_DIR.rglob("*"):
            self.assertFalse(p.is_symlink(), f"Symlink forbidden: {p}")
        for p in (SKILL_DIR / "scripts").rglob("*"):
            self.assertNotIn("test", p.name.lower(), f"Test file forbidden: {p}")

        fence_re = re.compile(r"^\s*(\x60{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$", re.MULTILINE)
        link_re = re.compile(r"\[[^\]\n]*\]\(([^)\n]+)\)")
        for md in sorted(SKILL_DIR.rglob("*.md")):
            prose = fence_re.sub("", md.read_text(encoding="utf-8"))
            for match in link_re.finditer(prose):
                raw_target = match.group(1).strip().strip("<>")
                if re.match(r"^(?:[a-z][a-z0-9+.-]*:|#)", raw_target, re.IGNORECASE):
                    continue
                target_no_anchor = raw_target.split("#", 1)[0]
                if not target_no_anchor:
                    continue
                self.assertNotIn("\\", target_no_anchor)
                resolved = (md.parent / target_no_anchor).resolve()
                self.assertTrue(resolved.is_relative_to(PLUGIN_ROOT), f"Escapes plugin root: {raw_target}")
                self.assertTrue(resolved.exists(), f"Missing link target: {raw_target} -> {resolved}")

    def test_19_schemas_are_valid_json_documents(self) -> None:
        schemas_dir = SKILL_DIR / "references" / "schemas"
        for name in ("TempLease1.schema.json", "DehydratedBundle1.schema.json", "ArchiveManifest1.schema.json"):
            p = schemas_dir / name
            self.assertTrue(p.is_file(), str(p))
            doc = json.loads(p.read_text(encoding="utf-8"))
            self.assertIsInstance(doc, dict)
            self.assertIn("$schema", doc)
            self.assertIn("properties", doc)
            self.assertIn("required", doc)

    # 20-25: hardened boundary regressions
    def test_20_nonexistent_repo_root_fails_closed(self) -> None:
        missing = self._tmp_root / "does_not_exist_repo"
        for subcmd_args in (
            ("check-path", "--repo-root", str(missing), "--target", "a.txt", "--json"),
            ("alloc-temp", "--repo-root", str(missing), "--tier", "os", "--task", "t", "--owner", "o", "--json"),
            ("reclaim-temp", "--repo-root", str(missing), "--json"),
            ("audit", "--repo-root", str(missing), "--json"),
            ("verify-bundles", "--repo-root", str(missing), "--json"),
            ("archive-index", "--repo-root", str(missing), "--archive-dir", str(self._tmp_root), "--verify", "--json"),
        ):
            res = run_cli(*subcmd_args)
            self.assertEqual(res.returncode, 2, subcmd_args)
            self.assertEqual(parse_json_stdout(res)["code"], "INVALID_REPO_ROOT")

    def test_21_invalid_numeric_and_string_bounds_rejected(self) -> None:
        repo = self._tmp_root / "bounds_repo"
        init_git_repo(repo, [".tmp/", "artifacts/"])
        arch = repo / "artifacts" / "archive" / "b1"
        arch.mkdir(parents=True)
        (arch / "f.txt").write_text("ok", encoding="utf-8")

        bad_calls = [
            ("alloc-temp", "--repo-root", str(repo), "--tier", "os", "--task", "t", "--owner", "o", "--pid", "0", "--json"),
            ("alloc-temp", "--repo-root", str(repo), "--tier", "os", "--task", "t", "--owner", "o", "--ttl-sec", "-5", "--json"),
            ("alloc-temp", "--repo-root", str(repo), "--tier", "os", "--task", "   ", "--owner", "o", "--json"),
            ("reclaim-temp", "--repo-root", str(repo), "--grace-sec", "-1", "--json"),
            ("audit", "--repo-root", str(repo), "--large-file-mb", "0", "--json"),
            ("audit", "--repo-root", str(repo), "--orphan-grace-sec", "-1", "--json"),
            ("archive-index", "--repo-root", str(repo), "--archive-dir", str(arch), "--batch-id", "   ", "--reason", "r", "--json"),
        ]
        for args in bad_calls:
            res = run_cli(*args)
            self.assertEqual(res.returncode, 2, args)
            self.assertFalse(parse_json_stdout(res)["ok"])

    def test_22_relative_cli_dirs_anchor_to_repo_root_across_cwd(self) -> None:
        fx = self._setup_dehydrate_fixture()
        other_cwd = self._tmp_root / "separate_cwd"
        other_cwd.mkdir()

        exe = run_cli(
            "dehydrate",
            "--repo-root", str(fx["repo"]),
            "--slot-dir", "artifacts/runs/slot_01",
            "--target", "heavy_mesh.bin",
            "--preserve", "metrics.csv",
            "--command-template", "solver --params params.json",
            "--engine-version", "v1.0",
            "--parameters-ref", "artifacts/runs/slot_01/params.json",
            "--reproducibility-tier", "deterministic_recompute",
            "--proof-ref", "artifacts/proofs/recompute_proof.json",
            "--receipt-dir", "artifacts/receipts/batch_01",
            "--execute",
            "--json",
            cwd=other_cwd,
        )
        self.assertEqual(exe.returncode, 0, exe.stdout + exe.stderr)
        self.assertTrue((fx["receipt_dir"] / "DEHYDRATION-RECEIPT.json").is_file())
        self.assertFalse((other_cwd / "artifacts").exists())

        ver = run_cli(
            "verify-bundles",
            "--repo-root", str(fx["repo"]),
            "--receipt-dir", "artifacts/receipts/batch_01",
            "--json",
            cwd=other_cwd,
        )
        self.assertEqual(ver.returncode, 0, ver.stdout)

    def test_23_dehydrate_duplicate_target_and_escaping_preserve_fail_closed(self) -> None:
        fx = self._setup_dehydrate_fixture()

        dup = run_cli(
            "dehydrate", "--repo-root", str(fx["repo"]), "--slot-dir", str(fx["slot"]),
            "--target", "heavy_mesh.bin", "--target", "heavy_mesh.bin",
            "--preserve", "metrics.csv",
            "--command-template", "solver", "--engine-version", "v1.0",
            "--parameters-ref", str(fx["params"]),
            "--reproducibility-tier", "deterministic_recompute",
            "--proof-ref", str(fx["proof"]),
            "--receipt-dir", str(fx["receipt_dir"]),
            "--execute", "--json",
        )
        self.assertEqual(dup.returncode, 2)
        self.assertTrue(fx["target"].is_file())
        self.assertIn("GATE1_DUPLICATE_TARGET", {g["code"] for g in parse_json_stdout(dup)["failed_gates"]})

        outside = self._tmp_root / "outside_escape_dir"
        outside.mkdir()
        (outside / "leak.csv").write_text("k,v\n1,2\n", encoding="utf-8")
        make_dir_link(outside, fx["slot"] / "linked_sub")

        esc = run_cli(
            "dehydrate", "--repo-root", str(fx["repo"]), "--slot-dir", str(fx["slot"]),
            "--target", "heavy_mesh.bin", "--preserve", "linked_sub/leak.csv",
            "--command-template", "solver", "--engine-version", "v1.0",
            "--parameters-ref", str(fx["params"]),
            "--reproducibility-tier", "deterministic_recompute",
            "--proof-ref", str(fx["proof"]),
            "--receipt-dir", str(fx["receipt_dir"]),
            "--execute", "--json",
        )
        self.assertEqual(esc.returncode, 2)
        self.assertTrue(fx["target"].is_file())
        self.assertIn("GATE3_PRESERVED_INVALID", {g["code"] for g in parse_json_stdout(esc)["failed_gates"]})

    def test_24_verify_bundles_and_archive_verify_reject_path_traversal(self) -> None:
        repo = self._tmp_root / "traversal_repo"
        init_git_repo(repo, [".tmp/", "artifacts/"])
        secret = self._tmp_root / "outside_secret.txt"
        secret.write_bytes(b"SECRET")

        slot = repo / "artifacts" / "W1" / "native" / "JOB_T"
        slot.mkdir(parents=True)
        mph_bundle = {
            "schema_version": "mph-dehydrated-bundle/v1",
            "slot_relpath": "artifacts/W1/native/JOB_T",
            "dehydrated_mph_files": [{"filename": "a.mph", "relpath": "artifacts/W1/native/JOB_T/a.mph", "bytes": 10, "sha256": "a" * 64}],
            "preserved_evidence": {
                "../../../../outside_secret.txt": {"bytes": 6, "sha256": sha256_bytes(b"SECRET")},
            },
        }
        (slot / "mph-dehydrated-bundle.json").write_text(json.dumps(mph_bundle), encoding="utf-8")
        ver_b = run_cli("verify-bundles", "--repo-root", str(repo), "--json")
        self.assertEqual(ver_b.returncode, 1)
        self.assertTrue(any("invalid_or_escaping_evidence_path" in err for f in parse_json_stdout(ver_b)["failures"] for err in f["errors"]))

        arch = repo / "artifacts" / "archive" / "batch-trav"
        arch.mkdir(parents=True)
        (arch / "ok.txt").write_text("ok", encoding="utf-8")
        seal = run_cli("archive-index", "--repo-root", str(repo), "--archive-dir", str(arch), "--batch-id", "btrav", "--reason", "test", "--execute", "--json")
        self.assertEqual(seal.returncode, 0)

        # Inject a traversal entry into SHA256SUMS targeting outside_secret.txt
        sha_p = arch / "SHA256SUMS"
        sha_p.write_text(sha_p.read_text(encoding="utf-8") + f"{sha256_bytes(b'SECRET')}  ../../../../outside_secret.txt\n", encoding="utf-8")
        ver_a = run_cli("archive-index", "--repo-root", str(repo), "--archive-dir", str(arch), "--verify", "--json")
        self.assertEqual(ver_a.returncode, 1)
        self.assertIn("ESCAPING_ARCHIVE_PATH", {f["code"] for f in parse_json_stdout(ver_a)["failures"]})

    def test_25_archive_index_refuses_repo_root_as_archive_dir(self) -> None:
        repo = self._tmp_root / "root_archive_repo"
        init_git_repo(repo, [".tmp/"])
        (repo / "keep.txt").write_text("keep", encoding="utf-8")

        res = run_cli(
            "archive-index", "--repo-root", str(repo), "--archive-dir", str(repo),
            "--batch-id", "bad-root", "--reason", "should fail", "--execute", "--json",
        )
        self.assertEqual(res.returncode, 2)
        self.assertEqual(parse_json_stdout(res)["code"], "INVALID_ARCHIVE_DIR")


if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromTestCase(FileGovernanceTests)
    runner = unittest.TextTestRunner(verbosity=2, stream=sys.stdout)
    result = runner.run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
`;

function main() {
  assert(fs.existsSync(scriptPath), `Missing ${scriptPath}`);
  const scriptBytes = fs.readFileSync(scriptPath);
  assert(!scriptBytes.includes(0x0d), 'workspace_governance.py must use LF line endings only');

  const pythonExe = resolvePythonExecutable();
  assert(pythonExe, 'Python >= 3.9 interpreter is required to verify dw-file-governance CLI');

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-fg-suite-'));
  const runnerPath = path.join(workRoot, 'run_suite.py');
  try {
    fs.writeFileSync(runnerPath, PYTHON_TEST_SUITE, 'utf8');
    const cleanEnv = { ...process.env };
    for (const key of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_COMMON_DIR',
      'GIT_CEILING_DIRECTORIES',
    ]) {
      delete cleanEnv[key];
    }
    cleanEnv.PYTHONDONTWRITEBYTECODE = '1';
    cleanEnv.PYTHONIOENCODING = 'utf-8';
    cleanEnv.DW_PLUGIN_ROOT = pluginRoot;

    const proc = childProcess.spawnSync(pythonExe, ['-B', runnerPath], {
      cwd: pluginRoot,
      env: cleanEnv,
      encoding: 'utf8',
      timeout: 180000,
      windowsHide: true,
    });
    assert.strictEqual(proc.error, undefined, proc.error && proc.error.message);
    if (proc.stdout) process.stdout.write(proc.stdout);
    if (proc.stderr) process.stderr.write(proc.stderr);
    assert.strictEqual(proc.status, 0, `Python file-governance suite exited with ${proc.status}`);
    console.log('ok - 25/25 dw-file-governance CLI & contract tests passed');
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(workRoot));
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

main();
