"""Run paired client profiles against isolated, disposable Tila projects."""

import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).resolve().parent
BASE = ROOT / ".context/mcp-evaluation"


def run(client: str, profile: str, scenario: str) -> dict:
    directory = BASE / f"{client}-{profile}-{scenario}-{time.time_ns()}"
    subprocess.run(
        ["node", str(SOURCE / "seed.mjs"), str(directory), scenario, profile],
        check=True, cwd=ROOT,
    )
    prompt = (directory / "prompt.txt").read_text()
    config = json.loads((directory / "mcp.json").read_text())["mcpServers"]["tila"]
    if client == "claude":
        cmd = [
            "claude", "-p", prompt, "--output-format", "stream-json", "--verbose",
            "--strict-mcp-config", "--mcp-config", str(directory / "mcp.json"),
            "--tools", "", "--allowedTools", "mcp__tila__*", "--setting-sources", "",
            "--settings", '{"disableAllHooks":true}',
        ]
    else:
        cmd = [
            "codex", "exec", "--ignore-user-config", "--ephemeral", "--json",
            "--skip-git-repo-check", "--sandbox", "read-only", "-C", str(directory),
            "-c", 'mcp_servers.tila.default_tools_approval_mode="approve"',
            "-c", f'mcp_servers.tila.command={json.dumps(config["command"])}',
            "-c", f'mcp_servers.tila.args={json.dumps(config["args"])}',
        ]
        for key, value in config["env"].items():
            cmd += ["-c", f"mcp_servers.tila.env.{key}={json.dumps(value)}"]
        cmd.append(prompt)
    env = dict(os.environ)
    env.pop("CLAUDECODE", None)
    start = time.time()
    with (
        (directory / "client.jsonl").open("w") as out,
        (directory / "stderr.log").open("w") as err,
    ):
        try:
            process = subprocess.run(
                cmd, cwd=directory, env=env, stdin=subprocess.DEVNULL,
                stdout=out, stderr=err, timeout=240,
            )
            status = process.returncode
        except subprocess.TimeoutExpired:
            status = "timeout"
    summary = {
        "client": client, "profile": profile, "scenario": scenario,
        "exit": status, "finished_at": int(time.time() * 1000),
        "seconds": round(time.time() - start, 2), "directory": str(directory),
    }
    (directory / "run.json").write_text(json.dumps(summary))
    print(json.dumps(summary), flush=True)
    return summary


if __name__ == "__main__":
    BASE.mkdir(parents=True, exist_ok=True)
    cases = [
        (client, profile, scenario)
        for scenario in ["normal", "stale", "reentry", "contention", "artifact"]
        for profile in ["workflow", "all"]
        for client in ["claude", "codex"]
    ]
    if "--pilot" in sys.argv:
        cases = [("claude", "workflow", "normal"), ("codex", "workflow", "normal")]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda args: run(*args), cases))
