// Read-only GitHub source. The token needs repository Contents: read and Metadata: read
// (a GitHub App installation token, or a fine-grained personal access token).
// `owner` can be an organisation or a personal account (useful for testing).
import { scrub } from "../util.mjs";
import { syncBareClone } from "./clone.mjs";

export function createGitHubSource({ apiUrl = "https://api.github.com", token, owner, repos = [], exclude = [] }) {
  if (!token) throw new Error("GITHUB_SCAN_TOKEN is not set");
  if (!owner) throw new Error("GITHUB_OWNER is not set");
  const api = apiUrl.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "security-agent",
  };

  async function request(url) {
    const res = await fetch(url, { headers });
    if (res.status === 404) return { body: null, next: null };
    if (!res.ok) throw new Error(scrub(`GitHub ${new URL(url).pathname} -> HTTP ${res.status}`));
    const next = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    return { body: await res.json(), next };
  }

  async function all(path, params = {}) {
    const items = [];
    let url = `${api}${path}?${new URLSearchParams({ ...params, per_page: "100" })}`;
    while (url) {
      const { body, next } = await request(url);
      if (!body) break;
      items.push(...body);
      url = next;
    }
    return items;
  }

  const findUser = async (username) => {
    const { body } = await request(`${api}/users/${encodeURIComponent(username)}`);
    return body ? { username: body.login, name: body.name ?? "", email: body.email ?? null } : null;
  };

  /** All repos of the owner that the token can read. */
  async function listOwnerRepos() {
    const { body: account } = await request(`${api}/users/${encodeURIComponent(owner)}`);
    if (!account) throw new Error(`GitHub account "${owner}" not found`);
    if (account.type === "Organization") return all(`/orgs/${encodeURIComponent(owner)}/repos`, { type: "all", sort: "full_name" });
    const mine = (r) => r.owner?.login?.toLowerCase() === owner.toLowerCase();
    try {
      // Personal access token: the account's own repos, private ones included.
      return (await all("/user/repos", { affiliation: "owner", sort: "full_name" })).filter(mine);
    } catch {
      // GitHub App installed on a personal account: no "current user", list the installation's repos.
      const items = [];
      let url = `${api}/installation/repositories?per_page=100`;
      while (url) {
        const { body, next } = await request(url);
        items.push(...(body?.repositories ?? []));
        url = next;
      }
      return items.filter(mine);
    }
  }

  const matches = (r, list) => list.includes(r.full_name.toLowerCase()) || list.includes(r.name.toLowerCase());

  return {
    kind: "github",
    ownerRoleLabel: "an admin or maintainer collaborator on this GitHub repository",

    async listTargets() {
      let list = (await listOwnerRepos()).filter((r) => !r.archived && !r.fork && !r.disabled);
      if (repos.length) list = list.filter((r) => matches(r, repos));
      if (exclude.length) list = list.filter((r) => !matches(r, exclude));
      return list.map((r) => ({
        key: `github:${r.id}`,
        name: r.full_name,
        webUrl: r.html_url,
        ref: r.full_name,
        cloneUrl: r.clone_url,
        defaultBranch: r.default_branch,
      }));
    },

    async listBranches(target) {
      const branches = await all(`/repos/${target.ref}/branches`);
      return Object.fromEntries(branches.map((b) => [b.name, b.commit.sha]));
    },

    syncClone: (target, dir) => syncBareClone(target.cloneUrl, dir, `x-access-token:${token}`),

    findUser,

    /** Users added directly to the repo as admin or maintain. Team-based access is not expanded yet. */
    async platformOwners(target) {
      const collaborators = await all(`/repos/${target.ref}/collaborators`, { affiliation: "direct" });
      const owners = collaborators.filter(
        (c) => c.type === "User" && (["admin", "maintain"].includes(c.role_name) || c.permissions?.admin || c.permissions?.maintain),
      );
      return (await Promise.all(owners.slice(0, 5).map((c) => findUser(c.login)))).filter(Boolean);
    },
  };
}
