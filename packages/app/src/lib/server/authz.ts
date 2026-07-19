import type { Artifact } from "@stela/shared";
import type { SessionUser } from "./auth";

/** The v1 three-tier authorization check. */
export function canView(artifact: Artifact, user: SessionUser): boolean {
  if (artifact.ownerId === user.id) return true;
  if (artifact.visibility === "everyone") return true; // any user signed in to this server
  if (artifact.visibility === "restricted") {
    const email = user.email.toLowerCase();
    const userId = user.id.toLowerCase();
    // User ids and emails are matched case-insensitively; an allow-list entry may differ in case
    // from the viewer's trusted-header values.
    return artifact.allowedPrincipals.some((p) => {
      const pl = p.toLowerCase();
      return pl === userId || pl === email;
    });
  }
  return false; // private and not the owner
}

export function canManage(artifact: Artifact, user: SessionUser): boolean {
  return artifact.ownerId === user.id;
}
