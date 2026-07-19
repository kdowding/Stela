import type { PageServerLoad } from "./$types";
import { getStore } from "$lib/server/storage";

export const load: PageServerLoad = async ({ locals }) => {
  const user = locals.user;
  if (!user) return { mine: [], everyone: [], shared: [], storageError: false };

  const store = getStore();
  try {
    const [mine, everyoneAll, shared] = await Promise.all([
      store.listByOwner(user.id),
      store.listEveryone(),
      store.listSharedWith(user.id, user.email),
    ]);
    const everyone = everyoneAll.filter((a) => a.ownerId !== user.id);
    return { mine, everyone, shared, storageError: false };
  } catch (e) {
    // Don't leak internal storage errors to the client; log and show a generic notice.
    console.error("Gallery load failed:", e);
    return { mine: [], everyone: [], shared: [], storageError: true };
  }
};
