import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubSource } from "../src/sources/github.mjs";
import { resolveOwners } from "../src/owners.mjs";
import { run } from "../src/util.mjs";

const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

test("GitHub source: organisations and personal accounts, paging, filters", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.Authorization });
    const u = new URL(url);
    if (u.pathname === "/users/acme") return json({ login: "acme", type: "Organization" });
    if (u.pathname === "/users/akan") return json({ login: "akan", type: "User" });
    if (u.pathname === "/user/repos")
      return json([
        { id: 7, name: "sample", full_name: "akan/sample", owner: { login: "akan" }, html_url: "h7", clone_url: "c7", default_branch: "main", archived: false, fork: false },
        { id: 8, name: "theirs", full_name: "someone/theirs", owner: { login: "someone" }, archived: false, fork: false },
      ]);
    if (u.pathname === "/orgs/acme/repos" && u.searchParams.get("page") !== "2")
      return json(
        [
          { id: 1, name: "web", full_name: "acme/web", html_url: "h1", clone_url: "c1", default_branch: "main", archived: false, fork: false },
          { id: 2, name: "old", full_name: "acme/old", archived: true, fork: false },
        ],
        { link: '<https://api.example.test/orgs/acme/repos?per_page=100&page=2>; rel="next"' },
      );
    if (u.pathname === "/orgs/acme/repos")
      return json([
        { id: 3, name: "fork", full_name: "acme/fork", archived: false, fork: true },
        { id: 4, name: "security-agent", full_name: "acme/security-agent", html_url: "h4", clone_url: "c4", default_branch: "main", archived: false, fork: false },
      ]);
    if (u.pathname === "/repos/acme/web/branches") return json([{ name: "main", commit: { sha: "abc" } }, { name: "dev", commit: { sha: "def" } }]);
    if (u.pathname === "/repos/acme/web/collaborators")
      return json([
        { login: "lead", type: "User", role_name: "admin" },
        { login: "dev1", type: "User", role_name: "write" },
      ]);
    if (u.pathname === "/users/lead") return json({ login: "lead", name: "Tech Lead", email: null });
    return new Response("not found", { status: 404 });
  };
  try {
    const src = createGitHubSource({ apiUrl: "https://api.example.test", token: "t0ken-value", owner: "acme", exclude: ["acme/security-agent"] });
    const targets = await src.listTargets();
    assert.deepEqual(targets.map((t) => t.name), ["acme/web"]);
    assert.equal(targets[0].key, "github:1");
    assert.deepEqual(await src.listBranches(targets[0]), { main: "abc", dev: "def" });
    assert.deepEqual(await src.platformOwners(targets[0]), [{ username: "lead", name: "Tech Lead", email: null }]);
    assert.equal(await src.findUser("ghost"), null);
    assert.ok(seen.every((r) => r.auth === "Bearer t0ken-value"));

    const only = createGitHubSource({ apiUrl: "https://api.example.test", token: "x", owner: "acme", repos: ["security-agent"] });
    assert.deepEqual((await only.listTargets()).map((t) => t.name), ["acme/security-agent"]);

    const personal = createGitHubSource({ apiUrl: "https://api.example.test", token: "x", owner: "akan" });
    assert.deepEqual((await personal.listTargets()).map((t) => t.name), ["akan/sample"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("owners: GitHub noreply commit emails are mapped to work emails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "secagent-owners-"));
  try {
    run("git", ["init", "-q", "-b", "main", dir]);
    const commitAs = (name, email, n) => {
      for (let i = 0; i < n; i++) {
        writeFileSync(join(dir, `f-${email}-${i}.txt`), String(i));
        run("git", ["-C", dir, "add", "-A"]);
        run("git", ["-C", dir, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "c"]);
      }
    };
    commitAs("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com", 5);
    commitAs("Alice", "123+alice@users.noreply.github.com", 3);
    commitAs("Bob", "bob@corp.test", 1);
    const sha = run("git", ["-C", dir, "rev-parse", "HEAD"]).trim();

    // No CODEOWNERS, no provider: top human committer is Alice, mapped through the directory.
    let owners = await resolveOwners({ dir, defaultSha: sha, directory: { alice: "alice@corp.test" } });
    assert.deepEqual([owners.source, owners.emails], ["committer", ["alice@corp.test"]]);

    // Alice cannot be mapped: fall through to the next committer with a real email.
    owners = await resolveOwners({ dir, defaultSha: sha, directory: {} });
    assert.deepEqual(owners.emails, ["bob@corp.test"]);

    // CODEOWNERS with @username, resolved through the provider's public email.
    writeFileSync(join(dir, "CODEOWNERS"), "* @carol\n");
    run("git", ["-C", dir, "add", "-A"]);
    run("git", ["-C", dir, "-c", "user.name=Bob", "-c", "user.email=bob@corp.test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "owners"]);
    const sha2 = run("git", ["-C", dir, "rev-parse", "HEAD"]).trim();
    const provider = {
      findUser: async (u) => (u === "carol" ? { username: "carol", name: "Carol", email: "carol@corp.test" } : null),
      platformOwners: async () => [],
      ownerRoleLabel: "x",
    };
    owners = await resolveOwners({ dir, defaultSha: sha2, provider, target: { name: "r" }, directory: {} });
    assert.deepEqual([owners.source, owners.emails], ["codeowners", ["carol@corp.test"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
