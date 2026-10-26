import { handle, json, readJsonObject } from "@/server/http";
import { requireAdmin } from "@/server/session";
import { getSettingStatuses, SettingsUpdateSchema, updateSettings } from "@/server/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{settings: RuntimeSetting[]}`; secrets only ever leave masked. */
export const GET = handle(async (request: Request) => {
  await requireAdmin(request);
  return json({ settings: await getSettingStatuses() });
});

/** `{updates, delete_keys, prefer_admin_values}` → `{settings}`. */
export const PATCH = handle(async (request: Request) => {
  const admin = await requireAdmin(request);
  const update = SettingsUpdateSchema.parse(await readJsonObject(request));
  return json({ settings: await updateSettings(update, admin.id) });
});
