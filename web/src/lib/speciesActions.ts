import { api } from "./api";
import type { Species } from "./types";

/** Ask, check it has no photos, then remove a species you added. Returns true if removed. */
export async function confirmRemoveSpecies(sp: Species): Promise<boolean> {
  try {
    const u = await api.speciesUsage(sp.id);
    if (u.photos > 0) {
      alert(`${sp.name} has ${u.photos} photo${u.photos === 1 ? "" : "s"}, so it can't be removed. Delete those trips first if you really want it gone.`);
      return false;
    }
    const extra = u.catches ? `\n\nThis also removes ${u.catches} logged catch${u.catches === 1 ? "" : "es"} of it (no photos).` : "";
    if (!confirm(`Remove "${sp.name}" from your species?${extra}`)) return false;
    await api.removeSpecies(sp.id);
    return true;
  } catch (e) {
    alert(`Couldn't remove it — are you online? (${(e as Error).message})`);
    return false;
  }
}
