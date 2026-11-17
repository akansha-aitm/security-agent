// Read-only GitLab source (kept for a later phase). The token needs read_api + read_repository.
import { scrub } from "../util.mjs";
import { syncBareClone } from "./clone.mjs";

const BOT_USER_RE = /^(project|group)_\d+_bot/i;

export function createGitLabSource({ url = "https://gitlab.com", token, group, repos = [], exclude = [] }) {
  if (!token) throw new Error("GITLAB_TOKEN is not set");
  if (!group) throw new Error("GITLAB_GROUP is not set");
  const api = `${url.replace(/\/$/, "")}/api/v4`;

  async function request(path, params = {}) {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const res = await fetch(`${api}${path}?${qs}`, { headers: { "PRIVATE-TOKEN": token } });
    if (!res.ok) throw new Error(scrub(`GitLab ${path} -> HTTP ${res.status}`));
    return { body: await res.json(), next: res.headers.get("x-next-page") };
  }

  async function all(path, params = {}) {
    const items = [];
    let page = "1";
    while (page) {
      const { body, next } = await request(path, { ...params, per_page: 100, page });
      items.push(...body);
      page = next;
    }
    return items;
  }

  const toUser = (u) => ({ username: u.username, name: u.name ?? "", email: u.public_email || null });
  const getUser = async (id) => toUser((await request(`/users/${id}`)).body);
  const matches = (p, list) => list.includes(p.path_with_namespace.toLowerCase()) || list.includes(String(p.id));

  return {
    kind: "gitlab",
    ownerRoleLabel: "a direct Maintainer of this project in GitLab",

    async listTargets() {
      let list = (
        await all(`/groups/${encodeURIComponent(group)}/projects`, { include_subgroups: true, archived: false, order_by: "id", sort: "asc" })
      ).filter((p) => !p.empty_repo && !p.archived);
      if (repos.length) list = list.filter((p) => matches(p, repos));
      if (exclude.length) list = list.filter((p) => !matches(p, exclude));
      return list.map((p) => ({
        key: `gitlab:${p.id}`,
        name: p.path_with_namespace,
        webUrl: p.web_url,
        ref: p.id,
        cloneUrl: p.http_url_to_repo,
        defaultBranch: p.default_branch,
      }));
    },

    async listBranches(target) {
      const branches = await all(`/projects/${target.ref}/repository/branches`);
      return Object.fromEntries(branches.map((b) => [b.name, b.commit.id]));
    },

    syncClone: (target, dir) => syncBareClone(target.cloneUrl, dir, `oauth2:${token}`),

    async findUser(username) {
      const found = (await request("/users", { username })).body[0];
      return found ? getUser(found.id) : null;
    },

    /** Direct members only: inherited group members say nothing about who owns this project. */
    async platformOwners(target) {
      const members = (await all(`/projects/${target.ref}/members`)).filter(
        (m) => m.access_level >= 40 && m.state === "active" && !BOT_USER_RE.test(m.username),
      );
      return Promise.all(members.slice(0, 5).map((m) => getUser(m.id)));
    },
  };
}
