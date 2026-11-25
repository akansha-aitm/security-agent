import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitHubSource } from "../src/sources/github.mjs";

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
    assert.ok(seen.every((r) => r.auth === "Bearer t0ken-value"));

    const only = createGitHubSource({ apiUrl: "https://api.example.test", token: "x", owner: "acme", repos: ["security-agent"] });
    assert.deepEqual((await only.listTargets()).map((t) => t.name), ["acme/security-agent"]);

    const personal = createGitHubSource({ apiUrl: "https://api.example.test", token: "x", owner: "akan" });
    assert.deepEqual((await personal.listTargets()).map((t) => t.name), ["akan/sample"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
