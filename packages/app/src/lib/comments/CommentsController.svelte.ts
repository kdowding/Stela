import type { Comment, CreateCommentRequest, ResolveCommentRequest } from "@stela/shared";
import { partitionPins, groupOffPage, type CurrentView } from "./viewFilter";

/**
 * Single source of truth for one artifact's comments, shared by the canvas overlay (pins) and the side
 * panel (discussion + threads). It owns the data and the cross-surface selection — `openThreadId` (the
 * thread shown in the panel) and `hoveredId` (drives the two-way pin↔row highlight). Each surface keeps
 * its own local UI (the overlay its draft pin; the panel its composer + collapse).
 *
 * The viewer owns the instance and keeps artifactId / version / view in sync; a version switch reloads.
 */
export class CommentsController {
  artifactId = $state("");
  version = $state(1);
  /** The page the artifact currently shows (embed bridge), or null if single-page / undetected. */
  view = $state<CurrentView>(null);

  comments = $state<Comment[]>([]);
  busy = $state(false);
  openThreadId = $state<string | null>(null);
  hoveredId = $state<string | null>(null);

  #seq = 0;

  roots = $derived(this.comments.filter((c) => !c.parentId));
  /** General (unpinned) comments — the artifact-wide discussion. */
  general = $derived(this.roots.filter((c) => !c.anchor));
  /** Pinned comments split into the current page vs. other pages. */
  partition = $derived(partitionPins(this.roots, this.view));
  offPageGroups = $derived(groupOffPage(this.partition.offPage));
  total = $derived(this.roots.length);

  repliesByParent = $derived.by(() => {
    const map = new Map<string, Comment[]>();
    for (const c of this.comments) {
      if (!c.parentId) continue;
      const list = map.get(c.parentId) ?? [];
      list.push(c);
      map.set(c.parentId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return map;
  });

  openThread = $derived(
    this.openThreadId ? (this.roots.find((r) => r.id === this.openThreadId) ?? null) : null,
  );

  replyCount(id: string): number {
    return this.repliesByParent.get(id)?.length ?? 0;
  }

  async load(): Promise<void> {
    const seq = ++this.#seq;
    try {
      const res = await fetch(`/api/artifacts/${this.artifactId}/comments?v=${this.version}`);
      if (!res.ok) return;
      const data = (await res.json()) as Comment[];
      if (seq === this.#seq) this.comments = data; // ignore a stale prior-version response
    } catch {
      /* storage may be down in dev — ignore */
    }
  }

  /** Create a comment (pinned if the payload has an anchor, general if not) and refresh. */
  async create(payload: CreateCommentRequest): Promise<Comment | null> {
    this.busy = true;
    try {
      const res = await fetch(`/api/artifacts/${this.artifactId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const created = (await res.json()) as Comment;
        await this.load();
        return created;
      }
    } catch {
      /* ignore */
    } finally {
      this.busy = false;
    }
    return null;
  }

  async remove(id: string): Promise<boolean> {
    this.busy = true;
    try {
      const res = await fetch(`/api/artifacts/${this.artifactId}/comments/${id}?v=${this.version}`, {
        method: "DELETE",
      });
      if (res.ok || res.status === 404) {
        if (this.openThreadId === id) this.openThreadId = null;
        await this.load();
        return true;
      }
    } catch {
      /* ignore */
    } finally {
      this.busy = false;
    }
    return false;
  }

  async toggleResolved(c: Comment): Promise<void> {
    this.busy = true;
    const payload: ResolveCommentRequest = { version: this.version, resolved: !c.resolved };
    try {
      const res = await fetch(`/api/artifacts/${this.artifactId}/comments/${c.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) await this.load();
    } catch {
      /* ignore */
    } finally {
      this.busy = false;
    }
  }
}
